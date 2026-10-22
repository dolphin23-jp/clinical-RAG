"""Export a built SQLite DB as plain SQL files for Cloudflare D1.

  python3 -m ingest.export_sql library.sqlite d1/ [--no-trigram] [--books id1,id2]   # writes d1/000_schema.sql, 001_*.sql ..., 999_fts.sql
  for f in d1/*.sql; do npx wrangler d1 execute medbook --remote --file "$f"; done     (--local to test)

With --books, only those books are (re)written in D1 and every other book already there is left alone;
without it the files replace the whole index.

D1 cannot import a binary SQLite file that contains FTS5 virtual tables, so we ship the plain tables as
INSERT statements and rebuild the two FTS indexes inside D1 with INSERT ... SELECT (999_fts.sql).
Re-running is safe: 000_schema.sql drops nothing, and the first data file starts with DELETEs of what it
is about to fill (everything, or just the listed books), so a re-import replaces the previous content.
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

PLAIN_TABLES = ["books", "chapters", "sections", "parents", "chunks", "refs", "chunk_refs", "issues"]
MAX_FILE_BYTES = 3_000_000


def q(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def _in(ids: list[str]) -> str:
    return "(" + ",".join(q(i) for i in ids) + ")"


def export(db_path: str, out_dir: str, trigram: bool = True, only_books: list[str] | None = None) -> list[Path]:
    root = Path(__file__).resolve().parent.parent
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*.sql"):
        old.unlink()
    written: list[Path] = []
    schema = out / "000_schema.sql"
    schema_sql = (root / "schema.sql").read_text(encoding="utf-8")
    if not trigram:  # fallback if a D1 build rejects tokenize='trigram'; search then runs on the bigram index only
        schema_sql = "\n".join(l for l in schema_sql.splitlines() if "chunks_tri" not in l)
    schema.write_text(schema_sql, encoding="utf-8")
    written.append(schema)

    con = sqlite3.connect(db_path)
    part, size, buf = 1, 0, []

    def flush():
        nonlocal part, size, buf
        if not buf:
            return
        p = out / f"{part:03d}_data.sql"
        p.write_text("\n".join(buf) + "\n", encoding="utf-8")
        written.append(p)
        part += 1
        size, buf = 0, []

    ids = only_books
    if ids:
        b_in = _in(ids)
        ch_in = f"(SELECT chapter_id FROM chapters WHERE book_id IN {b_in})"
        ck_in = f"(SELECT chunk_id FROM chunks WHERE book_id IN {b_in})"
        where = {
            "books": f"book_id IN {b_in}",
            "chapters": f"book_id IN {b_in}",
            "sections": f"chapter_id IN {ch_in}",
            "parents": f"book_id IN {b_in}",
            "chunks": f"book_id IN {b_in}",
            "refs": f"chapter_id IN {ch_in}",
            "chunk_refs": f"chunk_id IN {ck_in}",
            "issues": f"chapter_id IN {ch_in}",
        }
        # children first, and the FTS rows before the chunks they point at
        dels = [f"DELETE FROM chunks_bi WHERE chunk_id IN {ck_in};"]
        if trigram:
            dels.insert(0, f"DELETE FROM chunks_tri WHERE chunk_id IN {ck_in};")
        dels += [f"DELETE FROM {t} WHERE {where[t]};" for t in reversed(PLAIN_TABLES)]
        buf.append("\n".join(dels))
    else:
        where = {}
        buf.append("\n".join(f"DELETE FROM {t};" for t in reversed(PLAIN_TABLES)))

    for t in PLAIN_TABLES:
        # issue_id is AUTOINCREMENT: let D1 assign it so a per-book import can never collide with other books' rows
        cols = [r[1] for r in con.execute(f"PRAGMA table_info({t})") if not (t == "issues" and r[1] == "issue_id")]
        col_list = ",".join(cols)
        sel = f"SELECT {col_list} FROM {t}" + (f" WHERE {where[t]}" if ids else "")
        for row in con.execute(sel):
            stmt = f"INSERT INTO {t}({col_list}) VALUES({','.join(q(v) for v in row)});"
            if size + len(stmt) > MAX_FILE_BYTES:
                flush()
            buf.append(stmt)
            size += len(stmt) + 1
    flush()

    fts = out / "999_fts.sql"
    scope = f" WHERE book_id IN {_in(ids)}" if ids else ""
    wipe_tri = "" if ids else "DELETE FROM chunks_tri;\n"
    wipe_bi = "" if ids else "DELETE FROM chunks_bi;\n"
    tri = f"{wipe_tri}INSERT INTO chunks_tri(chunk_id, content) SELECT chunk_id, index_text FROM chunks{scope};\n" if trigram else ""
    fts.write_text(
        tri + f"{wipe_bi}INSERT INTO chunks_bi(chunk_id, content) SELECT chunk_id, bigram FROM chunks{scope};\n",
        encoding="utf-8",
    )
    written.append(fts)
    return written


if __name__ == "__main__":
    argv = sys.argv[1:]
    books = None
    if "--books" in argv:
        i = argv.index("--books")
        books = [b for b in argv[i + 1].split(",") if b]
        del argv[i : i + 2]
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 2:
        sys.exit(__doc__)
    for p in export(args[0], args[1], trigram="--no-trigram" not in argv, only_books=books):
        print(p, p.stat().st_size)
