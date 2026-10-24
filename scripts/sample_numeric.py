#!/usr/bin/env python3
"""Measure how often numbers (doses, thresholds) were transcribed wrongly (docs/enhancement-plan.md T1-7).

Two steps. The doctor compares each row with the page image in between; nothing here judges correctness.

  # 1. draw a worksheet from the deployed D1 (needs `npx wrangler login` once, as for the importer)
  python scripts/sample_numeric.py sample --d1 medbook
  #    ...or from a local SQLite built by `python -m ingest build` / the importer (only the books in that file)
  python scripts/sample_numeric.py sample --db work/library.sqlite

  # 2. fill the columns 判定 / 正しい表記 / 誤りの種類 / 頁ずれ in Excel or Numbers, save as CSV, then
  python scripts/sample_numeric.py report work/numeric_sample.csv

Sampling: chunks flagged numeric_critical (book text only: no transcriber aids, no reference lists), split evenly
across books, then between the dose flag and the lab-threshold flag, with a fixed seed. Inside each chunk, every
"number + unit" or "number with a comparison" (<, 以上, 未満 ...) becomes one row, with the text around it so the
place can be found on the page. Bare numbers (page or figure numbers, years, list numbers) are not rows.

The worksheet holds short excerpts of the books, which are copyrighted: it is written under work/ (gitignored) or
outside the repository, never elsewhere in it. Excel-friendly UTF-8 (with BOM).
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import random
import re
import shutil
import sqlite3
import subprocess
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from typing import Callable, Iterable

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "work" / "numeric_sample.csv"

# ----------------------------------------------------------------------------- number expressions
_NUM = r"\d+(?:[.,]\d+)?"
_RANGE = rf"{_NUM}(?:\s*[-–〜~～]\s*{_NUM})?"
_UNIT_BASE = (
    r"μg|µg|mcg|ug|mg|ng|kg|g|mEq|mmol|μmol|µmol|mOsm|mosm|IU|単位|mL|ml|dL|dl|L|mmHg|Torr|%|倍|回|錠|アンプル|バイアル|"
    r"時間|分|秒|日|週|hr|h|min|sec"
)
_UNIT_DEN = r"kg|日|時間|時|分|min|hr|h|dL|dl|L|mL|ml|回|day|m2|m²|μL|µL|uL|mm3|mm³|1\.73\s*m2|1\.73\s*m²"
_UNIT = rf"(?:{_UNIT_BASE})(?![A-Za-z])(?:\s*/\s*(?:{_UNIT_DEN})(?![A-Za-z]))*"
_CMP_BEFORE = r"[≧≦≥≤<>＜＞]"
_CMP_AFTER = r"以上|以下|未満|超"
EXPR = re.compile(
    # the number must not continue a word or another number ("HCO3- 18" is not a range 3-18; "SpO2" is not a 2)
    rf"(?P<before>{_CMP_BEFORE}\s*)?(?P<num>(?<![A-Za-z0-9.,]){_RANGE})\s*(?P<unit>{_UNIT})?(?:\s*(?P<after>{_CMP_AFTER}))?",
)
CONTEXT = 40


def number_expressions(text: str) -> list[tuple[int, int, str]]:
    """(start, end, expression) for every number with a unit or a comparison, in NFKC-normalised text."""
    out = []
    for m in EXPR.finditer(text):
        if not (m.group("unit") or m.group("before") or m.group("after")):
            continue
        s, e = m.start(), m.end()
        e = s + len(text[s:e].rstrip())  # `\s*` before an absent unit must not widen the span
        prev = text[max(0, s - 4) : s]
        # a page / figure / table / reference number is not a dose or a threshold
        if re.search(r"(p\.|P\.|頁|図|表|第|PMID:?\s*)$", prev):
            continue
        out.append((s, e, text[s:e].strip()))
    return out


def norm(text: str) -> str:
    return unicodedata.normalize("NFKC", text)


# ----------------------------------------------------------------------------- reading chunks
Row = dict

LIST_SQL = (
    "SELECT c.chunk_id AS chunk_id, c.book_id AS book_id, c.numeric_flags AS flags FROM chunks c "
    "WHERE c.numeric_critical = 1 AND c.provenance = 'book' AND c.kind NOT IN ('references', 'figure_aid')"
)
DETAIL_SQL = (
    "SELECT c.chunk_id AS chunk_id, c.book_id AS book_id, b.title AS book_title, c.page_label AS page_label, "
    "c.page_start AS page_start, c.page_end AS page_end, c.numeric_flags AS flags, c.path AS path, c.text AS text "
    "FROM chunks c JOIN books b ON b.book_id = c.book_id WHERE c.chunk_id IN ({ids})"
)
SAFE_ID = re.compile(r"^[A-Za-z0-9._:\-]{1,120}$")


class SqliteSource:
    def __init__(self, path: str):
        if not Path(path).exists():
            raise SystemExit(f"not found: {path}")
        self.con = sqlite3.connect(path)
        self.con.row_factory = sqlite3.Row

    def query(self, sql: str) -> list[Row]:
        return [dict(r) for r in self.con.execute(sql)]


class D1Source:
    """Reads the deployed D1 through `npx wrangler d1 execute --remote --json` (run from worker/)."""

    def __init__(self, name: str, runner: Callable[[list[str]], str] | None = None):
        self.name = name
        self.runner = runner or self._run

    @staticmethod
    def _run(args: list[str]) -> str:
        npx = shutil.which("npx")
        if not npx:
            raise SystemExit("npx not found: install Node.js, run `npm ci` and `npx wrangler login` in worker/ first")
        r = subprocess.run([npx, *args], cwd=ROOT / "worker", capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode:
            raise SystemExit(f"wrangler failed (exit {r.returncode}). Logged in? (`npx wrangler login` in worker/)\n{r.stderr[-800:]}")
        return r.stdout

    def query(self, sql: str) -> list[Row]:
        out = self.runner(["wrangler", "d1", "execute", self.name, "--remote", "--json", "--command", sql])
        start = out.find("[")
        if start < 0:
            raise SystemExit(f"unexpected wrangler output: {out[:300]}")
        data = json.loads(out[start:])
        rows: list[Row] = []
        for block in data:
            rows.extend(block.get("results") or [])
        return rows


def fetch_details(source, ids: list[str]) -> list[Row]:
    bad = [i for i in ids if not SAFE_ID.match(i)]
    if bad:
        raise SystemExit(f"unexpected chunk ids: {bad[:3]}")
    rows: list[Row] = []
    for i in range(0, len(ids), 50):  # stay well under statement-size limits
        part = ids[i : i + 50]
        rows.extend(source.query(DETAIL_SQL.format(ids=",".join("'" + x + "'" for x in part))))
    order = {cid: n for n, cid in enumerate(ids)}
    return sorted(rows, key=lambda r: order.get(r["chunk_id"], 0))


# ----------------------------------------------------------------------------- sampling
def primary_flag(flags: str | None) -> str:
    f = set((flags or "").split(","))
    return "dose_unit" if "dose_unit" in f else "lab_threshold"


def allocate(total: int, sizes: dict[str, int]) -> dict[str, int]:
    """Split `total` as evenly as possible across keys, never more than a key has; leftovers go to keys with room."""
    alloc = {k: 0 for k in sizes}
    remaining = min(total, sum(sizes.values()))
    keys = sorted(sizes)
    while remaining > 0:
        room = [k for k in keys if alloc[k] < sizes[k]]
        if not room:
            break
        share = max(1, remaining // len(room))
        for k in room:
            take = min(share, sizes[k] - alloc[k], remaining)
            alloc[k] += take
            remaining -= take
            if remaining == 0:
                break
    return alloc


def draw(candidates: list[Row], n_chunks: int, seed: int) -> list[str]:
    """Stratified draw: even across books, then even across the two flags inside each book."""
    rng = random.Random(seed)
    by_book: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    for r in sorted(candidates, key=lambda r: r["chunk_id"]):
        by_book[r["book_id"]][primary_flag(r.get("flags"))].append(r["chunk_id"])
    per_book = allocate(n_chunks, {b: sum(len(v) for v in f.values()) for b, f in by_book.items()})
    picked: list[str] = []
    for book in sorted(by_book):
        strata = by_book[book]
        per_flag = allocate(per_book[book], {f: len(ids) for f, ids in strata.items()})
        for flag in sorted(strata):
            picked.extend(rng.sample(strata[flag], per_flag[flag]))
    return picked


HEADER = [
    "番号", "書籍ID", "書名", "頁", "旗", "数値", "前後の文（【】が対象）", "章節",
    "判定", "正しい表記", "誤りの種類", "頁ずれ", "メモ", "チャンクID",
]
FILL_HELP = (
    "判定: 一致 / 誤り / 判定不能 ・ 誤りの種類: 桁 / 小数点 / 単位 / 範囲 / 記号 / その他 ・ "
    "頁ずれ: はい（数値がこの頁になかった）/ いいえ"
)


def worksheet_rows(chunks: list[Row], per_chunk: int) -> list[list[str]]:
    rows: list[list[str]] = []
    for ch in chunks:
        text = norm(ch["text"] or "")
        seen: set[str] = set()
        taken = 0
        for s, e, expr in number_expressions(text):
            if expr in seen:
                continue
            seen.add(expr)
            ctx = (text[max(0, s - CONTEXT) : s] + "【" + text[s:e] + "】" + text[e : e + CONTEXT]).replace("\n", " ")
            rows.append([
                f"N{len(rows) + 1:03d}", ch["book_id"], ch.get("book_title") or "", ch.get("page_label") or "",
                primary_flag(ch.get("flags")), expr, ctx, ch.get("path") or "",
                "", "", "", "", "", ch["chunk_id"],
            ])
            taken += 1
            if taken >= per_chunk:
                break
    return rows


def check_out_path(out: Path) -> None:
    """Book excerpts must stay out of git: under work/ (gitignored) or outside the repository."""
    out = out.resolve()
    try:
        rel = out.relative_to(ROOT)
    except ValueError:
        return
    if rel.parts[:1] != ("work",):
        raise SystemExit(f"refusing to write book excerpts to {rel}: use work/ (gitignored) or a folder outside the repository")


def cmd_sample(a: argparse.Namespace, source=None) -> int:
    if source is None:
        if bool(a.db) == bool(a.d1):
            raise SystemExit("give exactly one of --db PATH or --d1 NAME")
        source = SqliteSource(a.db) if a.db else D1Source(a.d1)
    out = Path(a.out)
    check_out_path(out)
    cands = source.query(LIST_SQL)
    if a.books:
        keep = set(a.books.split(","))
        cands = [r for r in cands if r["book_id"] in keep]
    if not cands:
        print("no numeric_critical chunks found", file=sys.stderr)
        return 1
    ids = draw(cands, a.chunks, a.seed)
    rows = worksheet_rows(fetch_details(source, ids), a.per_chunk)
    empty = len(set(ids) - {r[-1] for r in rows})
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(HEADER)
        w.writerows(rows)
    books = Counter(r[1] for r in rows)
    print(f"{len(rows)} rows from {len(ids)} chunks ({len(cands)} candidates) -> {out}")
    if empty:
        print(f"{empty} drawn chunk(s) had no number with a unit or comparison (flagged by the ingest heuristic only)")
    print("per book: " + ", ".join(f"{b}={n}" for b, n in sorted(books.items())))
    print(FILL_HELP)
    return 0


# ----------------------------------------------------------------------------- report
OK = {"一致", "ok", "o", "○", "〇", "match", "正"}
ERR = {"誤り", "誤", "x", "×", "ng", "ミス", "error", "err"}
SKIP = {"判定不能", "不能", "?", "？", "skip", "不明", "-"}
YES = {"はい", "yes", "y", "1", "○", "〇", "あり"}


def judgement(value: str) -> str | None:
    v = norm(value or "").strip().lower()
    if not v:
        return None
    if v in OK:
        return "ok"
    if v in ERR:
        return "err"
    if v in SKIP:
        return "skip"
    return "unknown"


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (float("nan"), float("nan"))
    p = k / n
    den = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return (max(0.0, centre - half), min(1.0, centre + half))


def rate_line(label: str, k: int, n: int) -> str:
    if n == 0:
        return f"{label:<24} 判定 0 件"
    lo, hi = wilson(k, n)
    return f"{label:<24} 誤り {k}/{n} = {100 * k / n:5.1f}%  （95%CI {100 * lo:.1f}–{100 * hi:.1f}%）"


def summarize(rows: Iterable[dict]) -> dict:
    rows = list(rows)
    judged = [(r, judgement(r.get("判定", ""))) for r in rows]
    s: dict = {"rows": len(rows), "unjudged": 0, "unknown": [], "ok": 0, "err": 0, "skip": 0}
    by_book: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    by_flag: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    chunks: dict[str, bool] = {}
    kinds: Counter = Counter()
    shift = [0, 0]
    for r, j in judged:
        if j is None:
            s["unjudged"] += 1
            continue
        if j == "unknown":
            s["unknown"].append(r.get("番号", "?"))
            continue
        s[j] += 1
        if j == "skip":
            continue
        e = 1 if j == "err" else 0
        for agg, key in ((by_book, r.get("書籍ID", "")), (by_flag, r.get("旗", ""))):
            agg[key][0] += e
            agg[key][1] += 1
        cid = r.get("チャンクID", "")
        chunks[cid] = chunks.get(cid, False) or bool(e)
        if e and (r.get("誤りの種類") or "").strip():
            kinds[r["誤りの種類"].strip()] += 1
        shift[1] += 1
        if norm(r.get("頁ずれ", "")).strip().lower() in YES:
            shift[0] += 1
    s.update(by_book=dict(by_book), by_flag=dict(by_flag), kinds=dict(kinds), page_shift=shift,
             chunks=[sum(chunks.values()), len(chunks)])
    return s


def cmd_report(a: argparse.Namespace) -> int:
    path = Path(a.csv)
    with path.open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    s = summarize(rows)
    print(f"行 {s['rows']}  判定済み {s['ok'] + s['err']}（一致 {s['ok']}・誤り {s['err']}）  判定不能 {s['skip']}  未記入 {s['unjudged']}")
    if s["unknown"]:
        print(f"判定の欄が読めない行: {', '.join(s['unknown'][:10])}（一致 / 誤り / 判定不能 のどれかに）")
    print()
    print(rate_line("全体（数値単位）", s["err"], s["ok"] + s["err"]))
    print(rate_line("全体（チャンク単位）", *s["chunks"]))
    print("\n書籍別")
    for b, (k, n) in sorted(s["by_book"].items()):
        print("  " + rate_line(b, k, n))
    print("旗別（dose_unit = 用量の単位、lab_threshold = 検査値の閾値）")
    for fl, (k, n) in sorted(s["by_flag"].items()):
        print("  " + rate_line(fl, k, n))
    if s["kinds"]:
        print("\n誤りの種類: " + "、".join(f"{k} {v}" for k, v in sorted(s["kinds"].items(), key=lambda x: -x[1])))
    k, n = s["page_shift"]
    if n:
        print(f"\n頁ずれ（数値がその頁になかった）: {k}/{n}（数値の誤りとは別。引用の頁の正しさに関わる）")
    print(
        "\n注: 標本は書籍ごとに均等に割り付けたもので、全体の率は書籍の大きさで重み付けしていない（書籍どうしの比較が目的）。"
        "\n    どの率なら頁画像の照合（B3）に進むかは、医師が決める。"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("sample", help="draw the worksheet")
    sp.add_argument("--db", help="local SQLite built by ingest (only the books in that file)")
    sp.add_argument("--d1", help="name of the deployed D1 database (e.g. medbook), read via npx wrangler")
    sp.add_argument("--out", default=str(DEFAULT_OUT))
    sp.add_argument("--chunks", type=int, default=40, help="chunks to draw (default 40)")
    sp.add_argument("--per-chunk", type=int, default=3, help="number rows per chunk at most (default 3)")
    sp.add_argument("--seed", type=int, default=1)
    sp.add_argument("--books", help="comma-separated book ids to limit to")
    rp = sub.add_parser("report", help="summarise a filled worksheet")
    rp.add_argument("csv")
    a = ap.parse_args(argv)
    return cmd_sample(a) if a.cmd == "sample" else cmd_report(a)


if __name__ == "__main__":
    sys.exit(main())
