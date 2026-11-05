#!/usr/bin/env python3
"""Add clickable link annotations to the TOC lines of the converted PDFs.

For every TOC entry line (title ... dots ... number) on the TOC pages, add a
pypdf Link annotation covering the full line rect, targeting the physical
page where the matching body heading renders. Clones the input PDF (metadata
and outline preserved), adds annotations, writes in place via temp output.

Usage: python3 add_toc_links.py <final.docx> <final.pdf>
"""
import re
import sys
import tempfile
import os

import pdfplumber
from lxml import etree
import zipfile
from pypdf import PdfReader, PdfWriter
from pypdf.annotations import Link
from pypdf.generic import Fit

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
TOC_LINE_RE = re.compile(r"^(.*?)\.{3,}\s*([0-9]+)\s*$")


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def collect_headings(docx_path: str):
    """Heading texts (document order) + TOC entry titles from the docx."""
    with zipfile.ZipFile(docx_path, "r") as zf:
        root = etree.fromstring(zf.read("word/document.xml"))
    heads, toc_titles = [], []
    for p in root.iter(f"{{{W}}}p"):
        style = p.find(f".//{{{W}}}pStyle")
        val = style.get(f"{{{W}}}val", "") if style is not None else ""
        name = val
        text = "".join(t.text or "" for t in p.findall(f".//{{{W}}}t")).strip()
        if not text:
            continue
        if re.match(r"(?i)^heading\s*\d+$", name):
            heads.append(text)
        elif re.match(r"(?i)^TOC[1-3]$", val):
            m = re.match(r"^(.*?)\.{0,}\s*(\d+)$", text)
            if m:
                toc_titles.append(re.sub(r"\.{3,}", "", m.group(1)).strip())
    return heads, toc_titles


def locate_physical(heads, pdf_path: str):
    """heading (normalized) -> physical page index (0-based)."""
    with pdfplumber.open(pdf_path) as pdf:
        pages = [norm(p.extract_text() or "") for p in pdf.pages]
    mapping, cursor = {}, 0
    for h in heads:
        nh = norm(h)
        found = None
        for idx in range(cursor, len(pages)):
            text = pages[idx]
            start = 0
            while True:
                pos = text.find(nh, start)
                if pos < 0:
                    break
                follow = text[pos + len(nh): pos + len(nh) + 6]
                if not follow.lstrip().startswith("..."):
                    found = idx
                    break
                start = pos + 1
            if found is not None:
                break
        if found is not None:
            mapping[nh] = found
            cursor = found
    return mapping


def main(docx_path: str, pdf_path: str) -> None:
    heads, _ = collect_headings(docx_path)
    target_of = locate_physical(heads, pdf_path)

    with pdfplumber.open(pdf_path) as pdf:
        page_heights = [p.height for p in pdf.pages]
        toc_lines = []  # (page_idx, title, (x0, top, x1, bottom))
        for idx, page in enumerate(pdf.pages):
            for line in page.extract_text_lines():
                m = TOC_LINE_RE.match(line["text"].strip())
                if not m:
                    continue
                title = norm(re.sub(r"\s+", " ", m.group(1)).strip())
                toc_lines.append((idx, title, line))

    writer = PdfWriter(clone_from=pdf_path)
    added = 0
    for page_idx, title, line in toc_lines:
        target = None
        # exact match first, then prefix match
        if title in target_of:
            target = target_of[title]
        else:
            for h, phys in target_of.items():
                if h.startswith(title[:40]) or title.startswith(h[:40]):
                    target = phys
                    break
        if target is None:
            print(f"  WARN: no target for TOC line: {title[:60]}")
            continue
        h = page_heights[page_idx]
        rect = (
            line["x0"] - 2,
            h - line["bottom"] - 2,
            line["x1"] + 2,
            h - line["top"] + 2,
        )
        writer.add_annotation(
            page_number=page_idx,
            annotation=Link(rect=rect, target_page_index=target, fit=Fit("/XYZ")),
        )
        added += 1

    fd, tmp = tempfile.mkstemp(suffix=".pdf", dir=os.path.dirname(pdf_path))
    os.close(fd)
    with open(tmp, "wb") as f:
        writer.write(f)
    os.replace(tmp, pdf_path)
    print(f"{os.path.basename(pdf_path)}: {added} TOC link annotations added")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
