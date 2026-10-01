#!/usr/bin/env python3
"""Assert that every backtick-quoted path in a markdown file exists.

Usage: check_paths.py <file.md> [repo-root]

Extracts inline code spans (`like this`) from the markdown file, keeps the
spans that look like filesystem paths, and asserts each one exists under the
repo root. Fenced code blocks (``` ... ```) are stripped first: their content
is illustrative (repository tree diagrams), not backtick-quoted paths.

A span looks like a path when it has no whitespace, does not start with
'/', '~' or '$' (URL paths, home paths and variables are outside the repo),
and either contains a '/' or ends with a well-known file extension.

Exit 0 when every path exists (OK lines are printed); exit 1 naming each
missing path otherwise.
"""

import re
import sys
from pathlib import Path

FENCE = re.compile(r"^```.*?^```", re.S | re.M)
SPAN = re.compile(r"`([^`\n]+)`")
EXTENSIONS = {
    ".md",
    ".java",
    ".json",
    ".gradle",
    ".sh",
    ".nix",
    ".yaml",
    ".yml",
    ".dart",
    ".bat",
    ".txt",
    ".xml",
    ".properties",
    ".lock",
    ".py",
    ".kt",
    ".toml",
}


def looks_like_path(span: str) -> bool:
    if not span or any(c.isspace() for c in span):
        return False
    if span.startswith(("/", "~", "$")):
        return False
    if "/" in span:
        return True
    return Path(span).suffix.lower() in EXTENSIONS


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    md = Path(sys.argv[1])
    root = Path(sys.argv[2]) if len(sys.argv) > 2 else Path.cwd()
    text = md.read_text(encoding="utf-8")
    prose = FENCE.sub("", text)
    paths = [s for s in SPAN.findall(prose) if looks_like_path(s)]
    missing = []
    for span in paths:
        if (root / span).exists():
            print(f"OK  {span}")
        else:
            missing.append(span)
            print(f"MISSING  {span}")
    if missing:
        print(f"{len(missing)} missing path(s)")
        return 1
    print(f"all {len(paths)} backtick-quoted paths exist")
    return 0


if __name__ == "__main__":
    sys.exit(main())
