# PdfCraft wasm on GitHub Pages

The WebAssembly build of [PdfCraft](https://github.com/storytold/pdfcraft) — the open-source PDF
workbench written in Rust — published to this repository's GitHub Pages:

**<https://sloth-os.github.io/pdfcraft/>**

This repository holds no PdfCraft source. It contains one workflow,
[`.github/workflows/publish-wasm.yml`](.github/workflows/publish-wasm.yml), which:

1. checks out upstream PdfCraft — the newest release by default, or the ref given to a manual run;
2. builds `apps/pdfcraft-web` the way the official web release is built: stable Rust with the
   `wasm32-unknown-unknown` target, Trunk 0.21.14 (sha256-verified), and the craft-i18n checkout
   pinned by the app's `craft-i18n.rev`;
3. deploys the static site Trunk leaves in `dist/web` to GitHub Pages.

It runs on every push to `main`, once a day (03:17 UTC), and manually from the Actions tab
(*Run workflow* → optional `pdfcraft-ref`: branch, tag or SHA; empty means the newest release).
Note that GitHub disables the daily schedule after 60 days without repository activity; a manual
run always works, and the schedule can be re-enabled from the Actions tab.

All URLs in the generated `index.html` are relative, so the site works under the `/pdfcraft/`
path GitHub Pages serves it from — and inside an `<iframe>`. Hosting notes and URL flags
(`?file=`, `?webgl`, `?cpu`) are in [PdfCraft's packaging/web/README.md][hosting]. PdfCraft is
MIT OR Apache-2.0; the site ships its licence files, and `BUILD.txt` names the upstream commit
it was built from.

[hosting]: https://github.com/storytold/pdfcraft/blob/main/packaging/web/README.md
