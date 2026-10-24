"""scripts/sample_numeric.py: the numeric transcription-error worksheet (docs/enhancement-plan.md T1-7)."""
import argparse
import csv
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import sample_numeric as sn  # noqa: E402
from ingest.build_db import connect  # noqa: E402

# Synthetic chunks only (no book text): two books, both numeric flags, plus rows that must never be drawn.
CHUNKS = [
    # chunk_id, book, kind, provenance, page_label, flags, critical, text
    ("a:ch01:0001", "bka", "body", "book", "p.10", "dose_unit", 1, "架空薬Aを 10 mg/日 で開始し、3日後に再評価する。"),
    ("a:ch01:0002", "bka", "body", "book", "p.11", "dose_unit,threshold", 1, "架空薬Bは 0.05-0.1 μg/kg/min で開始。"),
    ("a:ch01:0003", "bka", "table", "book", "p.12", "threshold,lab_threshold", 1, "ゼルニア値 < 20 を重症とする。eGFR 30 未満は半量。"),
    ("a:ch01:0004", "bka", "body", "book", "p.13", "threshold,lab_threshold", 1, "K 6.0 mEq/L 以上で治療を考える。"),
    ("b:ch01:0001", "bkb", "body", "book", "p.5-6", "dose_unit", 1, "架空薬Cを 2 g を 1日2回。"),
    ("b:ch01:0002", "bkb", "body", "book", "p.7", "threshold,lab_threshold", 1, "Cr 2.0 mg/dL 超で減量（p.12 参照、第2版、2030年）。"),
    ("b:ch01:0003", "bkb", "figure_aid", "transcriber", "p.8", "dose_unit", 1, "転写者の補助 5 mg"),
    ("b:ch01:0004", "bkb", "references", "book", "p.9", "dose_unit", 1, "1) 文献 10 mg"),
    ("b:ch01:0005", "bkb", "body", "book", "p.9", "", 0, "数値のない本文 3日"),
]


def build_db(path: Path) -> None:
    con = connect(path)
    con.executemany("INSERT INTO books (book_id, title, kind) VALUES (?, ?, 'book')", [("bka", "架空書A"), ("bkb", "架空書B")])
    for cid, book, kind, prov, label, flags, crit, text in CHUNKS:
        con.execute(
            "INSERT INTO chunks (chunk_id, chapter_id, book_id, kind, provenance, page_label, text, index_text, bigram, numeric_critical, numeric_flags, path)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, '第1章 > 節')",
            (cid, cid.rsplit(":", 1)[0], book, kind, prov, label, text, text, crit, flags),
        )
    con.commit()
    con.close()


def ns(**kw) -> argparse.Namespace:
    base = dict(db=None, d1=None, out=None, chunks=40, per_chunk=3, seed=1, books=None)
    base.update(kw)
    return argparse.Namespace(**base)


class Extraction(unittest.TestCase):
    def ex(self, t):
        return [e for _, _, e in sn.number_expressions(sn.norm(t))]

    def test_numbers_with_units_or_comparisons(self):
        self.assertEqual(self.ex("架空薬Xを 10 mg/日 で開始"), ["10 mg/日"])
        self.assertEqual(self.ex("0.05-0.1 μg/kg/min で開始"), ["0.05-0.1 μg/kg/min"])
        self.assertEqual(self.ex("eGFR 30 未満の場合"), ["30 未満"])
        self.assertEqual(self.ex("ゼルニア値 < 20 とする"), ["< 20"])
        self.assertEqual(self.ex("K 6.0 mEq/L 以上"), ["6.0 mEq/L 以上"])
        self.assertEqual(self.ex("１０ｍｇ"), ["10mg"])  # full-width input is normalised

    def test_page_figure_year_and_word_numbers_are_not_rows(self):
        self.assertEqual(self.ex("p.12 参照、第2版、2030年、表2-1、図3"), [])
        self.assertEqual(self.ex("HCO3- 18 mEq/L、SpO2 90%"), ["18 mEq/L", "90%"])
        self.assertEqual(self.ex("Na 140"), [])  # no unit, no comparison: not a row (documented limit)


class Sampling(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "lib.sqlite"
        build_db(self.db)
        self.out = Path(self.tmp.name) / "ws.csv"  # outside the repository: allowed

    def tearDown(self):
        self.tmp.cleanup()

    def read(self, path):
        raw = path.read_bytes()
        self.assertTrue(raw.startswith(b"\xef\xbb\xbf"), "UTF-8 with BOM so Excel shows Japanese")
        with path.open(encoding="utf-8-sig", newline="") as f:
            return list(csv.DictReader(f))

    def test_only_book_text_with_the_flag_is_drawn(self):
        cands = sn.SqliteSource(str(self.db)).query(sn.LIST_SQL)
        self.assertEqual(sorted(r["chunk_id"] for r in cands), sorted(c[0] for c in CHUNKS if c[6] and c[3] == "book" and c[2] != "references"))

    def test_stratified_and_deterministic(self):
        self.assertEqual(sn.cmd_sample(ns(db=str(self.db), out=str(self.out), chunks=4, seed=7)), 0)
        rows = self.read(self.out)
        self.assertEqual(rows[0].keys(), set(sn.HEADER) | rows[0].keys())
        self.assertEqual({r["書籍ID"] for r in rows}, {"bka", "bkb"})  # both books
        self.assertEqual({r["旗"] for r in rows}, {"dose_unit", "lab_threshold"})  # both flags
        first = [r["チャンクID"] for r in rows]
        sn.cmd_sample(ns(db=str(self.db), out=str(self.out), chunks=4, seed=7))
        self.assertEqual([r["チャンクID"] for r in self.read(self.out)], first)
        for r in rows:
            self.assertIn("【" + r["数値"] + "】", r["前後の文（【】が対象）"])
            self.assertEqual(r["判定"], "")

    def test_per_chunk_cap_and_book_filter(self):
        sn.cmd_sample(ns(db=str(self.db), out=str(self.out), per_chunk=1, books="bka"))
        rows = self.read(self.out)
        self.assertEqual({r["書籍ID"] for r in rows}, {"bka"})
        self.assertEqual(len(rows), len({r["チャンクID"] for r in rows}))

    def test_refuses_to_write_excerpts_into_the_repository_outside_work(self):
        with self.assertRaises(SystemExit):
            sn.check_out_path(ROOT / "docs" / "x.csv")
        with self.assertRaises(SystemExit):
            sn.check_out_path(ROOT / "eval" / "x.csv")
        sn.check_out_path(ROOT / "work" / "x.csv")  # gitignored
        sn.check_out_path(Path(self.tmp.name) / "x.csv")

    def test_d1_source_reads_wrangler_json(self):
        con = sqlite3.connect(self.db)
        con.row_factory = sqlite3.Row
        calls = []

        def runner(args):
            calls.append(args)
            sql = args[-1]
            rows = [dict(r) for r in con.execute(sql)]
            return "wrangler banner line\n" + json.dumps([{"results": rows, "success": True}])

        src = sn.D1Source("medbook", runner=runner)
        self.assertEqual(sn.cmd_sample(ns(out=str(self.out), chunks=3), source=src), 0)
        self.assertTrue(all(a[:4] == ["wrangler", "d1", "execute", "medbook"] and "--remote" in a and "--json" in a for a in calls))
        self.assertTrue(self.read(self.out))

    def test_unsafe_chunk_ids_are_not_inlined(self):
        with self.assertRaises(SystemExit):
            sn.fetch_details(sn.SqliteSource(str(self.db)), ["a'); DROP TABLE chunks;--"])


class Report(unittest.TestCase):
    def test_wilson(self):
        lo, hi = sn.wilson(0, 10)
        self.assertAlmostEqual(lo, 0.0, places=3)
        self.assertAlmostEqual(hi, 0.2775, places=3)
        lo, hi = sn.wilson(5, 10)
        self.assertAlmostEqual(lo, 0.2366, places=3)
        self.assertAlmostEqual(hi, 0.7634, places=3)

    def test_judgement_words(self):
        self.assertEqual([sn.judgement(v) for v in ["一致", "○", "OK", "誤り", "×", "判定不能", "?", "", "たぶん"]],
                         ["ok", "ok", "ok", "err", "err", "skip", "skip", None, "unknown"])

    def test_summary(self):
        rows = [
            {"番号": "N001", "書籍ID": "bka", "旗": "dose_unit", "チャンクID": "c1", "判定": "一致", "頁ずれ": "いいえ"},
            {"番号": "N002", "書籍ID": "bka", "旗": "dose_unit", "チャンクID": "c1", "判定": "誤り", "誤りの種類": "桁", "頁ずれ": "はい"},
            {"番号": "N003", "書籍ID": "bkb", "旗": "lab_threshold", "チャンクID": "c2", "判定": "一致"},
            {"番号": "N004", "書籍ID": "bkb", "旗": "lab_threshold", "チャンクID": "c3", "判定": "判定不能"},
            {"番号": "N005", "書籍ID": "bkb", "旗": "lab_threshold", "チャンクID": "c3", "判定": ""},
            {"番号": "N006", "書籍ID": "bkb", "旗": "lab_threshold", "チャンクID": "c3", "判定": "たぶん"},
        ]
        s = sn.summarize(rows)
        self.assertEqual((s["ok"], s["err"], s["skip"], s["unjudged"]), (2, 1, 1, 1))
        self.assertEqual(s["unknown"], ["N006"])
        self.assertEqual(s["by_book"], {"bka": [1, 2], "bkb": [0, 1]})
        self.assertEqual(s["by_flag"], {"dose_unit": [1, 2], "lab_threshold": [0, 1]})
        self.assertEqual(s["chunks"], [1, 2])
        self.assertEqual(s["kinds"], {"桁": 1})
        self.assertEqual(s["page_shift"], [1, 3])

    def test_report_runs_on_a_filled_csv(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "filled.csv"
            with p.open("w", encoding="utf-8-sig", newline="") as f:
                w = csv.writer(f)
                w.writerow(sn.HEADER)
                w.writerow(["N001", "bka", "書", "p.1", "dose_unit", "10 mg", "【10 mg】", "", "一致", "", "", "いいえ", "", "c1"])
            self.assertEqual(sn.main(["report", str(p)]), 0)


if __name__ == "__main__":
    unittest.main()


class SharedVectors(unittest.TestCase):
    """The same files bind worker/src/numsample.ts and web/eval-tools.js (the iPad screen) to this script."""

    def test_extraction_vectors(self):
        v = json.loads((ROOT / "tests" / "vectors" / "numeric_expr.json").read_text(encoding="utf-8"))
        for c in v["cases"]:
            self.assertEqual([e for _, _, e in sn.number_expressions(sn.norm(c["text"]))], c["exprs"], c["text"])

    def test_report_vectors(self):
        v = json.loads((ROOT / "tests" / "vectors" / "numeric_report.json").read_text(encoding="utf-8"))
        words = {"ok": "一致", "err": "誤り", "skip": "判定不能", "": ""}
        rows = [
            {"番号": r["no"], "書籍ID": r["book"], "旗": r["flag"], "チャンクID": r["chunk"], "判定": words[r["verdict"]],
             "誤りの種類": r["kind"], "頁ずれ": "はい" if r["shift"] else "いいえ"}
            for r in v["rows"]
        ]
        s = sn.summarize(rows)
        e = v["expect"]
        for k in ("rows", "ok", "err", "skip", "unjudged", "by_book", "by_flag", "chunks", "kinds", "page_shift"):
            self.assertEqual(s[k], e[k], k)
        for w in v["wilson"]:
            lo, hi = sn.wilson(w["k"], w["n"])
            self.assertAlmostEqual(lo, w["lo"], places=3)
            self.assertAlmostEqual(hi, w["hi"], places=3)
