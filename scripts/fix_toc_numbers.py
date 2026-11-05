#!/usr/bin/env python3
"""Correct cached TOC page numbers in the conversion-copy DOCX files.

Semantics match a Word field refresh: TOC number = printed footer of the
page where the heading actually renders. Ground truth comes from the
already-rendered pass-1 PDF (pagination is unaffected because only the
digits after the right-aligned dot leader change).

Steps:
 1. Collect Heading1-4 texts from the DOCX (document order).
 2. Find each heading's physical page in the PDF (skip occurrences that
    are TOC lines, i.e. followed by 3+ leader dots; monotonic cursor).
 3. Read that page's printed footer number.
 4. Rewrite the cached number (last w:t after the tab run) of the matching
    TOC1/TOC2/TOC3 paragraph in the DOCX XML.

Usage: python3 fix_toc_numbers.py <conv.docx> <rendered.pdf> <out.docx>
"""
import re
import sys

import pdfplumber
from docx import Document
from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W}
FOOTER_RE = re.compile(r"^([0-9]+|[IVXLCDM]+)$")


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def collect_headings(docx_path: str):
    doc = Document(docx_path)
    heads = []
    for p in doc.paragraphs:
        name = p.style.name if p.style else ""
        m = re.match(r"(?i)^heading\s*(\d+)$", name)
        if m and p.text.strip():
            heads.append(p.text.strip())
    return heads


def page_footer(page) -> str | None:
    h = page.height
    crop = page.within_bbox((0, h - 60, page.width, h))
    lines = [ln.strip() for ln in (crop.extract_text() or "").splitlines() if ln.strip()]
    for ln in reversed(lines):
        if FOOTER_RE.match(ln):
            return ln
    return None


def locate(heads, pdf_path: str):
    """Return {heading_text: printed_footer} using a monotonic page cursor."""
    with pdfplumber.open(pdf_path) as pdf:
        pages = [
            {"text": norm(p.extract_text() or ""), "footer": page_footer(p)}
            for p in pdf.pages
        ]
    total = len(pages)
    mapping = {}
    cursor = 0
    for h in heads:
        nh = norm(h)
        found = None
        for idx in range(cursor, total):
            text = pages[idx]["text"]
            start = 0
            hit = False
            while True:
                pos = text.find(nh, start)
                if pos < 0:
                    break
                follow = text[pos + len(nh): pos + len(nh) + 6]
                if not follow.lstrip().startswith("..."):
                    hit = True
                    break
                start = pos + 1
            if hit:
                found = idx
                break
        if found is None:
            print(f"  WARN: heading not located in PDF: {h[:60]}")
            continue
        mapping[nh] = pages[found]["footer"] or str(found + 1)
        cursor = found  # monotonic: next heading is on same or later page
    return mapping


def rewrite(docx_path: str, out_path: str, mapping: dict) -> int:
    import zipfile
    import shutil
    import tempfile
    import os

    with zipfile.ZipFile(docx_path, "r") as zf:
        doc_xml = zf.read("word/document.xml")
    root = etree.fromstring(doc_xml)

    updates = missed = 0
    for p in root.findall(f".//{{{W}}}p"):
        st = p.find(f".//{{{W}}}pStyle")
        if st is None:
            continue
        style_val = st.get(f"{{{W}}}val", "")
        if not re.match(r"(?i)^TOC[1-3]$", style_val):
            continue
        runs = p.findall(f"{{{W}}}r")
        # split runs at the tab run: title runs before, number runs after
        tab_idx = None
        for i, r in enumerate(runs):
            if r.find(f"{{{W}}}tab") is not None:
                tab_idx = i
                break
        if tab_idx is None:
            continue
        title = "".join(
            (t.text or "")
            for r in runs[:tab_idx]
            for t in r.findall(f"{{{W}}}t")
        )
        number_ts = [
            t for r in runs[tab_idx + 1:] for t in r.findall(f"{{{W}}}t")
        ]
        if not title or not number_ts:
            continue
        key = norm(title)
        if key in mapping and mapping[key]:
            number_ts[-1].text = mapping[key]
            updates += 1
        else:
            missed += 1

    with tempfile.TemporaryDirectory() as tmpdir:
        with zipfile.ZipFile(docx_path, "r") as zf:
            zf.extractall(tmpdir)
        with open(os.path.join(tmpdir, "word", "document.xml"), "wb") as f:
            f.write(
                etree.tostring(
                    root, xml_declaration=True, encoding="UTF-8", standalone=True
                )
            )
        with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for dirpath, _dirnames, filenames in os.walk(tmpdir):
                for fn in filenames:
                    full = os.path.join(dirpath, fn)
                    zf.write(full, os.path.relpath(full, tmpdir))
    return updates, missed


def main():
    src, pdf_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
    heads = collect_headings(src)
    print(f"headings in docx: {len(heads)}")
    mapping = locate(heads, pdf_path)
    print(f"headings located in PDF: {len(mapping)}")
    updates, missed = rewrite(src, out, mapping)
    print(f"TOC entries rewritten: {updates}, unmatched TOC entries: {missed}")


if __name__ == "__main__":
    main()
