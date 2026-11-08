#!/usr/bin/env node
// Checks this repository's PWA layer against a built site; run it after pwa/apply.py.
//   node pwa/test-pwa.mjs [DIST]      (default: dist/web; needs python3 for the re-apply)
//
// The static half verifies what apply.py put into DIST: the manifest (valid JSON, its
// icons on disk and of the declared size) and the links, theme colour and service-worker
// registration injected into index.html. The behavioural half runs sw.js in a mock
// service-worker environment — node's own URL and Response, a fake Cache Storage, and a
// fetch that serves DIST from disk or rejects to simulate being offline — and drives it
// through activation, the warm-up message and fetch events: the warm-up caches the
// current build and prunes the previous one, an incomplete new build changes nothing,
// navigations answer from the cache offline, build assets are served without touching
// the network, named files are fetched network-first, and anything that is not this
// site's own GET is left to the browser.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
  // What a previous build's warm-up left behind: its hashed files, gone from the server
  // with the build that named them, and a small unhashed file that must survive.
  await cache.put(new URL("pdfcraft-web-0123456789abcdef.js", SCOPE).href, new Response("old js", { status: 200 }));
  await cache.put(new URL("pdfcraft-web-0123456789abcdef_bg.wasm", SCOPE).href, new Response("old wasm", { status: 200 }));
  await cache.put(new URL("notes.txt", SCOPE).href, new Response("notes", { status: 200 }));
  await worker.dispatch("message", { data: "warm-up" }).promise;

  const keys = (await cache.keys()).map((request) => request.url);
  // Everything the page loads: link targets plus the names quoted in the bootstrap script.
  const referenced = new Set([SHELL]);
  for (const match of index.matchAll(/(?:href|src)="([^"]+)"/g)) referenced.add(new URL(match[1], SHELL).href);
  for (const match of index.matchAll(/'([^']+\.(?:js|wasm))'/g)) referenced.add(new URL(match[1], SHELL).href);
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

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exitCode = failures ? 1 : 0;
