#!/usr/bin/env python3
"""Verify that the wasm site the workflow builds embeds craft-fonts' Simplified Chinese
faces byte-exactly.

Usage: verify-embedded-face.py [DIST] [CRAFT_FONTS]   (defaults: dist/web craft-fonts)

The patch in this directory makes a wasm build embed the faces of craft-fonts'
fonts/simplified-chinese-manifest.txt — the Simplified Chinese fallback Edit text needs.
Plenty can silently undo that between the patch and the shipped file: an env var lost from
the workflow, a manifest that changed shape, a size cap that now skips the face. So the
publishing workflow runs this script on the finished site, and the build is good only if
the pinned face is actually in the artifact — the outcome, not the mechanism.

The check cannot be a byte search of the file. The build pipeline is cargo → wasm-bindgen
→ wasm-opt -Oz (Trunk 0.21.14 pins binaryen version_123), and wasm-opt rewrites the data
section, splitting segments where the face has runs of zero bytes: in today's artifact the
13.9 MB face arrives as 128 segments, and the whole face appears as one byte string nowhere
in the file. The module's linear memory holds it whole — every active data segment lands in
one image — so this
script parses the data section, reassembles that image, finds the face there and hashes it
against the sha256 pinned in the manifest, a pin the build itself never checks. Only the
faces of the Chinese manifest are verified here; the five the official web build embeds are
upstream's own business.
"""

import hashlib
import sys
from pathlib import Path

# The manifest the patch's CRAFT_FONTS_WEB_HANS makes a wasm build read.
MANIFEST = "fonts/simplified-chinese-manifest.txt"


def uleb(buf: bytes, i: int) -> tuple[int, int]:
    """The unsigned LEB128 integer at `i`, with the position just after it."""
    value = shift = 0
    while True:
        byte = buf[i]
        i += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, i
        shift += 7


def sleb(buf: bytes, i: int) -> tuple[int, int]:
    """The signed LEB128 integer at `i`, with the position just after it."""
    value = shift = 0
    while True:
        byte = buf[i]
        i += 1
        value |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            if byte & 0x40 and shift < 64:
                value |= -(1 << shift)
            return value, i


def data_segments(wasm: bytes) -> list[tuple[int, bytes]]:
    """The module's active data segments, as (memory offset, bytes) in section order.

    A wasm module is a sequence of sections, each an id and a length; the data section
    (id 11) holds a count of segments, each flags, an offset expression and the bytes.
    wasm-bindgen emits active segments (flags 0) at i32.const offsets, and anything else
    fails loudly below rather than being quietly mis-read. Passive segments (flags 1, no
    offset — initialized at runtime by bulk-memory operations) carry none of the embedded
    faces, and are skipped.
    """
    segments = []
    i = 8
    while i < len(wasm):
        section_id = wasm[i]
        i += 1
        size, i = uleb(wasm, i)
        end = i + size
        if end > len(wasm):
            sys.exit(f"truncated wasm: section {section_id} runs past the end of the file")
        if section_id == 11:
            count, j = uleb(wasm, i)
            for _ in range(count):
                flags, j = uleb(wasm, j)
                if flags == 1:  # passive: no offset, no place in the initial image
                    length, j = uleb(wasm, j)
                    j += length
                    continue
                if flags == 2:  # an explicit memory index, which must be the one
                    memory, j = uleb(wasm, j)
                    if memory != 0:
                        sys.exit(f"data segment for memory {memory}; this script reads only memory 0")
                elif flags != 0:
                    sys.exit(f"unknown data segment flags {flags}")
                if wasm[j] != 0x41:  # i32.const
                    sys.exit(f"segment offset expression starts with opcode {wasm[j]:#x}, not i32.const")
                offset, j = sleb(wasm, j + 1)
                if offset < 0:
                    sys.exit(f"segment offset {offset} is negative; not a valid module")
                if wasm[j] != 0x0B:  # end
                    sys.exit("segment offset expression is more than an i32.const")
                length, j = uleb(wasm, j + 1)
                if j + length > len(wasm):
                    sys.exit("truncated wasm: segment data runs past the end of the file")
                segments.append((offset, wasm[j:j + length]))
                j += length
            if j != end:
                sys.exit("the data section did not parse to its own length")
        i = end
    return segments


def memory_image(segments: list[tuple[int, bytes]]) -> bytes:
    """Linear memory with every active segment applied in order, later over earlier."""
    if not segments:
        return b""
    image = bytearray(max(offset + len(data) for offset, data in segments))
    for offset, data in segments:
        image[offset:offset + len(data)] = data
    return bytes(image)


def manifest_faces(craft_fonts: Path) -> list[tuple[str, str, Path, str]]:
    """(family, style, face file, pinned sha256) per row of the Chinese manifest."""
    manifest = craft_fonts / MANIFEST
    if not manifest.is_file():
        sys.exit(f"no {MANIFEST} in {craft_fonts}; this needs the craft-fonts checkout the build used")
    faces = []
    for line in manifest.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        fields = [field.strip() for field in line.split("|")]
        if len(fields) < 8:
            sys.exit(f"{manifest}: malformed line: {line}")
        family, style, file, _scripts, _licence, _licence_file, sha256, _source = fields[:8]
        faces.append((family, style, craft_fonts / file, sha256))
    if not faces:
        sys.exit(f"{manifest} names no faces; craft-fonts changed shape, and the site would ship without Simplified Chinese support")
    return faces


def main() -> int:
    dist = Path(sys.argv[1] if len(sys.argv) > 1 else "dist/web").resolve()
    craft_fonts = Path(sys.argv[2] if len(sys.argv) > 2 else "craft-fonts").resolve()

    wasms = sorted(dist.glob("*.wasm"))
    if not wasms:
        sys.exit(f"no .wasm in {dist}; run this on the built site")
    images = []
    for path in wasms:
        wasm = path.read_bytes()
        if wasm[:8] != b"\0asm\x01\0\0\0":
            sys.exit(f"{path}: not a WebAssembly module")
        try:
            segments = data_segments(wasm)
        except IndexError:
            sys.exit(f"{path}: truncated or malformed wasm (the parser ran off the end)")
        image = memory_image(segments)
        print(f"{path.name}: {path.stat().st_size:,} bytes, {len(segments):,} data segments, "
              f"memory image {len(image):,} bytes")
        images.append((path, image))

    for family, style, face_path, pin in manifest_faces(craft_fonts):
        try:
            face = face_path.read_bytes()
        except OSError as error:
            sys.exit(f"{face_path}: {error}; the manifest names a file the checkout does not have")
        digest = hashlib.sha256(face).hexdigest()
        if digest != pin:
            sys.exit(f"{face_path}: sha256 {digest}, but {MANIFEST} pins {pin} — the craft-fonts "
                     "checkout is not the pinned one")
        found = None
        header_hits = 0
        for path, image in images:
            at = image.find(face[:64])
            while at >= 0:
                header_hits += 1
                if hashlib.sha256(image[at:at + len(face)]).hexdigest() == pin:
                    found = (path, at)
                    break
                at = image.find(face[:64], at + 1)
            if found:
                break
        if not found:
            if header_hits:
                sys.exit(f"{family} {style}: the wasm holds the face's first bytes but not the whole "
                         f"pinned face ({header_hits} candidate window"
                         f"{'s' if header_hits > 1 else ''}); the embedded bytes are not what "
                         f"{MANIFEST} pins")
            sys.exit(f"{family} {style} is not in the built wasm — the CRAFT_FONTS_WEB_HANS build "
                     "did not embed it; see patches/README.md")
        path, at = found
        print(f"{family} {style} ({face_path.relative_to(craft_fonts)}): {len(face):,} bytes, "
              f"sha256 {pin[:8]}…, embedded byte-exactly at memory offset {at:,} in {path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
