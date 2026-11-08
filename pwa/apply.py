#!/usr/bin/env python3
"""Add this repository's PWA layer to the built wasm site.

Usage: apply.py [DIST]  (default: dist/web)

Upstream's build of apps/pdfcraft-web leaves a static site whose index.html carries only the
wasm bootstrap. This script copies pwa/ into DIST — the web app manifest, the app icons and
the offline-caching service worker (sw.js explains that) — and injects into index.html the
manifest link, the icons, the browser theme colour and the worker registration. The icons are
upstream's own app icon, licensed like the rest of PdfCraft (MIT OR Apache-2.0); the licence
files the workflow already ships with the site cover them.

The injection is wrapped in pwa:begin/pwa:end comments and replaces any earlier one, so the
script is safe to re-run on the same DIST.
"""

import json
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# What pwa/ adds to the site beyond upstream's build.
FILES = [
    "manifest.webmanifest",   # installability: name, icons, colours
    "sw.js",                  # the offline cache
    "icon-32.png",            # favicon
    "icon-192.png",           # manifest icon
    "icon-512.png",           # manifest icon
    "icon-maskable-512.png",  # manifest icon (maskable)
    "apple-touch-icon.png",   # iOS home-screen icon
]

# The packaging/web/package.sh guard: a root-absolute URL would 404 under /pdfcraft/.
GUARD = re.compile(r'(?:src|href)="/[^/]')

# Injected at the end of <head>. Every URL relative — the site is served under /pdfcraft/.
# The script registers sw.js at once (its fetch handling starts with it), and asks it for a
# warm-up — cache this build for offline use — when Trunk's bootstrap announces that the
# wasm has been fetched and started.
BLOCK = """
    <!-- pwa:begin — this repository's PWA layer: installability, icons, theme colour and the
         offline-caching service worker; see pwa/ in the publishing repository. -->
    <meta name="description" content="The PDF workbench; an open-source, modern PDF reader and editor, built in pure Rust." />
    <meta name="theme-color" content="#b70228" />
    <link rel="manifest" href="manifest.webmanifest" />
    <link rel="icon" type="image/png" sizes="32x32" href="icon-32.png" />
    <link rel="apple-touch-icon" href="apple-touch-icon.png" />
    <script>
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("./sw.js").catch(() => {});
        addEventListener("TrunkApplicationStarted", () => {
          navigator.serviceWorker.ready
            .then((registration) => registration.active && registration.active.postMessage("warm-up"));
        }, { once: true });
      }
    </script>
    <!-- pwa:end -->
  """


def main() -> int:
    dist = Path(sys.argv[1] if len(sys.argv) > 1 else "dist/web").resolve()
    if not (dist / "index.html").is_file():
        sys.exit(f"no index.html in {dist}; run this on a built site")

    for name in FILES:
        shutil.copy(HERE / name, dist / name)
        print(f"{dist / name}")

    # A fresh build from Trunk carries no pwa: markers; a re-run replaces the earlier block.
    html_path = dist / "index.html"
    html = html_path.read_text()
    if html.count("</head>") != 1:
        sys.exit("index.html has no single </head> to inject before; upstream's build changed")
    html = re.sub(r"\n?[ \t]*<!-- pwa:begin.*?<!-- pwa:end -->\n?[ \t]*", "", html, count=1, flags=re.DOTALL)
    html = html.replace("</head>", BLOCK + "</head>", 1)
    html_path.write_text(html)

    # What this layer must find in the page it just wrote, or the site ships broken.
    manifest = json.loads((dist / "manifest.webmanifest").read_text())
    expected = [
        '<link rel="manifest" href="manifest.webmanifest"',
        '<link rel="icon" type="image/png" sizes="32x32" href="icon-32.png"',
        '<link rel="apple-touch-icon" href="apple-touch-icon.png"',
        '<meta name="theme-color" content="#b70228"',
        'navigator.serviceWorker.register("./sw.js")',
        "TrunkApplicationStarted",
    ]
    missing = [needle for needle in expected if needle not in html]
    if missing:
        sys.exit(f"the injected index.html is missing: {missing}")
    if GUARD.search(html):
        sys.exit("index.html has root-absolute URLs; they would break under the /pdfcraft/ path")
    for icon in manifest["icons"]:
        if not (dist / icon["src"]).is_file():
            sys.exit(f"the manifest names {icon['src']}, but it is not in {dist}")
    print(f"{html_path}: manifest, icons, theme colour and worker registration injected")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
