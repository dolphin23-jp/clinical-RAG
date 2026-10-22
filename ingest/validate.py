"""Ingest-time validation.  Goal: catch transcription/format problems BEFORE they become
confidently-cited wrong answers.  `error` issues fail the ingest (unless --force)."""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from .parse import Chapter

# Phrases transcribers use to flag doubt.  Extend freely; each hit becomes an `info`/`warn` issue
# that travels with the affected section/chunk and is shown to the model + the user.
FLAG_PATTERNS = ["要確認", "疑い", "不整合", "判読", "字形", "誤植", "原文ママ", "読み取れ", "不鮮明"]


@dataclass
class Issue:
    level: str  # error | warn | info
    code: str
    message: str
    chunk_id: str | None = None
    section: str | None = None
    source: str = "ingest"


def validate(ch: Chapter, images_root: str | Path | None = None) -> list[Issue]:
    out: list[Issue] = []

    # --- unique ids / empty text -------------------------------------------------
    seen = set()
    for c in ch.chunks:
        if c.chunk_id in seen:
            out.append(Issue("error", "E_DUP_ID", f"duplicate chunk id {c.chunk_id}", c.chunk_id))
        seen.add(c.chunk_id)
        if not c.text.strip():
            out.append(Issue("error", "E_EMPTY_CHUNK", "empty chunk text", c.chunk_id, c.section))

    # --- pages ---------------------------------------------------------------------
    last_end: dict[str, int] = {}
    for c in ch.chunks:
        letter = c.section.split()[0] if c.section.split() else ""
        if c.page_start is None:
            out.append(Issue("error", "E_NO_PAGE", f"no page for chunk ({c.kind}) under {' > '.join(c.path)}", c.chunk_id, c.section))
            continue
        sec = ch.sections.get(letter)
        if sec and sec.fm_start is not None and (c.page_start < sec.fm_start or (c.page_end or c.page_start) > sec.fm_end):
            out.append(
                Issue(
                    "error",
                    "E_PAGE_OUT_OF_RANGE",
                    f"{c.page_label} is outside section {letter} range p.{sec.fm_start}-{sec.fm_end} declared in frontmatter",
                    c.chunk_id,
                    c.section,
                )
            )
        # compare START pages: a chunk may legitimately span pages (p.3-4) right after one ending at p.4
        prev = last_end.get(letter)
        if prev is not None and c.page_start < prev:
            out.append(
                Issue(
                    "warn",
                    "W_PAGE_REGRESSION",
                    f"page start goes back from p.{prev} to {c.page_label} ({c.kind}); check page marker or figure placement",
                    c.chunk_id,
                    c.section,
                )
            )
        last_end[letter] = max(prev or 0, c.page_start)

    # --- citations -----------------------------------------------------------------
    ref_labels: dict[str, set[str]] = {}
    for r in ch.refs:
        ref_labels.setdefault(r.section, set()).add(r.label)
    foot_defs: dict[str, set[str]] = {}
    for c in ch.chunks:
        for m in re.finditer(r"(?m)^(注\d+)\)", c.text):
            foot_defs.setdefault(c.section, set()).add(m.group(1))
    for c in ch.chunks:
        if c.kind == "references":
            continue
        for lab in c.cites:
            if lab.startswith("注"):
                if lab not in foot_defs.get(c.section, set()):
                    out.append(Issue("warn", "W_FOOTNOTE_UNRESOLVED", f"footnote {lab} has no definition in section", c.chunk_id, c.section))
            elif lab not in ref_labels.get(c.section, set()):
                out.append(Issue("warn", "W_CITE_UNRESOLVED", f"citation {lab}) has no entry in this section's references", c.chunk_id, c.section))

    # --- images ----------------------------------------------------------------------
    for c in ch.chunks:
        if c.kind == "figure" and c.image:
            if images_root is None:
                out.append(Issue("info", "I_IMAGE_UNCHECKED", f"{c.figure_id}: image {c.image} not checked (no --images-root)", c.chunk_id, c.section))
            elif not (Path(images_root) / c.image).exists():
                out.append(Issue("error", "E_IMAGE_MISSING", f"{c.figure_id}: image file {c.image} not found under {images_root}", c.chunk_id, c.section))

    # --- tables ----------------------------------------------------------------------
    for c in ch.chunks:
        if c.kind != "table":
            continue
        cols = set()
        for row in c.text.splitlines():
            if row.strip().startswith("|") and not re.fullmatch(r"\|[\s:\-|]+\|", row.strip()):
                cols.add(len([p for p in re.split(r"(?<!\\)\|", row.strip())[1:-1]]))
        if len(cols) > 1:
            out.append(Issue("warn", "W_TABLE_COLS", f"table has inconsistent column counts {sorted(cols)}", c.chunk_id, c.section))

    # --- frontmatter vs found sections -----------------------------------------------
    fm_letters = {k for k, v in ch.sections.items() if v.fm_start is not None}
    found = {c.section.split()[0] for c in ch.chunks if c.section.split()}
    if fm_letters - found:
        out.append(Issue("error", "E_SECTION_MISSING", f"sections declared in frontmatter but not found in body: {sorted(fm_letters - found)}"))
    if found - fm_letters:
        out.append(Issue("warn", "W_SECTION_UNDECLARED", f"sections found in body but not in frontmatter: {sorted(found - fm_letters)}"))
    for k, v in ch.sections.items():
        if k in found and not v.author:
            out.append(Issue("warn", "W_NO_AUTHOR", f"section {k} has no author trailer", None, v.title))
    if len(ch.h1_styles) > 1:
        out.append(Issue("info", "I_H1_STYLE_MIXED", f"H1 spelling differs between sections ({ch.h1_styles}); parser handles both, but fix the source pipeline"))

    # --- reliability and transcriber flags ---------------------------------------------
    rel = str(ch.meta.get("text_reliability", ""))
    if rel:
        lvl = "warn" if "未実施" in rel or "未確認" in rel else "info"
        out.append(Issue(lvl, "W_RELIABILITY" if lvl == "warn" else "I_RELIABILITY", f"frontmatter text_reliability: {rel}"))
    for letter, sec in ch.sections.items():
        for note in sec.transcription_notes:
            for pat in FLAG_PATTERNS:
                for m in re.finditer(pat, note):
                    a, b = max(0, m.start() - 40), min(len(note), m.end() + 40)
                    out.append(Issue("info", "I_TRANSCRIBER_FLAG", f"[{letter}] …{note[a:b]}…", None, sec.title))
    for c in ch.chunks:
        if c.transcriber_note:
            out.append(Issue("info", "I_CHUNK_NOTE", c.transcriber_note[:160], c.chunk_id, c.section))
    return out


def summarize(issues: list[Issue]) -> dict[str, int]:
    s = {"error": 0, "warn": 0, "info": 0}
    for i in issues:
        s[i.level] = s.get(i.level, 0) + 1
    return s
