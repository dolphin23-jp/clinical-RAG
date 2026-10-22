"""Export a built SQLite DB as plain SQL files for Cloudflare D1.

  python3 -m ingest.export_sql library.sqlite d1/ [--no-trigram]   # writes d1/000_schema.sql, 001_*.sql ..., 999_fts.sql
  for f in d1/*.sql; do npx wrangler d1 execute medbook --remote --file "$f"; done     (--local to test)

D1 cannot import a binary SQLite file that contains FTS5 virtual tables, so we ship the plain tables as
INSERT statements and rebuild the two FTS indexes inside D1 with INSERT ... SELECT (999_fts.sql).
Re-running is safe: 000_schema.sql drops nothing, and each data file starts with DELETEs of the
tables it fills, so a full re-import replaces the previous content.
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


def export(db_path: str, out_dir: str, trigram: bool = True) -> list[Path]:
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

    # wipe first so re-imports replace content (FTS tables are cleared in 999_fts.sql)
    buf.append("\n".join(f"DELETE FROM {t};" for t in reversed(PLAIN_TABLES)))
    for t in PLAIN_TABLES:
        cols = [r[1] for r in con.execute(f"PRAGMA table_info({t})")]
        col_list = ",".join(cols)
        for row in con.execute(f"SELECT {col_list} FROM {t}"):
            stmt = f"INSERT INTO {t}({col_list}) VALUES({','.join(q(v) for v in row)});"
            if size + len(stmt) > MAX_FILE_BYTES:
                flush()
            buf.append(stmt)
            size += len(stmt) + 1
    flush()

    fts = out / "999_fts.sql"
    tri = (
        "DELETE FROM chunks_tri;\nINSERT INTO chunks_tri(chunk_id, content) SELECT chunk_id, index_text FROM chunks;\n" if trigram else ""
    )
    fts.write_text(
        tri + "DELETE FROM chunks_bi;\nINSERT INTO chunks_bi(chunk_id, content) SELECT chunk_id, bigram FROM chunks;\n",
        encoding="utf-8",
    )
    written.append(fts)
    return written


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 2:
        sys.exit(__doc__)
    for p in export(args[0], args[1], trigram="--no-trigram" not in sys.argv):
        print(p, p.stat().st_size)
