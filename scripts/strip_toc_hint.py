#!/usr/bin/env python3
"""Remove Word-only TOC editing hints from conversion copies of the spec docs
WITHOUT altering section structure.

v2: strips only the RUNS of hint paragraphs, keeping each paragraph element
(and its pPr, which may carry a sectPr) intact. Deleting whole paragraphs
previously destroyed the TOC section's sectPr, collapsing the roman-numbered
front matter into the body's decimal stream.

Usage: python3 strip_toc_hint.py <src.docx> <dst.docx>
"""
import re
import shutil
import sys
import zipfile
import os
import tempfile

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

HINT_PATTERN = re.compile(
    r"Update Field|generated via field codes|page number accuracy after editing",
    re.IGNORECASE,
)


def para_text(p) -> str:
    return "".join(t.text or "" for t in p.findall(f".//{{{W}}}t"))


def strip_hints(src: str, dst: str) -> int:
    shutil.copyfile(src, dst)
    with zipfile.ZipFile(src, "r") as zf:
        doc_xml = zf.read("word/document.xml")
    root = etree.fromstring(doc_xml)

    stripped = 0
    for p in root.findall(f".//{{{W}}}p"):
        if HINT_PATTERN.search(para_text(p)):
            # remove runs (and hyperlink wrappers) but keep pPr / sectPr
            for child in list(p):
                if child.tag in (f"{{{W}}}r", f"{{{W}}}hyperlink"):
                    p.remove(child)
            stripped += 1

    with tempfile.TemporaryDirectory() as tmpdir:
        with zipfile.ZipFile(src, "r") as zf:
            zf.extractall(tmpdir)
        with open(os.path.join(tmpdir, "word", "document.xml"), "wb") as f:
            f.write(
                etree.tostring(
                    root, xml_declaration=True, encoding="UTF-8", standalone=True
                )
            )
        with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zf:
            for dirpath, _d, filenames in os.walk(tmpdir):
                for fn in filenames:
                    full = os.path.join(dirpath, fn)
                    zf.write(full, os.path.relpath(full, tmpdir))
    return stripped


def main() -> None:
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    src, dst = sys.argv[1], sys.argv[2]
    n = strip_hints(src, dst)
    print(f"{dst}: stripped runs from {n} hint paragraph(s)")


if __name__ == "__main__":
    main()
