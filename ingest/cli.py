"""Usage:
  python3 -m ingest validate [--images-root DIR] [--json] BOOK_ID FILE.md...
  python3 -m ingest build --db OUT.sqlite [--images-root DIR] [--force] BOOK_ID FILE.md...
"""
from __future__ import annotations

import argparse
import json
import sys

from .build_db import add_chapter, connect
from .parse import parse_chapter
from .validate import summarize, validate


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="ingest")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("validate", "build"):
        p = sub.add_parser(name)
        p.add_argument("book_id")
        p.add_argument("files", nargs="+")
        p.add_argument("--images-root")
        p.add_argument("--json", action="store_true")
        if name == "build":
            p.add_argument("--db", required=True)
            p.add_argument("--force", action="store_true", help="build even if validation reports errors")
    a = ap.parse_args(argv)

    rc = 0
    con = connect(a.db) if a.cmd == "build" else None
    for f in a.files:
        ch = parse_chapter(f, a.book_id)
        issues = validate(ch, a.images_root)
        s = summarize(issues)
        if a.json:
            print(json.dumps({"file": f, "chapter_id": ch.chapter_id, "summary": s, "issues": [i.__dict__ for i in issues]}, ensure_ascii=False))
        else:
            print(f"{ch.chapter_id}  chunks={len(ch.chunks)} refs={len(ch.refs)}  errors={s['error']} warnings={s['warn']} info={s['info']}")
            for i in issues:
                if i.level != "info":
                    print(f"  [{i.level}] {i.code}: {i.message}" + (f"  ({i.chunk_id})" if i.chunk_id else ""))
        if s["error"]:
            rc = 1
        if a.cmd == "build":
            if s["error"] and not a.force:
                print(f"  -> NOT built (errors). Use --force to override.", file=sys.stderr)
                continue
            stats = add_chapter(con, ch, issues)
            print(f"  -> built: {stats}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
