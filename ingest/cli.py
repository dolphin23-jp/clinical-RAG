"""Usage:
  python3 -m ingest validate [--images-root DIR] [--json] BOOK_ID FILE.md...
  python3 -m ingest build --db OUT.sqlite [--images-root DIR] [--force] BOOK_ID FILE.md...
  python3 -m ingest conversion-log --db OUT.sqlite [--check] BOOK_ID LOG.jsonl     (docs/FORMAT.md section 7)
"""
from __future__ import annotations

import argparse
import json
import sys

from . import conversion_log
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
    cl = sub.add_parser("conversion-log", help="import a conversion log as issues (source = conversion-log)")
    cl.add_argument("book_id")
    cl.add_argument("log")
    cl.add_argument("--db", required=True)
    cl.add_argument("--check", action="store_true", help="read and check the log, print what it would do, write nothing")
    a = ap.parse_args(argv)

    if a.cmd == "conversion-log":
        return _conversion_log(a)

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


def _conversion_log(a) -> int:
    from pathlib import Path

    if not Path(a.db).is_file():
        print(f"{a.db}: no such database (build the book first)", file=sys.stderr)
        return 2
    con = connect(a.db)
    try:
        chapters, texts = conversion_log.read_book(con, a.book_id)
        if not chapters:
            print(f"book {a.book_id} has no chapters in {a.db}", file=sys.stderr)
            return 2
        entries, errors = conversion_log.parse_log(Path(a.log).read_text(encoding="utf-8"), a.book_id, chapters, texts)
        if errors:
            print(f"{a.log}: NOT imported ({len(errors)} problem(s))", file=sys.stderr)
            for e in errors:
                print(f"  {e}", file=sys.stderr)
            return 1
        if a.check:
            counts = {s: sum(1 for e in entries if e.status == s) for s in conversion_log.STATUS}
            print(f"ok: {len(entries)} line(s) {counts} (nothing written)")
            return 0
        counts = conversion_log.apply(con, entries)
        print(f"imported {len(entries)} line(s) for {len({e.chapter_id for e in entries})} chapter(s): {counts}  ({counts['verified']} verified wrote nothing)")
        return 0
    finally:
        con.close()


if __name__ == "__main__":
    sys.exit(main())
