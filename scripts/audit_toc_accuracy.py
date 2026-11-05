#!/usr/bin/env python3
"""Audit TOC page-number accuracy for the converted spec PDFs.

Ground truth: for every TOC entry (title ... claimed_number), find the body
page whose heading matches the title, read that page's printed footer number,
and compare. Reports per-entry mismatches.

Usage: python3 audit_toc_accuracy.py <file.pdf>
"""
import re
import sys

import pdfplumber

FOOTER_RE = re.compile(r"^([0-9]+|[IVXLCDM]+)$")
TOC_LINE_RE = re.compile(r"^(.*?)\.{3,}\s*([0-9]+)\s*$")
HEAD_RE = re.compile(
    r"^((?:\d+(?:\.\d+)*\.?)|(?:UC-\d+)|(?:Appendix\s+[A-Z]))\s+(.+)$"
)


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def page_footer(page) -> str | None:
    """Printed page number = lowest text line that is a bare number/roman."""
    h = page.height
    crop = page.within_bbox((0, h - 60, page.width, h))
    lines = [ln.strip() for ln in (crop.extract_text() or "").splitlines() if ln.strip()]
    for ln in reversed(lines):
        if FOOTER_RE.match(ln):
            return ln
    return None


def main(pdf_path: str) -> None:
    with pdfplumber.open(pdf_path) as pdf:
        pages = []
        for p in pdf.pages:
            text = p.extract_text() or ""
            lines = [ln.rstrip() for ln in text.splitlines()]
            pages.append({"lines": lines, "footer": page_footer(p), "raw": text})

    # 1) Identify TOC pages: contain the literal heading + dot-leader lines
    toc_pages = [
        i for i, pg in enumerate(pages)
        if sum(1 for ln in pg["lines"] if TOC_LINE_RE.match(ln.strip())) >= 5
    ]
    toc_first = min(toc_pages) if toc_pages else None
    print(f"TOC pages (physical, 1-based): {[i + 1 for i in toc_pages]}")

    # 2) Parse TOC entries
    entries = []
    for i in toc_pages:
        for ln in pages[i]["lines"]:
            m = TOC_LINE_RE.match(ln.strip())
            if m:
                title, claimed = norm(m.group(1)), int(m.group(2))
                entries.append((title, claimed, i + 1))
    print(f"TOC entries parsed: {len(entries)}")

    # 3) Build heading index from non-TOC pages (top 2/3 of page, standalone lines)
    headings = []  # (norm_title, page_idx, footer)
    for i, pg in enumerate(pages):
        if i in toc_pages:
            continue
        for ln in pg["lines"]:
            s = ln.strip()
            m = HEAD_RE.match(s) or re.match(r"^(Appendix\s+[A-Z])\s+(.*)$", s)
            if m:
                title = norm(ln.strip())
                headings.append((title, i, pg["footer"]))

    # 4) Match each TOC entry to its heading
    bad = ok = 0
    for title, claimed, toc_pg in entries:
        # longest-prefix match against body headings
        best = None
        for h_title, h_idx, h_footer in headings:
            if h_title.startswith(title[:40]) or title.startswith(h_title[:40]):
                best = (h_idx, h_footer)
                break
        if best is None:
            print(f"  ?? no heading found for: {title[:60]} (claimed {claimed})")
            continue
        h_idx, h_footer = best
        actual = h_footer if h_footer and h_footer.isdigit() else str(h_idx + 1)
        if int(actual) == claimed:
            ok += 1
        else:
            bad += 1
            print(
                f"  MISMATCH: {title[:58]:<58} claimed p.{claimed}  "
                f"actual printed p.{actual} (physical {h_idx + 1})"
            )

    print(f"RESULT: {ok} correct, {bad} mismatched, "
          f"{len(entries) - ok - bad} unresolved")


if __name__ == "__main__":
    main(sys.argv[1])
