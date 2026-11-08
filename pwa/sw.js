// The service worker of the PdfCraft wasm site this repository publishes
// (https://sloth-os.github.io/pdfcraft/). Upstream's web build is a folder of static files
// whose asset names carry a content hash, served by GitHub Pages with `Cache-Control:
// max-age=600` — and every build renames them anyway — so out of the box the app
// redownloads its ~60 MB wasm on every visit once the HTTP cache has gone stale. This
// worker adds what upstream's packaging does not:
//
//   * offline use: the files the page loads are kept in Cache Storage; a navigation to the
//     app answers from there when the network is gone;
//   * instant repeat loads: build assets are served cache-first; a new build is fetched in
//     the background once the running app has started, and takes over on the next visit.
//
// Nothing is precached from a list — the names change with every build. Instead the page
// asks for a "warm-up" (the sender is injected into index.html by pwa/apply.py) once the
// wasm has been fetched and started; the worker then reads a fresh index.html and copies
// this build's files — the page, its scripts, the wasm, the manifest and the icons — into
// the cache. Only when every one of them is in does the new page replace the cached one
// and the previous build's hashed files get pruned, so the cache stays one build deep and
// whatever page it holds always boots. Running after the page's own downloads means the
// warm-up's refetches are served by the browser's HTTP cache, not the network.
//
// Named files — the manifest, the icons, the licence files, BUILD.txt — keep their names
// across builds and can change under them, so they are fetched network-first with the
// cached copy as the offline fallback, and never pruned.

const CACHE = "pdfcraft-v1";
const SCOPE = self.registration.scope; // .../pdfcraft/, with the trailing slash
const SHELL = new URL("index.html", SCOPE).href;
const SCOPE_PATH = new URL(SCOPE).pathname; // "/pdfcraft/"
const SHELL_PATH = new URL(SHELL).pathname; // "/pdfcraft/index.html"
const MANIFEST_URL = new URL("manifest.webmanifest", SCOPE).href;

// Trunk and wasm-bindgen hash every build artifact's name — pdfcraft-web-<hash>.js,
// pdfcraft-web-<hash>_bg.wasm, snippets/<crate>-<hash>/inline0.js. A name changes with
// each build; the content behind a name never does, so those files are served cache-first
// and pruned with their build.
const BUILD_ASSET = /(?:^|\/)pdfcraft-web-[0-9a-f]{8,}(?:_[a-z0-9]+)*\.(?:js|wasm)$|\/snippets\/.+\.js$/;
// This layer's own files, which keep their names across builds and can change under them:
// network-first, never pruned. Keep in step with manifest.webmanifest and apply.py.
const LAYER_FILE = /(?:^|\/)(?:manifest\.webmanifest|icon-(?:32|192|512)\.png|icon-maskable-512\.png|apple-touch-icon\.png)$/;

self.addEventListener("install", () => {
  // No precache list to install (see above); the warm-up fills the cache after the page
  // has loaded its files. The cache only ever holds build assets or freshly fetched
  // files, so a new worker version can take over a running page without breaking it.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Claim the page that registered us, so its remaining loads are cached as they
      // happen. A future version of this worker may rename CACHE; drop the old one.
      await self.clients.claim();
      for (const key of await caches.keys()) {
        if (key !== CACHE) await caches.delete(key);
      }
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "warm-up") event.waitUntil(warmUp());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  // This site's files only. The app fetches ?file= documents from anywhere — cross-origin
  // ones (and anything else outside the scope) are none of this worker's business.
  if (!request.url.startsWith(SCOPE)) return;
  const path = new URL(request.url).pathname;

  if (request.mode === "navigate") {
    // Only the app page itself: the scope root or index.html — the query (?file=, ?webgl,
    // ?cpu) never changes which file serves it.
    if (path === SCOPE_PATH || path === SHELL_PATH) event.respondWith(shell(request, event));
    return; // a navigation to anything else (BUILD.txt, a licence file) is a plain file
  }
  // Only the files this layer knows it may cache. Everything else under the scope — the
  // licence files, BUILD.txt, a same-origin document a ?file= URL points at — is fetched
  // by the browser itself; caching user documents would grow the cache without bound.
  if (BUILD_ASSET.test(path) || LAYER_FILE.test(path)) event.respondWith(assets(request));
});

// The app page: serve the cached copy at once, refresh it in the background.
async function shell(request, event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(SHELL);
  // A reload — F5 sends cache "reload", a hard reload "no-store" — explicitly asks for the
  // network copy: fetch it fresh instead of serving the cache, and let it replace the
  // cached page. Offline it falls back to the cached app rather than the browser's error
  // page; without a cached copy the error rethrows.
  if (request.cache === "reload" || request.cache === "no-store") {
    try {
      const response = await fetch(request);
      if (response.ok) cache.put(SHELL, response.clone());
      return response;
    } catch (error) {
      if (cached) return cached;
      throw error;
    }
  }
  if (cached) {
    // Refresh behind the scenes; waitUntil keeps the worker alive for it. A failed
    // revalidation (offline, broken deploy) leaves the cached page in place.
    event.waitUntil(
      fetch(request)
        .then((response) => (response.ok ? cache.put(SHELL, response.clone()) : undefined))
        .catch(() => {}),
    );
    return cached;
  }
  // First visit: pass the network's answer through, caching it if it is a page.
  const response = await fetch(request);
  if (response.ok) cache.put(SHELL, response.clone());
  return response;
}

// A file this layer keeps: a build asset's name carries its content's hash, so it is
// served cache-first, forever; a layer file can change under its name, so it is fetched
// network-first, with the cached copy as the offline fallback.
async function assets(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached && BUILD_ASSET.test(new URL(request.url).pathname)) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    if (cached) return cached; // a named file, offline: the last fetched copy answers
    throw error; // nothing cached and offline: let the browser report the failed load
  }
}

// Copy this build's files into the cache: read a fresh index.html, fetch every local file
// it references — and the manifest, whose JSON names this layer's icons — and only once
// all of them are cached let the new page replace the cached one and the previous build's
// hashed files go.
async function warmUp() {
  const cache = await caches.open(CACHE);
  // `cache: "reload"` bypasses the browser's HTTP cache: this one request must see the
  // server, because its answer decides which build is current. Offline it throws — then
  // the cache already holds whatever the last online visit put there, and there is
  // nothing to do.
  let shell;
  try {
    shell = await fetch(SHELL, { cache: "reload" });
  } catch (error) {
    return;
  }
  if (!shell.ok) return; // a failed deploy must not disturb the working build
  const page = shell.clone();
  const html = await shell.text();

  // Everything the page loads. Trunk emits the hashed js/wasm/snippet names as link
  // attributes; this layer's own links carry the manifest and icons. The bootstrap script
  // also quotes the same names inside JavaScript strings — pick those up too, so a change
  // in Trunk's markup doesn't silently drop the wasm.
  const referenced = new Set([SHELL]);
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    referenced.add(new URL(match[1], SHELL).href);
  }
  for (const match of html.matchAll(/'([^']+\.(?:js|wasm))'/g)) {
    referenced.add(new URL(match[1], SHELL).href);
  }

  // Fill the gaps — through the page's HTTP cache, which holds everything it just
  // downloaded. Build assets already stored are skipped: their content cannot have
  // changed. A file that cannot be fetched marks the fill incomplete.
  let complete = true;
  for (const url of referenced) {
    if (url === SHELL) continue; // the page itself is held back until the fill is complete
    if (BUILD_ASSET.test(new URL(url).pathname) && (await cache.match(url))) continue;
    try {
      const response = await fetch(url);
      if (response.ok) {
        // The manifest names this layer's icons in JSON, not in the page's HTML; queue
        // them too, so an offline install finds everything it needs. Adding to the set
        // being iterated is well-defined — the new entries are visited in this same pass.
        let manifestText = null;
        if (url === MANIFEST_URL) manifestText = await response.clone().text();
        await cache.put(url, response);
        if (manifestText !== null) {
          try {
            for (const icon of JSON.parse(manifestText).icons ?? []) {
              referenced.add(new URL(icon.src, SCOPE).href);
            }
          } catch (error) {
            // A manifest that is not valid JSON must not fail the warm-up; the icons are
            // a convenience, the app boots without them.
          }
        }
      } else {
        complete = false;
      }
    } catch (error) {
      complete = false;
    }
  }
  if (!complete) return; // the working build stays; the next visit's warm-up retries

  // Every file of this build is cached: its page can replace the cached one, and the
  // previous build's hashed files can go — the cache stays one build (~60 MB) deep.
  await cache.put(SHELL, page);
  for (const request of await cache.keys()) {
    if (BUILD_ASSET.test(new URL(request.url).pathname) && !referenced.has(request.url)) {
      await cache.delete(request);
    }
  }
}
