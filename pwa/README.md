# The PWA layer

What this repository adds to upstream's build beyond building it: installability, offline
use, and OS file handling. Upstream's `apps/pdfcraft-web` build is a folder of static files
with no manifest, no icons and no service worker — a browser tab that redownloads its ~79 MB
wasm once Pages' ten-minute cache has gone stale (every build renames the files anyway), and
that is all it is. The publishing workflow applies this layer on top, and the site becomes
something that installs to the home screen, loads instantly on repeat visits, works on a
plane, and — once installed — opens PDFs from the OS's file manager in its own window.

| file | |
|---|---|
| `manifest.webmanifest` | the web app manifest: name, icons, standalone display, the app colour, and the registration as an OS PDF handler |
| `sw.js` | the service worker — the offline cache; its header comment is the design document |
| `apply.py` | copies the layer into a built `dist/` and injects links, the worker registration and the file-launch consumer into `index.html` |
| `test-pwa.mjs` | checks the applied layer, then drives `sw.js` through a mock service-worker environment and the launch consumer through a mock page |
| `icon-32.png` … `apple-touch-icon.png` | the icons, derived from upstream's own app icon (below) |

The manifest's `id`, `start_url`, `scope` — and its file handler's `action` — are all `"./"`,
so they stay correct under the `/pdfcraft/` path Pages serves the site from; like every other
URL the layer adds, they are relative. A layer file that is renamed or added must be updated
in step everywhere it is named: `manifest.webmanifest`, `apply.py` (`FILES` and `BLOCK`),
`sw.js` (`LAYER_FILE`) and `test-pwa.mjs`.

## The icons

PdfCraft has its own app icon — upstream's `assets/app-icon/` — so the site uses that, not a
hand-drawn substitute. Each file comes from the nearest of the sizes upstream renders into its
`hicolor/` tree (with `packaging/icons.sh`), resampling only when upstream has no exact size:

- `icon-512.png` — upstream's 512×512 render, as is;
- `icon-192.png` — its 256×256 render, resampled to 192 with Lanczos;
- `icon-32.png` — upstream's 32×32 render (a downscale of the 512 would blur at that size);
- `icon-maskable-512.png` — the 512 render alpha-composited onto a solid `#b70228` square:
  Android's adaptive launchers crop a *maskable* icon to a mask of their own, so the artwork
  must bleed to the edges instead of sitting in a rounded square with transparent corners;
- `apple-touch-icon.png` — the 256 render at iOS's 180×180, flattened to opaque, since iOS
  composites its own corners over transparent icons.

The theme colour `#b70228` is the documented app colour of that icon, and the background
colour `#f1f1f3` matches the page's own light-mode background. The icon is original artwork
by PdfCraft's project owner, licensed like the rest of PdfCraft (MIT OR Apache-2.0); the
workflow ships its licence file with the site as `LICENSE-app-icon.txt`.

## How the offline cache works

`sw.js` caches nothing from a list — the build's file names change with every build. Instead,
once the running app announces it has started (Trunk's `TrunkApplicationStarted` event; the
sender is injected into `index.html` by `apply.py`), the page asks the worker for a
*warm-up*: fetch a fresh `index.html`, copy every file it references — the OCR worker's chain
out to its wasm, plus the manifest, whose JSON names the icons — into Cache Storage, and only
once **all** of them are in, let the new page replace the cached one and prune the previous
build's hashed files. A partially fetched or broken deploy therefore never displaces a working
build, and the cache stays one build (~83 MB) deep. Running after the page's own downloads
means the warm-up's refetches come from the browser's HTTP cache, not the network — except
the OCR worker's, which the page loads only when Scan & OCR is first used.

The OCR worker (v0.20.0) is named in a chain, not in the page's links: a `<meta>` in
`index.html` names the worker's loader script, whose code names the worker's glue script,
whose code names the worker's wasm — upstream's build hook writes those names into the very
files it hashes. The warm-up walks that chain, and touches only the worker's own files:
scanning scripts at large would also pick up a fallback wasm name in the app's glue that
nothing ever fetches.

The OCR models under `models/` are named files (their names carry no hash, and they are
staged once per release), so they are fetched network-first and never pruned — but the
warm-up never fetches them. The page downloads a model on first use of Scan & OCR, and that
fetch fills the cache, so the ~12 MB is spent by the visitors who use the feature — and OCR
works offline for them from then on — rather than by every visitor on every warm-up.

At fetch time: navigations to the app page are served from the cache (offline use), with a
background refresh when online; hashed build assets are cache-first forever — their names
carry their content's hash; named files (the manifest, the icons, the OCR models) are
network-first with the cached copy as the offline fallback. Everything else — licence files,
`BUILD.txt`, a same-origin `?file=` document — bypasses the worker, so user documents never
grow the cache. `sw.js` documents all of this in its header comment.

## OS file handling

Once the app is installed, the OS's file manager can offer it for PDFs: *Open with* → PdfCraft,
a double-click after it is made the default, a drag onto its taskbar icon. Two manifest fields
declare that — `file_handlers` (the app is a handler for `application/pdf`, `.pdf`) and
`launch_handler: focus-existing` (a launch focuses the running instance instead of opening a
second one, so unsaved work survives an *Open with*) — and Chromium-family browsers show the
registration in `chrome://apps`. The handler's `action` is `"./"`, the app page itself: the
manifest cannot name a script, only a URL, and this app's delivery has to live in the page
anyway (below). A browser without `launchQueue` (Firefox, Safari) ignores both fields; the
site works exactly as before.

The delivery is the interesting half. When the OS launches the app with a file, the browser
loads the handler's page and hands it the file through `window.launchQueue` — as a
`FileSystemFileHandle`, not a URL and not bytes, so none of the app's existing entry points
can take it: `?file=<url>` needs a same-origin URL for the bytes (a `blob:` URL names the
document by its UUID instead of its file name), and the embedding host bridge
(`?host=parent` / `data-host="page"`) routes the app's **saves** into messages the launching
page would then have to answer itself — an installed app's saves must keep downloading. What
the app does have is its own runtime open path: a PDF dropped on the window opens as a
document tab, with the file's real name, through the drag-and-drop listener its UI installs
on the canvas. So the injected consumer (`apply.py`'s second script) reads the launched files
out of their handles and dispatches them to that listener as a synthetic, *cancelable*
`drop` event on the canvas. The app cannot tell the difference: it opens the PDF, names the
tab from the file, and reports its own errors — and a save still downloads.

The timing needs the one trick in the code. A file launch cold-starts the app, so the
consumer runs long before anything can take the files — before the `<body>` has even parsed
(the script sits in `<head>`, and the canvas comes with the body), and then for as long as
the wasm takes to fetch, compile and install its listeners (a fresh launch can be offline,
where the service worker serves the ~79 MB from cache, but it still takes a moment). The
consumer therefore retries every 250 ms — and knows when to stop by the DOM's own handshake:
the app's drop listener calls `preventDefault()` on every drop it takes, and
`dispatchEvent()` returns `false` exactly when someone did. An uncancelled dispatch means
nobody was listening yet; a cancelled one means the PDF was taken, and the retries end. A
file whose handle can no longer be read (moved or deleted since the launch) is skipped with
a console error, and a launch that delivers into a running instance whose *Combine files*
tab is focused joins that list — the same thing a drag does there, which is the app's own
consistent contract for files it receives at runtime.

`test-pwa.mjs` runs the injected consumer in a mock page and steps those retries by hand: a
launch before the canvas exists waits for it; the consumer keeps retrying while the app's
listener is absent; the files arrive as one cancelable drop carrying the readable files in
launch order, and delivery ends with it; a later launch into the running app delivers at
once.

## Applying and testing locally

Against a built site (the workflow does this against its own `dist/web`):

```sh
python3 pwa/apply.py path/to/dist        # copies the layer in, injects into index.html
node pwa/test-pwa.mjs path/to/dist       # static checks + sw.js in a mock worker environment
```

The harness needs what the build and the workflow leave in `dist/`: the real `index.html`
and the hashed files it references — including the OCR worker's chain, which placeholders
can stand in for — plus the `models/` directory the workflow stages and this layer. `apply.py`
is idempotent — it replaces its earlier injection between `pwa:begin`/`pwa:end` markers —
and the harness re-runs it to prove that.
