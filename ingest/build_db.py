"""Build / update the SQLite database from parsed chapters."""
from __future__ import annotations

import re
import sqlite3
import unicodedata
from pathlib import Path

from .parse import Chapter, Chunk
from .tokenize import bigram_text, clean_for_index
from .validate import Issue

SCHEMA = (Path(__file__).resolve().parent.parent / "schema.sql").read_text(encoding="utf-8")
AID_LABEL = "［転写者補助・原本の記述ではない］"


def index_text(c: Chunk) -> str:
    t = clean_for_index(" ".join(c.path) + "\n" + c.text)
    return unicodedata.normalize("NFKC", t)


def compose_parent_text(chunks: list[Chunk], parent_key: tuple[str, ...]) -> str:
    out: list[str] = [f"【{' > '.join(parent_key)}】"]
    prev_path = parent_key
    last_page: int | None = None
    for c in chunks:
        if c.path != prev_path:
            for depth in range(len(parent_key), len(c.path)):
                if depth >= len(prev_path) or prev_path[depth] != c.path[depth]:
                    out.append(f"■ {c.path[depth]}")
            prev_path = c.path
        if c.page_start is not None and c.page_start != last_page:
            out.append(f"［{c.page_label}］")
            last_page = c.page_start
        out.append((AID_LABEL + "\n" if c.provenance == "transcriber" else "") + c.text)
    return "\n".join(out)


def connect(db_path: str | Path) -> sqlite3.Connection:
    con = sqlite3.connect(str(db_path))
    con.executescript(SCHEMA)
    return con


def delete_chapter(con: sqlite3.Connection, chapter_id: str) -> None:
    ids = [r[0] for r in con.execute("SELECT chunk_id FROM chunks WHERE chapter_id=?", (chapter_id,))]
    for i in range(0, len(ids), 500):
        part = ids[i : i + 500]
        q = ",".join("?" * len(part))
        con.execute(f"DELETE FROM chunks_tri WHERE chunk_id IN ({q})", part)
        con.execute(f"DELETE FROM chunks_bi WHERE chunk_id IN ({q})", part)
        con.execute(f"DELETE FROM chunk_refs WHERE chunk_id IN ({q})", part)
    for t in ("chunks", "parents", "refs", "sections", "issues"):
        con.execute(f"DELETE FROM {t} WHERE chapter_id=?", (chapter_id,))
    con.execute("DELETE FROM chapters WHERE chapter_id=?", (chapter_id,))


def add_chapter(con: sqlite3.Connection, ch: Chapter, issues: list[Issue]) -> dict:
    delete_chapter(con, ch.chapter_id)
    con.execute(
        "INSERT INTO books(book_id,title,edition,publisher,pub_year) VALUES(?,?,?,?,?) "
        "ON CONFLICT(book_id) DO UPDATE SET title=excluded.title, edition=excluded.edition, "
        "publisher=excluded.publisher, pub_year=excluded.pub_year",
        (ch.book_id, ch.book_title, ch.edition, ch.publisher, ch.pub_year),
    )
    con.execute(
        "INSERT INTO chapters VALUES(?,?,?,?,?,?,?,?,?)",
        (
            ch.chapter_id,
            ch.book_id,
            ch.chapter_no,
            ch.chapter_title,
            ch.page_start,
            ch.page_end,
            str(ch.meta.get("source_format", "")),
            str(ch.meta.get("text_reliability", "")),
            str(ch.meta.get("notes", "")),
        ),
    )
    for letter, s in ch.sections.items():
        con.execute(
            "INSERT INTO sections VALUES(?,?,?,?,?,?,?,?)",
            (f"{ch.chapter_id}:{letter}", ch.chapter_id, letter, s.title, s.fm_start, s.fm_end, s.author, "\n".join(s.transcription_notes)),
        )

    # references first (chunk_refs needs ids)
    ref_ids: dict[tuple[str, str], str] = {}
    for n, r in enumerate(ch.refs, 1):
        letter = r.section.split()[0] if r.section.split() else ""
        rid = f"{ch.chapter_id}:r{n:03d}"
        ref_ids[(letter, r.label)] = rid
        con.execute(
            "INSERT INTO refs VALUES(?,?,?,?,?,?,?)",
            (rid, ch.chapter_id, f"{ch.chapter_id}:{letter}", r.label, r.text, r.pmid, r.page_start),
        )

    by_parent: dict[str, list[Chunk]] = {}
    for c in ch.chunks:
        by_parent.setdefault(c.parent_id, []).append(c)

    for pid, cs in by_parent.items():
        cs_body = [c for c in cs if c.kind != "references"]
        use = cs_body or cs
        key = use[0].parent_key
        text = compose_parent_text(use, key)
        pages = [p for c in use for p in (c.page_start, c.page_end) if p is not None]
        letter = use[0].section.split()[0] if use[0].section.split() else ""
        con.execute(
            "INSERT INTO parents VALUES(?,?,?,?,?,?,?,?,?)",
            (pid, ch.chapter_id, ch.book_id, f"{ch.chapter_id}:{letter}", " > ".join(key), min(pages, default=None), max(pages, default=None), text, len(text)),
        )

    for c in ch.chunks:
        letter = c.section.split()[0] if c.section.split() else ""
        it = index_text(c)
        crit = 1 if (c.kind != "references" and {"dose_unit", "lab_threshold"} & set(c.numeric_flags)) else 0
        con.execute(
            "INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                c.chunk_id,
                ch.chapter_id,
                ch.book_id,
                c.seq,
                c.parent_id,
                f"{ch.chapter_id}:{letter}",
                " > ".join(c.path),
                c.kind,
                c.provenance,
                c.page_start,
                c.page_end,
                c.page_label,
                c.text,
                it,
                bigram_text(it),
                c.figure_id,
                c.image,
                c.author,
                crit,
                ",".join(c.numeric_flags),
                c.transcriber_note,
            ),
        )
        for lab in c.cites:
            rid = ref_ids.get((letter, lab))
            if rid and c.kind != "references":
                con.execute("INSERT OR IGNORE INTO chunk_refs VALUES(?,?)", (c.chunk_id, rid))

    for i in issues:
        sec = None
        if i.section:
            m = re.match(r"^([A-Za-z0-9]{1,3})\b", i.section)
            sec = f"{ch.chapter_id}:{m.group(1)}" if m else None
        con.execute(
            "INSERT INTO issues(chapter_id,chunk_id,section_id,level,code,message,source) VALUES(?,?,?,?,?,?,?)",
            (ch.chapter_id, i.chunk_id, sec, i.level, i.code, i.message, i.source),
        )

    rebuild_fts(con, ch.chapter_id)
    con.commit()
    return {
        "chunks": len(ch.chunks),
        "parents": len(by_parent),
        "refs": len(ch.refs),
    }


def rebuild_fts(con: sqlite3.Connection, chapter_id: str) -> None:
    con.execute(
        "INSERT INTO chunks_tri(chunk_id, content) SELECT chunk_id, index_text FROM chunks WHERE chapter_id=?",
        (chapter_id,),
    )
    con.execute(
        "INSERT INTO chunks_bi(chunk_id, content) SELECT chunk_id, bigram FROM chunks WHERE chapter_id=?",
        (chapter_id,),
    )
