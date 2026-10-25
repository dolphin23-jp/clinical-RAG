"""Conversion log -> the `issues` table (source = 'conversion-log').  docs/FORMAT.md section 7.

A conversion log says, per chapter (or section), how far the transcription was checked against the page images.  The search already carries every
issue whose source is not 'ingest' to the sections it concerns (worker/src/search.ts), so a chapter that was only partly checked, or has an open
mismatch, shows that to the model and to the doctor beside the text it affects — the same way the transcriber's own flags travel.

The log is read in one neutral form (JSON lines, below).  The pipeline that makes the log does not have to produce exactly this: a small mapping step
turns its output into these lines.  Nothing here knows or guesses the pipeline's own format.

    {"chapter": 2, "section": "B", "pages": "12-14", "status": "mismatch", "note": "用量表の1行が原本と不一致（修正待ち）"}

  chapter   the chapter number (2), "ch02", or the full chapter id ("fx:ch02"); it must be a chapter of the book in the database
  section   optional: the section letter ("B"); it must be a section of that chapter.  Without it, the line is about the whole chapter
  pages     optional: printed pages the line is about ("12" or "12-14"), kept in the message only
  status    verified | partial | unverified | mismatch
  note      optional, one line, at most 120 characters: what the reader should know.  Never the book's own text (a note that repeats 20 characters of
            the chapter is refused: this tool must not carry the book's text into a place that is not the book)

`verified` writes nothing (a checked chapter has nothing to warn about; the summary counts it).  The others write one `warn` issue each:
CL_PARTIAL, CL_UNVERIFIED, CL_MISMATCH.  Importing again replaces the conversion-log issues of the chapters the log names (and only those); building a
chapter again (`ingest build`) deletes all of its issues, so the log is imported again after a rebuild.  A log with any problem is refused whole, every
problem listed with its line.
"""
from __future__ import annotations

import json
import re
import sqlite3
import unicodedata
from dataclasses import dataclass

SOURCE = "conversion-log"
NOTE_MAX = 120
OVERLAP_MIN = 20  # a note this long that is found in the chapter's own text is refused
MAX_LINES = 5000
KEYS = {"chapter", "section", "pages", "status", "note"}

#: status -> (level, code, the fixed words).  verified writes no row.
STATUS: dict[str, tuple[str, str, str] | None] = {
    "verified": None,
    "partial": ("warn", "CL_PARTIAL", "変換ログ: 原本との照合は一部だけ"),
    "unverified": ("warn", "CL_UNVERIFIED", "変換ログ: 原本との照合は未実施"),
    "mismatch": ("warn", "CL_MISMATCH", "変換ログ: 原本との不一致が見つかっている（未修正）"),
}


@dataclass
class Entry:
    line: int
    chapter_id: str
    section_id: str | None
    pages: str | None
    status: str
    note: str | None


def _norm(s: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", s))


def chapter_id_of(raw, book_id: str) -> str | None:
    """2 / "2" / "ch02" / "fx:ch02" -> "fx:ch02" (None when it is none of those)."""
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return f"{book_id}:ch{raw:02d}" if 0 < raw < 1000 else None
    if not isinstance(raw, str):
        return None
    s = raw.strip()
    m = re.fullmatch(r"(?:(.+):)?(?:ch)?(\d{1,3})", s)
    if not m or (m.group(1) is not None and m.group(1) != book_id):
        return None
    n = int(m.group(2))
    return f"{book_id}:ch{n:02d}" if n > 0 else None


def parse_log(text: str, book_id: str, chapters: dict[str, set[str]], chapter_texts: dict[str, list[str]] | None = None) -> tuple[list[Entry], list[str]]:
    """The log's entries and every problem found (an empty list of problems = the log can be imported).

    chapters: {chapter_id: {section letters}} of the book in the database.  chapter_texts: {chapter_id: [parent texts]} for the copied-text check."""
    entries: list[Entry] = []
    errors: list[str] = []
    seen: dict[tuple[str, str | None, str | None], tuple[str, int]] = {}
    lines = text.splitlines()
    if len(lines) > MAX_LINES:
        return [], [f"the log has {len(lines)} lines; at most {MAX_LINES}"]
    normed: dict[str, str] = {}
    for no, raw in enumerate(lines, 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        where = f"line {no}"
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as e:
            errors.append(f"{where}: not JSON ({e.msg})")
            continue
        if not isinstance(obj, dict):
            errors.append(f"{where}: each line must be a JSON object")
            continue
        extra = sorted(set(obj) - KEYS)
        if extra:
            errors.append(f"{where}: unknown key(s) {', '.join(extra)} (allowed: {', '.join(sorted(KEYS))})")
            continue
        bad = len(errors)
        cid = chapter_id_of(obj.get("chapter"), book_id)
        if cid is None:
            errors.append(f"{where}: chapter must be a number, chNN or {book_id}:chNN")
        elif cid not in chapters:
            errors.append(f"{where}: chapter {cid} is not in the database (chapters: {', '.join(sorted(chapters)) or 'none'})")
        status = obj.get("status")
        if status not in STATUS:
            errors.append(f"{where}: status must be one of {', '.join(STATUS)}")
        section = obj.get("section")
        section_id = None
        if section is not None:
            if not isinstance(section, str) or not re.fullmatch(r"[A-Za-z0-9]{1,3}", section):
                errors.append(f"{where}: section must be the section letter (A, B, ...)")
            elif cid in chapters:
                if section not in chapters[cid]:
                    errors.append(f"{where}: section {section} is not in {cid} (sections: {', '.join(sorted(chapters[cid]))})")
                else:
                    section_id = f"{cid}:{section}"
        pages = obj.get("pages")
        if pages is not None and not (isinstance(pages, str) and re.fullmatch(r"\d{1,4}(-\d{1,4})?", pages)):
            errors.append(f"{where}: pages must look like 12 or 12-14")
        note = obj.get("note")
        if note is not None:
            if not isinstance(note, str) or not note.strip():
                errors.append(f"{where}: note must be a non-empty string")
            elif len(note) > NOTE_MAX:
                errors.append(f"{where}: note is {len(note)} characters; at most {NOTE_MAX}")
            elif any(unicodedata.category(c).startswith("C") for c in note):
                errors.append(f"{where}: note must be one line without control characters")
            elif chapter_texts and cid in chapter_texts:
                n = _norm(note)
                if len(n) >= OVERLAP_MIN:
                    body = normed.setdefault(cid, _norm("\n".join(chapter_texts[cid])))
                    if n in body:
                        errors.append(f"{where}: note repeats the chapter's own text; say what to check, not what the book says")
        if len(errors) > bad:
            continue
        key = (cid, section_id, pages)
        if key in seen and seen[key][0] != status:
            errors.append(f"{where}: {cid}{'/' + section if section else ''}{' p.' + pages if pages else ''} is both {seen[key][0]} (line {seen[key][1]}) and {status}")
            continue
        seen[key] = (status, no)
        entries.append(Entry(no, cid, section_id, pages, status, note.strip() if note else None))
    if not entries and not errors:
        errors.append("the log has no entries")
    return entries, errors


def message_of(e: Entry) -> str:
    base = STATUS[e.status][2]  # type: ignore[index]
    return base + (f"（p.{e.pages}）" if e.pages else "") + (f"：{e.note}" if e.note else "")


def read_book(con: sqlite3.Connection, book_id: str) -> tuple[dict[str, set[str]], dict[str, list[str]]]:
    """{chapter_id: {section letters}} and {chapter_id: [parent texts]} of one book."""
    chapters: dict[str, set[str]] = {}
    for (cid,) in con.execute("SELECT chapter_id FROM chapters WHERE book_id = ?", (book_id,)):
        chapters[cid] = set()
    for cid, letter in con.execute("SELECT s.chapter_id, s.letter FROM sections s JOIN chapters c ON c.chapter_id = s.chapter_id WHERE c.book_id = ?", (book_id,)):
        chapters.setdefault(cid, set()).add(letter)
    texts: dict[str, list[str]] = {}
    for cid, t in con.execute("SELECT p.chapter_id, p.text FROM parents p JOIN chapters c ON c.chapter_id = p.chapter_id WHERE c.book_id = ?", (book_id,)):
        texts.setdefault(cid, []).append(t)
    return chapters, texts


def apply(con: sqlite3.Connection, entries: list[Entry]) -> dict[str, int]:
    """Replace the conversion-log issues of the chapters the log names; add one warn per partial / unverified / mismatch line.  One transaction."""
    counts = {s: 0 for s in STATUS}
    chapters = sorted({e.chapter_id for e in entries})
    with con:
        for cid in chapters:
            con.execute("DELETE FROM issues WHERE source = ? AND chapter_id = ?", (SOURCE, cid))
        for e in entries:
            counts[e.status] += 1
            row = STATUS[e.status]
            if row is None:
                continue
            con.execute(
                "INSERT INTO issues(chapter_id, chunk_id, section_id, level, code, message, source) VALUES (?, NULL, ?, ?, ?, ?, ?)",
                (e.chapter_id, e.section_id, row[0], row[1], message_of(e), SOURCE),
            )
    return counts
