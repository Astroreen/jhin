#!/usr/bin/env python3
"""Extract ```java fenced blocks from markdown docs into compilable Java files.

Usage:
    python3 extract_snippets.py [-o OUTDIR] DOC.md [DOC.md ...]

For every ```java fence in the given documents, in document order, one `.java`
file is written to OUTDIR (default: build/extracted, relative to this script's
directory):

1. Package and import lines are hoisted out of the block and re-emitted at the
   top of the file (the package line first, then the imports in order of first
   appearance), so a member fragment may still carry its own imports.

2. Unit heuristic: the first non-import, non-blank line of the remaining body
   (skipping comment-only lines) is stripped of leading annotations and
   modifiers (public, final, ...). If what remains starts with one of
   class / interface / enum / record / @interface, the block is a top-level
   compilation unit and the file carries it as-is. Otherwise the block is a
   member fragment and is WRAPPED in a synthetic holder:

       final class BlockNN {
       <body indented by four spaces>
       }

   The wrapping is named in the per-block report below; wrapped fragments may
   only contain members (fields, methods, nested types), never top-level types.

3. File naming: a unit declaring a public top-level type is named after that
   type (Foo.java for `public final class Foo`); every other file — including
   all wrapped fragments — is named BlockNN.java, with NN the 1-based fence
   number across the whole run.

All generated files are meant to be compiled together in one javac invocation
(or one Gradle source set), so blocks may reference each other's types through
their packages and imports.
"""

import argparse
import re
import sys
from pathlib import Path

UNIT_KEYWORDS = ("class ", "interface ", "enum ", "record ", "@interface ")

IMPORT_RE = re.compile(r"^\s*(package\s+[\w.]+\s*;|import\s+(?:static\s+)?[\w.*]+\s*;)\s*$")
ANNOTATION_RE = re.compile(r"^@\w+(?:\([^)]*\))?\s+")
MODIFIER_RE = re.compile(
    r"^(?:public|protected|private|static|final|abstract|sealed|non-sealed|strictfp)\s+"
)
PUBLIC_TYPE_RE = re.compile(
    r"^\s*public\s+(?:(?:final|abstract|sealed|strictfp)\s+)*"
    r"(?:class|interface|enum|record|@interface)\s+(\w+)",
    re.MULTILINE,
)
COMMENT_LINE_RE = re.compile(r"^\s*(?://|/\*|\*/|\*)")


def extract_fences(text, language="java"):
    """Yields (start_line, body) for every ```<language> fence, 1-based."""
    lines = text.splitlines()
    i = 0
    open_re = re.compile(r"^```" + re.escape(language) + r"\s*$")
    while i < len(lines):
        if open_re.match(lines[i].strip()):
            start = i + 1
            j = start
            while j < len(lines) and lines[j].strip() != "```":
                j += 1
            if j >= len(lines):
                raise SystemExit(f"unterminated ```{language} fence at line {i + 1}")
            yield start, "\n".join(lines[start:j]) + ("\n" if start < j else "")
            i = j + 1
        else:
            i += 1


def hoist_package_and_imports(body):
    """Splits body into (header_lines, body_lines); header = package + imports."""
    package = None
    imports = []
    seen = set()
    rest = []
    for line in body.splitlines():
        match = IMPORT_RE.match(line)
        if match:
            statement = re.sub(r"\s+", " ", match.group(1)).strip()
            if statement.startswith("package"):
                package = statement
            elif statement not in seen:
                seen.add(statement)
                imports.append(statement)
        else:
            rest.append(line)
    header = ([package] if package else []) + imports
    return header, rest


def is_unit_start(line):
    """True when the line opens a top-level type declaration."""
    stripped = line.strip()
    if stripped.startswith("@interface"):
        return True
    while True:
        match = ANNOTATION_RE.match(stripped)
        if match:
            stripped = stripped[match.end():]
            continue
        match = MODIFIER_RE.match(stripped)
        if match:
            stripped = stripped[match.end():]
            continue
        break
    return stripped.startswith(UNIT_KEYWORDS)


def first_code_line(body_lines):
    """The first line that is neither blank nor comment-only."""
    for line in body_lines:
        if line.strip() and not COMMENT_LINE_RE.match(line):
            return line
    return ""


def public_type_name(body_lines):
    match = PUBLIC_TYPE_RE.search("\n".join(body_lines))
    return match.group(1) if match else None


def build_file(header, body_lines, block_number):
    """Returns (filename, source, wrapped)."""
    probe = first_code_line(body_lines)
    if is_unit_start(probe):
        name = public_type_name(body_lines)
        filename = f"{name}.java" if name else f"Block{block_number:02d}.java"
        source = "\n".join(header + [""] + body_lines).rstrip() + "\n"
        return filename, source, False
    wrapper = f"Block{block_number:02d}"
    indented = ["    " + line if line.strip() else "" for line in body_lines]
    source = "\n".join(
        header + [""] + [f"final class {wrapper} {{"] + indented + ["}"]
    ).rstrip() + "\n"
    return f"{wrapper}.java", source, True


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("docs", nargs="+", help="markdown documents to scan")
    parser.add_argument(
        "-o",
        "--outdir",
        default=str(Path(__file__).resolve().parent / "build" / "extracted"),
        help="output directory for the generated .java files",
    )
    args = parser.parse_args()

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    for stale in outdir.glob("*.java"):
        stale.unlink()

    total = 0
    wrapped = 0
    for doc in args.docs:
        text = Path(doc).read_text(encoding="utf-8")
        blocks = list(extract_fences(text))
        print(f"{doc}: {len(blocks)} java block(s)")
        for start_line, body in blocks:
            total += 1
            header, body_lines = hoist_package_and_imports(body)
            filename, source, was_wrapped = build_file(header, body_lines, total)
            (outdir / filename).write_text(source, encoding="utf-8")
            if was_wrapped:
                wrapped += 1
            kind = "wrapped member fragment" if was_wrapped else "compilation unit"
            print(
                f"  block {total:02d} (line {start_line}) -> {filename} [{kind}]"
            )
    print(f"total: {total} java block(s), {wrapped} wrapped, written to {outdir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
