#!/usr/bin/env python3
"""Import EbookText Studio books (BASE/<book>/output/全文.md) into the medbook D1 database.

  python scripts/import_ebooktextstudio.py "C:\\Users\\you\\Documents\\EbookTextStudio"            # dry run: convert, build, write SQL
  python scripts/import_ebooktextstudio.py BASE --push                                          # ...and send it to Cloudflare D1
  python scripts/import_ebooktextstudio.py BASE --only "書名A,書名B" --push               # just these books
  python scripts/import_ebooktextstudio.py BASE --target local --push                           # into the local wrangler dev DB

Per book: ingest.ocr_convert -> ingest build -> ingest.export_sql scoped to that book, so importing or
re-importing one book never touches the others already in D1.  Needs only Python 3 + PyYAML here; `--push`
also needs Node (npx wrangler, logged in once with `npx wrangler login`).

Folders without the page-end markers of the current EbookText Studio (older exports) are skipped with a
message: re-export them first.  `scrolltest*` and `医学書サンプル` are skipped unless named in --only.
Book ids are derived from the folder name (stable).  Optional BASE/books.json to choose ids/titles:
  {"フォルダ名": {"id": "my-id", "title": "表示する書名"}}
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ingest.build_db import add_chapter, connect  # noqa: E402
from ingest.export_sql import export  # noqa: E402
from ingest.ocr_convert import convert  # noqa: E402
from ingest.parse import parse_chapter  # noqa: E402
from ingest.validate import summarize, validate  # noqa: E402

SKIP_PREFIXES = ("scrolltest", "医学書サンプル")


def book_id_for(name: str, overrides: dict) -> str:
    if name in overrides and overrides[name].get("id"):
        return overrides[name]["id"]
    return "b-" + hashlib.sha1(name.encode("utf-8")).hexdigest()[:8]  # stable per folder name, so re-imports replace the same book


def ensure_wrangler_login(npx: str, wdir: Path) -> int:
    """Make sure wrangler can talk to Cloudflare; if it is not logged in, run the browser login (once per PC)."""
    if os.environ.get("CLOUDFLARE_API_TOKEN"):
        return 0

    def whoami() -> tuple[int, str]:
        r = subprocess.run([npx, "wrangler", "whoami"], cwd=wdir, capture_output=True, text=True, encoding="utf-8", errors="replace")
        return r.returncode, (r.stdout or "") + (r.stderr or "")

    rc, out = whoami()
    if rc == 0 and "not authenticated" not in out.lower():
        return 0
    print("\nCloudflare にまだログインしていません。ブラウザが開くので、Cloudflare にログインして『Allow（許可）』を押してください。")
    print("(wrangler is not logged in: running `npx wrangler login` — approve it in the browser window that opens)\n")
    r = subprocess.run([npx, "wrangler", "login"], cwd=wdir)
    if r.returncode:
        print("wrangler login failed; run `npx wrangler login` in the worker folder and re-run this script.", file=sys.stderr)
        return r.returncode
    rc, out = whoami()
    if rc != 0 or "not authenticated" in out.lower():
        print("still not logged in to Cloudflare:\n" + out, file=sys.stderr)
        return rc or 4
    return 0


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):  # Windows consoles default to a legacy code page
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("base", help="EbookText Studio folder that contains one folder per book")
    ap.add_argument("--only", help="comma-separated folder names (default: every book folder)")
    ap.add_argument("--work", default=str(ROOT / "work"), help="where converted files, the SQLite file and the SQL go")
    ap.add_argument("--section-chars", type=int, default=20000)
    ap.add_argument("--push", action="store_true", help="run wrangler d1 execute for the generated SQL files")
    ap.add_argument("--target", choices=["remote", "local"], default="remote")
    ap.add_argument("--db-name", default="medbook", help="D1 database name in worker/wrangler.jsonc")
    a = ap.parse_args()

    base = Path(a.base)
    overrides = {}
    if (base / "books.json").exists():
        overrides = json.loads((base / "books.json").read_text(encoding="utf-8"))
    wanted = [x.strip() for x in a.only.split(",")] if a.only else None
    dirs = sorted(p for p in base.iterdir() if p.is_dir() and (p / "output" / "全文.md").exists())
    if wanted:
        missing = [w for w in wanted if not any(d.name == w for d in dirs)]
        if missing:
            print(f"not found under {base}: {missing}", file=sys.stderr)
            return 2
        dirs = [d for d in dirs if d.name in wanted]
    else:
        dirs = [d for d in dirs if not d.name.startswith(SKIP_PREFIXES)]
    if not dirs:
        print("no book folders with output/全文.md found", file=sys.stderr)
        return 2

    work = Path(a.work)
    work.mkdir(parents=True, exist_ok=True)
    db = work / "library.sqlite"
    if db.exists():
        db.unlink()
    con = connect(str(db))
    done: list[str] = []
    for d in dirs:
        bid = book_id_for(d.name, overrides)
        title = overrides.get(d.name, {}).get("title", d.name)
        try:
            text, st = convert(d, title, a.section_chars)
        except SystemExit as e:
            print(f"SKIP  {d.name}: {e}\n      (older EbookText Studio export: re-export this book with the current version)")
            continue
        out = work / bid / "chapter.md"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        ch = parse_chapter(out, bid)
        issues = validate(ch)
        s = summarize(issues)
        if s["error"]:
            print(f"SKIP  {d.name}: {s['error']} validation error(s); see `python -m ingest validate {bid} {out}`")
            continue
        add_chapter(con, ch, issues)
        done.append(bid)
        rough = st["gaps_range"] + st["gaps_shifted_by_1to3"]
        print(
            f"OK    {d.name}  id={bid}  chunks={len(ch.chunks)}  pages={st['pages']}  "
            f"page markers kept {st['markers_kept']}/{st['markers_kept'] + len(st['markers_dropped'])}"
            + (f"  ({rough} page gap(s) only known to a range)" if rough else "")
        )
    con.close()
    if not done:
        print("nothing to import", file=sys.stderr)
        return 1

    sql_dir = work / "d1"
    files = export(str(db), str(sql_dir), only_books=done)
    total = sum(f.stat().st_size for f in files)
    print(f"\nSQL: {len(files)} files, {total / 1e6:.1f} MB in {sql_dir}")

    flag = "--remote" if a.target == "remote" else "--local"
    cmds = [["wrangler", "d1", "execute", a.db_name, flag, "--yes", "--file", str(f)] for f in files]
    if not a.push:
        print("\nDry run only.  To send it to D1 (from the worker folder, after `npm ci` and `npx wrangler login`):")
        for c in cmds:
            print("  npx " + " ".join(f'"{x}"' if " " in x else x for x in c))
        print("or re-run this script with --push.")
        return 0

    npx = shutil.which("npx")
    if not npx:
        print("npx not found: install Node.js (https://nodejs.org) and re-run", file=sys.stderr)
        return 3
    wdir = ROOT / "worker"
    if not (wdir / "node_modules").exists():
        print("installing worker dependencies (npm ci)…")
        subprocess.run([shutil.which("npm") or "npm", "ci"], cwd=wdir, check=True)
    if a.target == "remote":
        rc = ensure_wrangler_login(npx, wdir)
        if rc:
            return rc
    for i, c in enumerate(cmds, 1):
        print(f"[{i}/{len(cmds)}] {Path(c[-1]).name}")
        # No CI=1 here: that makes wrangler non-interactive, and it then refuses to use a browser login
        # (it asks for CLOUDFLARE_API_TOKEN instead).  --yes already skips the confirmation prompt.
        r = subprocess.run([npx, *c], cwd=wdir)
        if r.returncode:
            print(f"wrangler failed on {c[-1]} (exit {r.returncode}). Re-running the script is safe: it replaces these books.", file=sys.stderr)
            return r.returncode
    print("\nimported:", ", ".join(done))
    return 0


if __name__ == "__main__":
    sys.exit(main())
