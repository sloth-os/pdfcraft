# The Simplified Chinese web-fallback patch

Two files: `simplified-chinese-web-fallback.patch`, this repository's only change to
PdfCraft's source, and `verify-embedded-face.py`, the guard that proves the change landed in
the artifact. The publishing workflow applies the patch to the upstream checkout right after
checking it out and before building ([`../.github/workflows/publish-wasm.yml`]
(../.github/workflows/publish-wasm.yml), *Apply the Simplified Chinese web-fallback patch*),
then runs the guard on the finished site. Everything else this repository does — the build
recipe, the PWA layer — leaves upstream's source alone.

## What it changes, and why

Edit text in PdfCraft replaces a line of text with a generated Type 3 font when the source font
can't draw the replacement. The faces it can draw from are embedded at build time from the
optional craft-fonts input: the Japanese faces, the bundled Latin face, and small Hebrew/Arabic/
Thai/Telugu/Devanagari faces. Simplified Chinese has a face in craft-fonts — LXGW WenKai Lite,
in a manifest of its own, `fonts/simplified-chinese-manifest.txt` — but upstream reads that
manifest in **native builds only**. A wasm build embeds none of it, so on this site Edit text
refuses Simplified-only characters (潇, 测) with the no-fallback-font error, while the desktop
build writes them happily.

The reason upstream keeps it native-only is size: the face is 13.9 MB against the web
payload's ~6 MB of embedded faces, and the official build keeps the web download within
hosting limits (its `build.rs` names Cloudflare Pages' 25 MiB-per-file rule). This site makes
the other trade: GitHub Pages allows 100 MB per file, the whole wasm stays well under it, and
Simplified Chinese text — hundreds of millions of writers, and this site's most-used
non-Latin script after Japanese — works.

The patch makes the choice an opt-in rather than a fork of the rule:

- **`CRAFT_FONTS_WEB_HANS`** — set, a wasm build reads the Chinese manifest too and embeds its
  `Hans` face (behind the same 16 MiB reviewed-fallback cap and `CRAFT_FONTS_REQUIRED`
  enforcement as native builds); unset, the wasm payload is exactly the official web build's,
  face for face. A new `CRAFT_FONTS_WEB_HANS` constant is generated into the build so the
  crate's own tests can tell the two states apart.
- **`document_chinese_fonts()`** — the `Hans` faces, in manifest order, for writing into PDFs.
- **The fallback chain** — the editor chains the Chinese face strictly *last*: Japanese faces,
  then the bundled Latin face, then Simplified Chinese. Order matters both ways: the Chinese
  face also covers Cyrillic the Japanese faces lack, so any earlier and it would take over
  text the Latin face is pinned for, or displace a Japanese face for text both can draw. Last,
  it is chosen only when it has every character of the replacement (a wholly Simplified string
  takes it — font `/PCZh`), and otherwise donates single glyphs that ride along in the
  leading font's own resource (潇 behind a Japanese face), the way Hebrew already worked.
- **Tests** — the whole story above is pinned by tests that skip with a visible message when
  the face isn't embedded: a Simplified Chinese replacement takes the Chinese face (line and
  paragraph rewrites); a Simplified-only character rides in the Japanese fallback font; the
  `/PCZh` font is recognized as one of ours when read back; the wasm build embeds the Chinese
  manifest only behind the opt-in; and a required build cannot pass without a real `Hans` face.

Seven files, +160/−48 as of v0.19.0: `crates/fonts/{build.rs, src/cjk_scripts.rs, src/craft.rs,
src/lib.rs}` for the embed side, `crates/edit/src/text/fallback.rs` and its callers for the
chain, `crates/edit/src/tests.rs` and `crates/edit/src/text.rs` for the tests.

## The guard: `verify-embedded-face.py`

The patch is one env var away from silently doing nothing — a workflow edit that drops
`CRAFT_FONTS_WEB_HANS`, a craft-fonts release that changes the manifest's shape, a size cap
that starts skipping the face. The build would stay green and the site would ship without
Simplified Chinese support, which is the failure this patch exists to fix. So the workflow
verifies the *outcome*: `verify-embedded-face.py dist/web craft-fonts` runs right after the
build and fails it unless every face the Chinese manifest pins is embedded byte-exactly in
the wasm.

Byte-exactly needs care. The build pipeline is cargo → wasm-bindgen → wasm-opt (Trunk 0.21.14
pins binaryen version_123, called with `-Oz`), and wasm-opt rewrites the data section,
splitting segments where the face has runs of zero bytes — in the v0.19.0 artifact the 13.9 MB
face arrives as 128 segments, one 13.5 MB zero-free stretch surviving whole and the rest cut
apart, so the whole face appears as one byte string nowhere in the file (the official build's
BIZ UDPGothic face already suffers the same in its last 64 bytes). In the module's
linear memory every segment lands in one image, so the script parses the data section,
reassembles that image, finds the face there and hashes it against the sha256 pinned in the
manifest — a pin the build itself never checks. Negative controls: the same pipeline without
the patch, and the live official site's artifact, both fail the guard; error paths (no wasm,
missing manifest, a checkout that doesn't match its pin) fail loudly too.

## When it stops applying

The patch was generated against v0.19.0 (upstream commit `8c572792`). When a release moves any
of the patched lines, `git apply --check` in the workflow fails the build loudly:

> the Simplified Chinese web-fallback patch no longer applies to storytold/pdfcraft at \<ref\>;
> regenerate it against that release

That failure is the point — the alternative is the build quietly shipping a site whose
Simplified Chinese support vanished. To regenerate:

1. Check out the new release and apply the old patch: `git apply` will name the first hunk
   that no longer fits.
2. Resolve by hand — the change is small and its shape is stable: an env-var gate in
   `crates/fonts/build.rs`, a `document_chinese_fonts()` sibling next to the Japanese one in
   `crates/fonts/src/craft.rs`, `.chain(chinese)` at the end of the chain in
   `crates/edit/src/text/fallback.rs`, and the tests.
3. Regenerate the diff against the unmodified release (`git diff` in a clean checkout of it)
   and replace the file here. Upstream may have changed the meantime: if it grew its own
   web-side Chinese support, the patch — and this directory — should be retired rather than
   maintained.
4. Verify as below, then push; the workflow rebuilds and deploys.

## Verification record (v0.19.0, 2026-11-09)

- Applies cleanly to a pristine v0.19.0 checkout (`git apply --check`); the result is
  byte-identical to the tree the tests below ran in.
- `crates/fonts` and `crates/edit` tests pass with the face embedded (native and
  `CRAFT_FONTS_WEB_HANS=1` wasm payloads) and skip visibly without it; the wasm face set is
  the official five faces without the opt-in and six with it.
- The full `pdfcraft-web` wasm build (stable Rust, `CRAFT_FONTS_DIR` + `CRAFT_FONTS_REQUIRED=1`
  + `CRAFT_FONTS_WEB_HANS=1` + the pinned craft-i18n; Trunk 0.21.14 → wasm-bindgen 0.2.129 →
  wasm-opt version_123) compiles and links, and its final artifact embeds the LXGW WenKai Lite
  face byte-exactly: reassembling the module's linear memory — the file never holds the face
  as one byte string, wasm-opt having split it into 128 data segments — and hashing the
  13,949,472 bytes at memory offset 10,991,524 yields exactly the manifest pin `f799a538…`, on
  wasm-opt version_123 (Trunk's pin) and v132 alike. The same pipeline without the patch, and
  the live official artifact, both fail that check; `verify-embedded-face.py` now runs it in
  CI after every build.

The size cost, measured on the same toolchain with and without the patch, is recorded in the
table below (also the number the PWA layer's "~73 MB" cache-depth notes are rounded from):

| build | wasm artifact |
|---|---|
| official web build (v0.19.0, unpatched) | 59.1 MB |
| this site's build (same + the patch) | 72.4 MB |
| of which the LXGW WenKai Lite face | 13.3 MB |
