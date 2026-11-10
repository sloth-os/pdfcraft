# PdfCraft wasm on GitHub Pages

The WebAssembly build of [PdfCraft](https://github.com/storytold/pdfcraft) — the open-source PDF
workbench written in Rust — published to this repository's GitHub Pages:

**<https://sloth-os.github.io/pdfcraft/>**

This repository holds no PdfCraft source. It contains one workflow,
[`.github/workflows/publish-wasm.yml`](.github/workflows/publish-wasm.yml), which:

1. checks out upstream PdfCraft — the newest release by default, or the ref given to a manual run;
2. applies this repository's Simplified Chinese web-fallback patch
   ([`patches/`](patches/README.md)): upstream embeds craft-fonts' Simplified Chinese fallback
   face in native builds only, and the patch adds the opt-in (`CRAFT_FONTS_WEB_HANS`) that lets
   the wasm build embed it too;
3. builds `apps/pdfcraft-web` the way the official web release is built: stable Rust with the
   `wasm32-unknown-unknown` target, Trunk 0.21.14 (sha256-verified), the craft-i18n checkout
   pinned by the app's `craft-i18n.rev`, and — the official recipe's optional `web-craft-fonts`
   input, which this site enables — the craft-fonts checkout pinned by PdfCraft's own
   `release.yml`, so the wasm embeds the fallback fonts (the Japanese face BIZ UDPGothic Regular
   and the small Arabic/Thai/Hebrew/Devanagari faces, plus the patch's Simplified Chinese face)
   and Edit text works for those scripts;
4. stages the OCR models under `models/` beside the app, the way upstream's own web packaging
   does (v0.20.0's Scan & OCR downloads them from there on first use; each is verified against
   the sha256 pinned in upstream's ATTRIBUTION.toml and ships with its CC-BY-SA-4.0 licence
   text and attribution);
5. applies this repository's PWA layer ([`pwa/`](pwa/README.md)) to the build: the web app
   manifest, the app icons (upstream's own), the theme colour, a service worker that caches
   the build for offline use, and — once the app is installed — registration as an OS-level
   PDF handler, so a PDF opened from the file manager comes up in the app — then runs the
   layer's test harness over the finished site;
6. deploys the static site to GitHub Pages.

It runs on every push to `main`, once a day (03:17 UTC), and manually from the Actions tab
(*Run workflow* → optional `pdfcraft-ref`: branch, tag or SHA; empty means the newest release).
Note that GitHub disables the daily schedule after 60 days without repository activity; a manual
run always works, and the schedule can be re-enabled from the Actions tab.

All URLs in the generated `index.html` are relative, so the site works under the `/pdfcraft/`
path GitHub Pages serves it from — and inside an `<iframe>`. Hosting notes and URL flags
(`?file=`, `?webgl`, `?cpu`) are in [PdfCraft's packaging/web/README.md][hosting]. PdfCraft is
MIT OR Apache-2.0, the embedded craft-fonts faces are OFL-1.1 and the OCR models are
CC-BY-SA-4.0; the site ships each set's licence files (the models' attribution is
`models/ATTRIBUTION.txt`), and `BUILD.txt` names the upstream commit and craft-fonts pin it
was built from.

## PWA: install, offline, and opening PDFs from the OS

The site is installable (Chrome/Edge's install icon, iOS's *Add to Home Screen*, Android's
web-app install banner) and works offline: open it once while online, wait a moment for the app
to start, and from then on it loads with no network at all. Behind that is [`pwa/`](pwa/README.md)
— a manifest with upstream's own app icon, and a service worker that copies the running build's
files into Cache Storage once the app has started. Because every build renames those files, the
worker caches them by reading a fresh `index.html` rather than from a fixed list, and swaps a new
build in only once every one of its files is cached — a partial or broken deploy never displaces
the working one. Repeat visits are served from the cache, so the ~79 MB wasm downloads once per
build instead of once per stale cache. Scan & OCR works offline too: the OCR worker's files are
warmed up with the build, and the models are cached as the page downloads them on first use.
Everything the layer does is documented in [`pwa/README.md`](pwa/README.md) and `pwa/sw.js`.

Once installed (Chromium-family browsers), the app registers with the OS as a PDF handler:
*Open with* → PdfCraft, or a double-click after making it the default, opens the file in the
app's own window — no browser UI — with the document in a tab named after the file, exactly as
if it had been dragged onto the window. Saving keeps downloading, as in the browser.

[hosting]: https://github.com/storytold/pdfcraft/blob/main/packaging/web/README.md
