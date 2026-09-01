#!/usr/bin/env python3
"""Check that all tracked source files carry the Sonomos copyright header.

Usage:
    python3 scripts/check_copyright.py          # list files missing a header, exit 1 if any
    python3 scripts/check_copyright.py --fix    # insert the header where possible, report the rest

A file passes when 'copyright' appears (any case) in its first 400 characters,
so the existing header variants across repos all count. --fix inserts the
canonical header for the file type at the top, preserving a UTF-8 BOM, a
shebang line, and a Python encoding declaration. Files it cannot fix (not
UTF-8, unknown type) are listed as MANUAL for a human. Empty files, git-LFS
pointers, and vendored/minified/generated paths are skipped.
"""

import argparse
import subprocess
import sys
from pathlib import Path

SLASH = "// Copyright © 2026 Sonomos, Inc.\n// All rights reserved.\n"
HASH = "# Copyright © 2026 Sonomos, Inc.\n# All rights reserved.\n"
PS1 = "# Copyright (c) 2026 Sonomos, Inc. All rights reserved.\n"
BLOCK = "/* Copyright © 2026 Sonomos, Inc. All rights reserved. */\n"
XML = "<!-- Copyright © 2026 Sonomos, Inc. All rights reserved. -->\n"

HEADERS = {
    ".rs": SLASH, ".js": SLASH, ".mjs": SLASH, ".cjs": SLASH,
    ".ts": SLASH, ".tsx": SLASH, ".jsx": SLASH,
    ".py": HASH, ".sh": HASH, ".bash": HASH,
    ".ps1": PS1,
    ".css": BLOCK,
    ".html": XML, ".vue": XML, ".svelte": XML,
}

EXCLUDE_PARTS = {
    "node_modules", "target", "build", "dist", "vendor", "third_party",
    "__pycache__", ".git",
}
EXCLUDE_SUFFIXES = (".min.js", ".min.css", ".wasm.js", ".d.ts")


def tracked_files():
    out = subprocess.run(
        ["git", "ls-files", "-z"], capture_output=True, check=True
    ).stdout
    for name in out.decode().split("\0"):
        if not name:
            continue
        p = Path(name)
        if p.suffix not in HEADERS:
            continue
        if EXCLUDE_PARTS.intersection(p.parts):
            continue
        if name.endswith(EXCLUDE_SUFFIXES):
            continue
        yield p


def insertion_point(text, suffix):
    """Index in text where the header belongs (after shebang/encoding/doctype)."""
    idx = 0
    lines = text.splitlines(keepends=True)
    if lines and lines[0].startswith("#!"):
        idx = len(lines[0])
        # PEP 263: an encoding declaration must stay within the first two lines
        if suffix == ".py" and len(lines) > 1 and "coding" in lines[1] and lines[1].lstrip().startswith("#"):
            idx += len(lines[1])
    elif suffix == ".html" and lines and lines[0].lower().startswith("<!doctype"):
        idx = len(lines[0])
    elif suffix == ".py" and lines and "coding" in lines[0] and lines[0].lstrip().startswith("#"):
        idx = len(lines[0])
    return idx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fix", action="store_true", help="insert missing headers")
    ap.add_argument("-q", "--quiet", action="store_true", help="only print failures")
    args = ap.parse_args()

    missing, fixed, manual = [], [], []
    for p in tracked_files():
        raw = p.read_bytes()
        if not raw.strip():
            continue
        if raw.startswith(b"version https://git-lfs"):
            continue
        bom = b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b""
        try:
            text = raw[len(bom):].decode("utf-8")
        except UnicodeDecodeError:
            if "copyright" not in raw[:400].lower().decode("latin-1"):
                manual.append((p, "not valid UTF-8"))
            continue
        if "copyright" in text[:400].lower():
            continue
        if not args.fix:
            missing.append(p)
            continue
        header = HEADERS[p.suffix]
        idx = insertion_point(text, p.suffix)
        gap = "\n" if not text[idx:].startswith(("\n", "\r")) else ""
        new = text[:idx] + header + gap + text[idx:]
        p.write_bytes(bom + new.encode("utf-8"))
        fixed.append(p)

    for p in missing:
        print(f"MISSING: {p}")
    if fixed and not args.quiet:
        for p in fixed:
            print(f"FIXED: {p}")
    for p, why in manual:
        print(f"MANUAL: {p} ({why})")

    if not args.quiet:
        print(
            f"-- {len(missing)} missing, {len(fixed)} fixed, "
            f"{len(manual)} need manual attention"
        )
    return 1 if (missing or manual) else 0


if __name__ == "__main__":
    sys.exit(main())
