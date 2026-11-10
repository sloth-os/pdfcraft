#!/usr/bin/env node
// Checks this repository's PWA layer against a built site; run it after pwa/apply.py.
//   node pwa/test-pwa.mjs [DIST]      (default: dist/web; needs python3 for the re-apply)
//
// The static half verifies what the build and apply.py put into DIST: the manifest (valid
// JSON, its icons on disk and of the declared size, its file handler), the links, theme
// colour and service-worker registration injected into index.html, the OCR worker's file
// chain (a <meta> in index.html names its loader; the chain must resolve to the worker's
// wasm) and the OCR models staged under models/. The behavioural half runs sw.js in a mock
// service-worker environment — node's own URL and Response, a fake Cache Storage, and a
// fetch that serves DIST from disk or rejects to simulate being offline — and drives it
// through activation, the warm-up message and fetch events: the warm-up caches the
// current build (the OCR worker's chain included) and prunes the previous one, an
// incomplete new build changes nothing, the warm-up leaves the OCR models uncached,
// navigations answer from the cache offline, build assets are served without touching
// the network, named files (an OCR model among them) are fetched network-first, and
// anything that is not this site's own GET is left to the browser. It also runs the
// injected launchQueue consumer in a mock page: the files the OS launches into the
// installed app must wait for the canvas and the app's drop listener, then arrive as a
// drop on the canvas — once — and a file that cannot be read must not lose the others.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

const dist = path.resolve(process.argv[2] ?? "dist/web");
const pwa = path.dirname(new URL(import.meta.url).pathname);
const sw = readFileSync(path.join(pwa, "sw.js"), "utf8");
const index = readFileSync(path.join(dist, "index.html"), "utf8");
const manifestText = readFileSync(path.join(dist, "manifest.webmanifest"), "utf8");

// The production scope; the worker derives everything it stores from its own registration.
const SCOPE = "https://sloth-os.github.io/pdfcraft/";
const SHELL = new URL("index.html", SCOPE).href;
const CACHE = "pdfcraft-v1";

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

// --- what apply.py put into the site -----------------------------------------------

check(/<link rel="manifest" href="manifest\.webmanifest"/.test(index), "index.html links the manifest");
check(/<link rel="icon"[^>]*icon-32\.png/.test(index), "index.html links the favicon");
check(/<link rel="apple-touch-icon" href="apple-touch-icon\.png"/.test(index), "index.html links the iOS icon");
check(/<meta name="theme-color" content="#b70228"/.test(index), "index.html sets the theme colour");
check(index.includes('navigator.serviceWorker.register("./sw.js")'), "index.html registers the service worker");
check(index.includes("TrunkApplicationStarted"), "the warm-up is asked for once the app has started");
check(!/(?:src|href)="\/[^/]/.test(index), "index.html keeps relative URLs (the /pdfcraft/ path guard)");

let manifest;
try {
  manifest = JSON.parse(manifestText);
  check(true, "the manifest is valid JSON");
} catch (error) {
  check(false, `the manifest is valid JSON (${error.message})`);
  manifest = { icons: [] };
}
check(
  manifest.name === "PdfCraft" && manifest.start_url === "./" && manifest.display === "standalone",
  "the manifest is the expected app manifest",
);
check(manifest.theme_color === "#b70228", "the manifest's theme colour is the app colour");

// OS file handling: the manifest's file_handlers register the installed app as an OS-level
// PDF handler. The handler's action must be the app page itself — the consumer that takes
// the launch lives only there — and in scope, like every other URL the layer adds.
const handlers = manifest.file_handlers ?? [];
check(Array.isArray(handlers) && handlers.length === 1, "the manifest registers the app as a file handler");
for (const handler of handlers) {
  const action = new URL(handler.action, SCOPE);
  check(
    action.href === SCOPE || action.href === SHELL,
    `the file handler's action (${handler.action}) is the app page itself`,
  );
  const pdf = handler.accept?.["application/pdf"];
  check(
    Array.isArray(pdf) && pdf.includes(".pdf"),
    "the file handler accepts application/pdf (.pdf)",
  );
}
check(
  manifest.launch_handler?.client_mode === "focus-existing",
  "a launch focuses the running app rather than opening a second one",
);

// The manifest's icons must exist and be the size they declare — a wrong size is the
// classic silent installability failure. PNG sizes sit in the IHDR chunk.
const pngSize = (file) => {
  const bytes = readFileSync(file);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};
for (const icon of manifest.icons) {
  check(existsSync(path.join(dist, icon.src)), `the manifest's ${icon.src} is on disk`);
  const size = pngSize(path.join(dist, icon.src)).join("x");
  check(size === icon.sizes, `the manifest's ${icon.src} is ${icon.sizes} (${size})`);
}
check(pngSize(path.join(dist, "apple-touch-icon.png")).join("x") === "180x180", "apple-touch-icon.png is 180x180");
for (const name of ["sw.js", "icon-32.png", "apple-touch-icon.png"]) {
  check(existsSync(path.join(dist, name)), `${name} ships with the site`);
}
const hashed = [...index.matchAll(/(?:href|src)="([^"]+)"/g)]
  .map((match) => match[1])
  .filter((url) => /pdfcraft-web-|snippets\//.test(url));
check(hashed.length >= 3, `index.html references the build's hashed assets (${hashed.length} seen)`);
for (const url of hashed) {
  check(existsSync(path.join(dist, url)), `the build's ${url} is on disk`);
}

// v0.20.0's OCR worker is named in a chain, not in the page's links: a <meta> names the
// worker's loader, whose script quotes the glue, whose script quotes the wasm (upstream's
// build hook writes those names into the files it hashes). sw.js walks the same chain at
// warm-up; this is the reference walk.
const distPath = (link) =>
  decodeURIComponent(new URL(link).pathname.slice(new URL(SCOPE).pathname.length));
const chain = (() => {
  const meta = index.match(/<meta(?=[^>]*name="pdfcraft-ocr-worker")[^>]*content="([^"]+)"/);
  if (!meta) return null;
  const links = [];
  let link = new URL(meta[1], SHELL).href;
  while (link && !link.endsWith(".wasm")) {
    links.push(link);
    const file = path.join(dist, distPath(link));
    if (!existsSync(file)) return null;
    const quoted = readFileSync(file, "utf8").match(/'([^']+\.(?:js|wasm))'/);
    if (!quoted) return null;
    link = new URL(quoted[1], SHELL).href;
  }
  links.push(link);
  return links;
})();
check(chain !== null, "index.html names the OCR worker in a chain that resolves to its wasm");
if (chain) {
  check(chain.length === 3, `the OCR worker's chain is loader → glue → wasm (${chain.length} links)`);
  for (const link of chain) {
    check(existsSync(path.join(dist, distPath(link))), `the OCR worker's ${distPath(link)} is on disk`);
  }
}

// The OCR models the page downloads on first use of Scan & OCR, staged under models/ by
// the workflow the way upstream's own web packaging stages them. Checked by shape, not by
// name: upstream's ATTRIBUTION.toml names the models, and they change with its releases.
const models = existsSync(path.join(dist, "models"))
  ? readdirSync(path.join(dist, "models"))
  : [];
const onnx = models.filter((name) => name.endsWith(".onnx"));
check(onnx.length >= 1, `models/ stages the OCR models (${onnx.length} onnx seen)`);
check(models.includes("ATTRIBUTION.txt"), "models/ATTRIBUTION.txt ships with the models");
for (const name of onnx) {
  check(models.includes(`${name}.LICENCE.txt`), `models/${name}.LICENCE.txt ships with it`);
}

// apply.py is idempotent: a second run must rewrite exactly the same page.
const before = readFileSync(path.join(dist, "index.html"));
try {
  execFileSync("python3", [path.join(pwa, "apply.py"), dist]);
  check(before.equals(readFileSync(path.join(dist, "index.html"))), "apply.py is idempotent (a second run changes nothing)");
} catch (error) {
  check(false, `apply.py is idempotent (${error.message})`);
}

// --- sw.js in a mock service-worker environment -------------------------------------

// The "server": DIST on disk, as Pages serves it.
const distServer = (url) => {
  const rel = decodeURIComponent(new URL(url).pathname.slice(new URL(SCOPE).pathname.length));
  const file = path.join(dist, rel === "" ? "index.html" : rel);
  if (!existsSync(file)) return new Response(`no ${rel} on disk`, { status: 404 });
  return new Response(readFileSync(file), { status: 200 });
};

function makeWorker({ offline = false } = {}) {
  const net = { offline, handler: distServer };
  const listeners = new Map();
  const stores = new Map(); // cache name -> Map(url -> Response)
  const fetchLog = [];
  const self = {
    registration: { scope: SCOPE },
    skipWaiting() {},
    clients: { async claim() {} },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
  };
  const url = (request) => (typeof request === "string" ? request : request.url);
  const api = (store) => ({
    async match(request) {
      return store.get(url(request)) ?? null;
    },
    async put(request, response) {
      store.set(url(request), response);
    },
    async keys() {
      return [...store.keys()].map((key) => ({ url: key, method: "GET" }));
    },
    async delete(request) {
      return store.delete(url(request));
    },
  });
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      return api(stores.get(name));
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
  };
  async function fetch(input) {
    const target = url(input);
    fetchLog.push(target);
    if (net.offline) throw new TypeError("simulated offline");
    return net.handler(target);
  }
  vm.runInNewContext(sw, { self, caches, fetch, URL });
  const dispatch = (type, event = {}) => {
    let promise = null;
    let response = null;
    const wrapped = { ...event, waitUntil(p) { promise = p; }, respondWith(p) { response = p; } };
    for (const handler of listeners.get(type) ?? []) handler(wrapped);
    return { promise, response };
  };
  return { net, stores, caches, fetchLog, dispatch };
}

// Activation keeps only the current cache.
{
  const worker = makeWorker();
  await worker.caches.open("pdfcraft-v0"); // the cache name of an earlier worker version
  await (await worker.caches.open(CACHE)).put(SHELL, new Response("stale", { status: 200 }));
  await worker.dispatch("activate").promise;
  const names = await worker.caches.keys();
  check(names.includes(CACHE) && !names.includes("pdfcraft-v0"), "activation drops caches of earlier worker versions");
}

// The warm-up caches the current build and prunes the previous one.
{
  const worker = makeWorker();
  const cache = await worker.caches.open(CACHE);
  // What a previous build's warm-up left behind: its hashed files — the app's and the OCR
  // worker's — gone from the server with the build that named them, and a small unhashed
  // file that must survive.
  await cache.put(new URL("pdfcraft-web-0123456789abcdef.js", SCOPE).href, new Response("old js", { status: 200 }));
  await cache.put(new URL("pdfcraft-web-0123456789abcdef_bg.wasm", SCOPE).href, new Response("old wasm", { status: 200 }));
  await cache.put(new URL("pdfcraft-ocr-worker-0123456789abcdef.js", SCOPE).href, new Response("old worker glue", { status: 200 }));
  await cache.put(new URL("pdfcraft-ocr-worker-0123456789abcdef_bg.wasm", SCOPE).href, new Response("old worker wasm", { status: 200 }));
  await cache.put(new URL("notes.txt", SCOPE).href, new Response("notes", { status: 200 }));
  await worker.dispatch("message", { data: "warm-up" }).promise;

  const keys = (await cache.keys()).map((request) => request.url);
  // Everything the page loads: link targets, the names quoted in the bootstrap script, and
  // the OCR worker's chain out of its <meta>.
  const referenced = new Set([SHELL]);
  for (const match of index.matchAll(/(?:href|src)="([^"]+)"/g)) referenced.add(new URL(match[1], SHELL).href);
  for (const match of index.matchAll(/'([^']+\.(?:js|wasm))'/g)) referenced.add(new URL(match[1], SHELL).href);
  if (chain) for (const link of chain) referenced.add(link);
  for (const target of referenced) {
    check(keys.includes(target), `the warm-up cached ${new URL(target).pathname}`);
  }
  // The manifest names its icons in JSON, not in the page's HTML; the warm-up queues them.
  for (const icon of ["icon-192.png", "icon-512.png", "icon-maskable-512.png"]) {
    check(keys.includes(new URL(icon, SCOPE).href), `the warm-up cached ${icon} (named by the manifest)`);
  }
  check(
    !keys.some((key) => key.includes("0123456789abcdef")),
    "the warm-up pruned the previous build's hashed files",
  );
  check(keys.includes(new URL("notes.txt", SCOPE).href), "an unhashed file is never pruned");
  check(
    !worker.fetchLog.some((target) => new URL(target).pathname.includes("/models/")),
    "the warm-up leaves the OCR models uncached (the page fetches them on first use)",
  );
}

// A new build whose files cannot all be fetched changes nothing; once complete, it
// replaces the previous build and prunes its hashed files.
{
  const worker = makeWorker();
  await worker.dispatch("message", { data: "warm-up" }).promise;
  const cache = await worker.caches.open(CACHE);

  // A new build: same page, new hashes. Its wasm is missing from the server at first (a
  // broken or still-uploading deploy).
  const hash = index.match(/pdfcraft-web-([0-9a-f]+)\.js/)[1];
  const alt = "a".repeat(hash.length);
  const newIndex = index.replaceAll(hash, alt);
  const oldJs = new URL(`pdfcraft-web-${hash}.js`, SCOPE).href;
  const newJs = new URL(`pdfcraft-web-${alt}.js`, SCOPE).href;
  worker.net.handler = (requested) =>
    requested.endsWith(`pdfcraft-web-${alt}_bg.wasm`)
      ? new Response("gone", { status: 404 })
      : requested === SHELL
        ? new Response(newIndex, { status: 200 })
        : requested.includes(alt)
          ? new Response("new build file", { status: 200 })
          : distServer(requested);
  await worker.dispatch("message", { data: "warm-up" }).promise;
  let keys = (await cache.keys()).map((request) => request.url);
  check(keys.includes(oldJs), "an incomplete new build keeps the previous build's files");
  check(
    !(await (await cache.match(SHELL)).text()).includes(alt),
    "and its page — the incomplete new build is not served",
  );

  // The deploy completes; the next warm-up swaps the builds.
  worker.net.handler = (requested) =>
    requested === SHELL
      ? new Response(newIndex, { status: 200 })
      : requested.includes(alt)
        ? new Response("new build file", { status: 200 })
        : distServer(requested);
  await worker.dispatch("message", { data: "warm-up" }).promise;
  keys = (await cache.keys()).map((request) => request.url);
  check((await (await cache.match(SHELL)).text()).includes(alt), "a complete new build replaces the cached page");
  check(keys.includes(newJs) && !keys.includes(oldJs), "and prunes the previous build's hashed files");
}

// Offline: a navigation — ?file= and all — answers from the cache.
{
  const worker = makeWorker();
  await worker.dispatch("message", { data: "warm-up" }).promise;
  worker.net.offline = true;
  const { response } = worker.dispatch("fetch", {
    request: { url: new URL("?file=x", SCOPE).href, method: "GET", mode: "navigate" },
  });
  const served = await response;
  check(
    served?.status === 200 && (await served.clone().text()).includes("pdfcraft"),
    "an offline navigation is served from the cache",
  );
}

// Offline: a cached build asset is served without a network attempt.
{
  const worker = makeWorker();
  await worker.dispatch("message", { data: "warm-up" }).promise;
  const wasm = [...index.matchAll(/'([^']+_bg\.wasm)'/g)][0][1];
  const before = worker.fetchLog.length;
  worker.net.offline = true;
  const { response } = worker.dispatch("fetch", {
    request: { url: new URL(wasm, SCOPE).href, method: "GET", mode: "same-origin" },
  });
  const served = await response;
  check(
    served?.status === 200 && worker.fetchLog.length === before,
    "a cached build asset is served without the network",
  );
}

// A named file (the manifest) is fetched network-first; offline, the cached copy answers.
{
  const worker = makeWorker();
  await worker.dispatch("message", { data: "warm-up" }).promise;
  const manifestUrl = new URL("manifest.webmanifest", SCOPE).href;
  worker.net.handler = (requested) =>
    requested === manifestUrl
      ? new Response('{"name":"PdfCraft","changed":true}', { status: 200 })
      : distServer(requested);
  const fresh = await worker.dispatch("fetch", {
    request: { url: manifestUrl, method: "GET", mode: "same-origin" },
  }).response;
  check((await fresh.clone().text()).includes('"changed"'), "a named file is served network-first (fresh when online)");
  worker.net.offline = true;
  const stale = await worker.dispatch("fetch", {
    request: { url: manifestUrl, method: "GET", mode: "same-origin" },
  }).response;
  check(
    (await stale.clone().text()).includes('"changed"'),
    "offline, the last fetched copy of a named file answers",
  );
}

// An OCR model is a named file too — network-first, offline fallback — so the model the
// page fetches on first use of Scan & OCR keeps answering once the network is gone.
if (onnx.length > 0) {
  const worker = makeWorker();
  await worker.dispatch("message", { data: "warm-up" }).promise;
  const modelUrl = new URL(`models/${onnx[0]}`, SCOPE).href;
  worker.net.handler = (requested) =>
    requested === modelUrl
      ? new Response("model, changed", { status: 200 })
      : distServer(requested);
  const fresh = await worker.dispatch("fetch", {
    request: { url: modelUrl, method: "GET", mode: "same-origin" },
  }).response;
  check((await fresh.clone().text()).includes("changed"), "an OCR model is served network-first (fresh when online)");
  worker.net.offline = true;
  const stale = await worker.dispatch("fetch", {
    request: { url: modelUrl, method: "GET", mode: "same-origin" },
  }).response;
  check(
    (await stale.clone().text()).includes("changed"),
    "offline, the last fetched copy of a model answers",
  );
}

// A hard reload goes to the network, and what it brings back replaces the cached page.
{
  const worker = makeWorker();
  await worker.dispatch("message", { data: "warm-up" }).promise;
  worker.net.handler = () => new Response("<!doctype html>fresh", { status: 200 });
  const served = await worker.dispatch("fetch", {
    request: { url: SHELL, method: "GET", mode: "navigate", cache: "reload" },
  }).response;
  check((await served.clone().text()).includes("fresh"), "a hard-reload navigation is served from the network");
  worker.net.offline = true;
  const again = await worker.dispatch("fetch", {
    request: { url: SHELL, method: "GET", mode: "navigate" },
  }).response;
  check((await again.clone().text()).includes("fresh"), "the reloaded page replaced the cached one");
}

// Offline with nothing cached: the navigation fails loudly — the browser's own error, not
// an empty page.
{
  const worker = makeWorker({ offline: true });
  const { response } = worker.dispatch("fetch", {
    request: { url: SCOPE, method: "GET", mode: "navigate" },
  });
  let rejected = false;
  try {
    await response;
  } catch {
    rejected = true;
  }
  check(rejected, "an offline first visit fails loudly instead of serving an empty page");
}

// Anything that is not one of this site's app files is left to the browser.
{
  const worker = makeWorker();
  await worker.dispatch("message", { data: "warm-up" }).promise;
  const bypass = [
    ["cross-origin", { url: "https://example.com/x.pdf", method: "GET", mode: "no-cors" }],
    ["non-GET", { url: SHELL, method: "POST", mode: "same-origin" }],
    ["plain-file navigation", { url: new URL("BUILD.txt", SCOPE).href, method: "GET", mode: "navigate" }],
    ["a licence file", { url: new URL("LICENSE-MIT", SCOPE).href, method: "GET", mode: "same-origin" }],
    ["a same-origin ?file= document", { url: new URL("doc.pdf", SCOPE).href, method: "GET", mode: "same-origin" }],
  ].map(([label, request]) => [label, worker.dispatch("fetch", { request })]);
  check(
    bypass.every(([, result]) => result.response === null),
    "cross-origin, non-GET and app-foreign files bypass the worker entirely",
  );
}

// --- the launchQueue consumer in a mock page ----------------------------------------
//
// File handling runs in the page, not the worker: the manifest's file_handlers name the
// app an OS-level PDF handler, and apply.py injects a consumer that hands the launched
// files to the app's own drop listener on the canvas. The hard part is timing — a file
// launch starts the app, so the files are in hand before the canvas exists and long
// before the wasm installs its listener — and the consumer's answer is the DOM's own
// handshake: the app's listener cancels every drop it takes, so an uncancelled dispatch
// means it isn't listening yet. The mock page steps the retries one at a time.
{
  const block = index.match(/<!-- pwa:begin[\s\S]*?pwa:end -->/)?.[0] ?? "";
  const scripts = [...block.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const consumerScript = scripts.find((script) => script.includes("launchQueue.setConsumer"));
  check(consumerScript !== undefined, "index.html injects the launchQueue consumer");

  if (consumerScript) {
    // A page before and after its load: no canvas while<head> parses, no drop listener
    // until the wasm has started. dispatchEvent returns whether the event was cancelled —
    // the app's listener cancels (preventDefault) every drop it takes.
    const makePage = () => {
      const dispatches = []; // every drop dispatched at the canvas
      const drops = []; // the drops the app's listener took
      const timeouts = []; // pending retries
      const errors = []; // console.error calls
      const canvas = {
        dispatchEvent(event) {
          dispatches.push(event);
          if (listener) listener(event);
          return !event.defaultPrevented;
        },
      };
      let listener = null; // the app's drop listener; null until the wasm is up
      let parsed = false; // the<body> with the canvas in it
      const sandbox = {
        window: {
          launchQueue: {
            consumer: null,
            setConsumer(consumer) {
              this.consumer = consumer;
            },
          },
        },
        document: { getElementById: (id) => (id === "pdfcraft" && parsed ? canvas : null) },
        DataTransfer: class {
          constructor() {
            this.items = { list: [], add(file) { this.list.push(file); } };
          }
        },
        DragEvent: class {
          constructor(type, init = {}) {
            this.type = type;
            this.cancelable = init.cancelable ?? false;
            this.dataTransfer = init.dataTransfer ?? null;
            this.defaultPrevented = false;
          }
          preventDefault() {
            this.defaultPrevented = true;
          }
        },
        console: { error: (...args) => errors.push(args) },
        setTimeout: (fn) => timeouts.push(fn),
      };
      sandbox.launchQueue = sandbox.window.launchQueue; // a bare global, as in the page
      vm.runInNewContext(consumerScript, sandbox);
      return {
        sandbox,
        dispatches,
        drops,
        timeouts,
        errors,
        parseBody: () => (parsed = true),
        appUp: () => (listener = (event) => { event.preventDefault(); drops.push(event); }),
        step: () => timeouts.shift()?.(),
      };
    };

    // A cold-start launch: the consumer fires before the canvas exists, retries while the
    // page parses and the wasm boots, and delivers once the app's listener is there. One
    // of the launched files can't be read (moved or deleted since the launch).
    {
      const page = makePage();
      const handles = [
        { getFile: async () => ({ name: "launched.pdf" }) },
        { getFile: async () => { throw new Error("the file is gone"); } },
        { getFile: async () => ({ name: "second.pdf" }) },
      ];
      await page.sandbox.launchQueue.consumer({ files: handles });
      check(page.dispatches.length === 0 && page.timeouts.length === 1,
        "a launch while the page is still parsing waits for the canvas");
      page.parseBody();
      page.step();
      page.step();
      check(page.dispatches.length === 2 && page.drops.length === 0 && page.timeouts.length === 1,
        "the consumer retries while the app's drop listener isn't installed");
      page.appUp();
      page.step();
      check(page.drops.length === 1 && page.timeouts.length === 0,
        "the launched files arrive as one drop, and delivery ends with it");
      const drop = page.drops[0];
      check(drop.type === "drop" && drop.cancelable === true, "the delivery is a cancelable drop event");
      check(
        drop.dataTransfer.items.list.map((file) => file.name).join(",") === "launched.pdf,second.pdf",
        "the drop carries the readable launched files, in launch order",
      );
      check(page.errors.length === 1, "a launched file that can't be read is reported and skipped");

      // A second launch, the app running: delivered at once, no retry.
      await page.sandbox.launchQueue.consumer({ files: [{ getFile: async () => ({ name: "later.pdf" }) }] });
      check(
        page.drops.length === 2 && page.dispatches.length === 4 && page.timeouts.length === 0,
        "a later launch, with the app already up, delivers at once",
      );
    }
  }
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exitCode = failures ? 1 : 0;
