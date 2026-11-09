# The PWA layer

What this repository adds to upstream's build beyond building it: installability and offline
use. Upstream's `apps/pdfcraft-web` build is a folder of static files with no manifest, no
icons and no service worker — a browser tab that redownloads its ~73 MB wasm once Pages'
ten-minute cache has gone stale (every build renames the files anyway), and that is all it
is. The publishing workflow applies this layer on top, and the site becomes something that
installs to the home screen, loads instantly on repeat visits, and works on a plane.

| file | |
|---|---|
| `manifest.webmanifest` | the web app manifest: name, icons, standalone display, the app colour |
| `sw.js` | the service worker — the offline cache; its header comment is the design document |
| `apply.py` | copies the layer into a built `dist/` and injects links and registration into `index.html` |
| `test-pwa.mjs` | checks the applied layer, then drives `sw.js` through a mock service-worker environment |
| `icon-32.png` … `apple-touch-icon.png` | the icons, derived from upstream's own app icon (below) |

The manifest's `id`, `start_url` and `scope` are all `"./"`, so it stays correct under the
`/pdfcraft/` path Pages serves the site from — like every other URL the layer adds, they are
relative. A layer file that is renamed or added must be updated in step everywhere it is
named: `manifest.webmanifest`, `apply.py` (`FILES` and `BLOCK`), `sw.js` (`LAYER_FILE`) and
`test-pwa.mjs`.

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
*warm-up*: fetch a fresh `index.html`, copy every file it references — plus the manifest,
whose JSON names the icons — into Cache Storage, and only once **all** of them are in, let
the new page replace the cached one and prune the previous build's hashed files. A partially
fetched or broken deploy therefore never displaces a working build, and the cache stays one
build (~73 MB) deep. Running after the page's own downloads means the warm-up's refetches
come from the browser's HTTP cache, not the network.

At fetch time: navigations to the app page are served from the cache (offline use), with a
background refresh when online; hashed build assets are cache-first forever — their names
carry their content's hash; the layer's own named files (manifest, icons) are network-first
with the cached copy as the offline fallback. Everything else — licence files, `BUILD.txt`,
a same-origin `?file=` document — bypasses the worker, so user documents never grow the
cache. `sw.js` documents all of this in its header comment.

## Applying and testing locally

Against a built site (the workflow does this against its own `dist/web`):

```sh
python3 pwa/apply.py path/to/dist        # copies the layer in, injects into index.html
node pwa/test-pwa.mjs path/to/dist       # static checks + sw.js in a mock worker environment
```

The harness needs what the build leaves in `dist/`: the real `index.html` and the hashed
files it references (a stand-in fixture with the live page and placeholder files works),
plus this layer. `apply.py` is idempotent — it replaces its earlier injection between
`pwa:begin`/`pwa:end` markers — and the harness re-runs it to prove that.
