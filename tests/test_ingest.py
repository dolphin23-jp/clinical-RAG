import json
import re
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ingest.build_db import add_chapter, connect  # noqa: E402
from ingest.parse import parse_chapter  # noqa: E402
from ingest.tokenize import bigram_text, query_terms  # noqa: E402
from ingest.validate import validate  # noqa: E402

FIX = ROOT / "tests" / "fixtures" / "synthetic_ch.md"


def codes(issues, level=None):
    return [i.code for i in issues if level is None or i.level == level]


class ParseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ch = parse_chapter(FIX, "fx")

    def test_frontmatter_and_ids(self):
        ch = self.ch
        self.assertEqual(ch.chapter_id, "fx:ch02")
        self.assertEqual((ch.edition, ch.publisher, ch.pub_year), ("1", "架空出版", 2030))
        self.assertEqual({k: (v.fm_start, v.fm_end) for k, v in ch.sections.items()}, {"A": (10, 12), "B": (12, 14)})

    def test_both_h1_spellings_and_authors(self):
        ch = self.ch
        self.assertEqual(ch.h1_styles, ["sep", "short"])
        self.assertEqual(ch.sections["A"].author, "架空太郎")
        self.assertEqual(ch.sections["B"].author, "架空花子")
        self.assertEqual({c.section.split()[0] for c in ch.chunks}, {"A", "B"})

    def test_every_chunk_has_a_page_and_page_carries_across_headings(self):
        self.assertTrue(all(c.page_start is not None for c in self.ch.chunks))
        # '### 分類' has no page line of its own: it must inherit p.10 from '## 定義'
        c = next(c for c in self.ch.chunks if "軽症，中等症，重症" in c.text)
        self.assertEqual(c.page_start, 10)
        c2 = next(c for c in self.ch.chunks if "3日後に再評価" in c.text)
        self.assertEqual(c2.page_start, 12)  # carried from the earlier page line, not reset by '### 経過観察'

    def test_metadata_dropped_but_text_box_kept(self):
        txt = "\n".join(c.text for c in self.ch.chunks)
        self.assertIn("囲みの中の文章もきちんと残る必要がある", txt)
        self.assertNotIn("所属:", txt)
        self.assertNotIn("転写注記", txt)

    def test_figure_is_split_into_book_and_transcriber_parts(self):
        fig = next(c for c in self.ch.chunks if c.kind == "figure")
        aid = next(c for c in self.ch.chunks if c.kind == "figure_aid")
        self.assertEqual((fig.provenance, aid.provenance), ("book", "transcriber"))
        self.assertEqual(fig.figure_id, "図2-1")
        self.assertEqual(fig.image, "images/fig2-1.png")
        self.assertIn("架空太郎", fig.text)  # verbatim caption stays with the book part
        self.assertIn("折れ線グラフ", aid.text)
        self.assertNotIn("※本項は原本の逐語ではなく", aid.text)  # boilerplate stripped
        self.assertNotIn("折れ線グラフ", fig.text)  # transcriber text never leaks into the book part

    def test_table_with_note(self):
        t = next(c for c in self.ch.chunks if c.kind == "table")
        self.assertEqual(t.figure_id, "表2-1")
        self.assertIn("| 軽症 | 40以上 | 外来 |", t.text)
        self.assertIn("罫線なし", t.transcriber_note)
        self.assertNotIn("罫線なし", t.text)

    def test_references_and_pmid(self):
        refs = {(r.section.split()[0], r.label): r for r in self.ch.refs}
        self.assertEqual(refs[("A", "1")].pmid, "99999991")
        self.assertIsNone(refs[("A", "2")].pmid)
        self.assertEqual(refs[("B", "1")].pmid, "99999992")
        self.assertEqual(len(self.ch.refs), 3)

    def test_citation_labels(self):
        c = next(c for c in self.ch.chunks if "軽症，中等症，重症" in c.text)
        self.assertEqual(c.cites, ["1", "2", "注1"])

    def test_numeric_flags(self):
        dose = next(c for c in self.ch.chunks if "架空薬X" in c.text)
        self.assertIn("dose_unit", dose.numeric_flags)
        self.assertIn("lab_threshold", dose.numeric_flags)
        plain = next(c for c in self.ch.chunks if c.kind == "key_points")
        self.assertEqual(plain.numeric_flags, [])

    def test_parent_assignment_groups_subtrees(self):
        ids = {c.parent_id for c in self.ch.chunks if c.kind != "references"}
        self.assertGreaterEqual(len(ids), 2)
        # all chunks under '定義' (incl. its '分類' sub-heading, figure, table) share one parent
        defn = [c for c in self.ch.chunks if c.path[:2] == ("A 架空症候群の概念", "定義") and c.kind != "references"]
        self.assertEqual(len({c.parent_id for c in defn}), 1)


class ValidateTests(unittest.TestCase):
    def test_clean_fixture_has_no_errors(self):
        ch = parse_chapter(FIX, "fx")
        iss = validate(ch)
        self.assertEqual(codes(iss, "error"), [])
        self.assertIn("W_RELIABILITY", codes(iss))
        self.assertIn("I_TRANSCRIBER_FLAG", codes(iss))  # '要確認' in 転写注記
        self.assertIn("I_H1_STYLE_MIXED", codes(iss))

    def _mutated(self, fn):
        txt = fn(FIX.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "m.md"
            p.write_text(txt, encoding="utf-8")
            return parse_chapter(p, "fx")

    def test_page_outside_declared_range_is_error(self):
        ch = self._mutated(lambda t: t.replace("出典ページ: p.11", "出典ページ: p.99"))
        self.assertIn("E_PAGE_OUT_OF_RANGE", codes(validate(ch), "error"))

    def test_missing_image_is_error_when_root_given(self):
        ch = parse_chapter(FIX, "fx")
        with tempfile.TemporaryDirectory() as d:
            self.assertIn("E_IMAGE_MISSING", codes(validate(ch, d), "error"))
            (Path(d) / "images").mkdir()
            (Path(d) / "images" / "fig2-1.png").write_bytes(b"x")
            self.assertNotIn("E_IMAGE_MISSING", codes(validate(ch, d)))

    def test_unresolved_citation_warns(self):
        ch = self._mutated(lambda t: t.replace("<sup>1)</sup>", "<sup>7)</sup>"))
        self.assertIn("W_CITE_UNRESOLVED", codes(validate(ch), "warn"))

    def test_missing_section_is_error(self):
        ch = self._mutated(lambda t: t.replace("# 第2章 B 架空症候群の治療", "# 第2章 C 別の節"))
        self.assertIn("E_SECTION_MISSING", codes(validate(ch), "error"))

    def test_table_column_mismatch_warns(self):
        ch = self._mutated(lambda t: t.replace("| 軽症 | 40以上 | 外来 |", "| 軽症 | 40以上 |"))
        self.assertIn("W_TABLE_COLS", codes(validate(ch), "warn"))


class DbTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.db = Path(cls.tmp.name) / "t.sqlite"
        cls.con = connect(cls.db)
        ch = parse_chapter(FIX, "fx")
        add_chapter(cls.con, ch, validate(ch))

    @classmethod
    def tearDownClass(cls):
        cls.con.close()
        cls.tmp.cleanup()

    def q(self, sql, *a):
        return self.con.execute(sql, a).fetchall()

    def test_counts_and_fts_in_sync(self):
        n = self.q("select count(*) from chunks")[0][0]
        self.assertEqual(self.q("select count(*) from chunks_tri")[0][0], n)
        self.assertEqual(self.q("select count(*) from chunks_bi")[0][0], n)

    def test_rebuild_is_idempotent(self):
        before = self.q("select count(*) from chunks")[0][0]
        ch = parse_chapter(FIX, "fx")
        add_chapter(self.con, ch, validate(ch))
        self.assertEqual(self.q("select count(*) from chunks")[0][0], before)
        self.assertEqual(self.q("select count(*) from chunks_bi")[0][0], before)
        self.assertEqual(self.q("select count(*) from issues where chapter_id='fx:ch02'")[0][0], len(validate(ch)))

    def test_chunk_refs_link_to_reference_entries(self):
        rows = self.q(
            "select r.label, r.pmid from chunks c join chunk_refs cr using(chunk_id) join refs r using(ref_id) "
            "where c.text like '%軽症，中等症，重症%' order by r.label"
        )
        self.assertEqual(rows, [("1", "99999991"), ("2", None)])

    def test_parent_text_has_page_markers_and_labels_transcriber_text(self):
        txt = self.q("select text from parents where text like '%折れ線グラフ%'")[0][0]
        self.assertIn("［p.10］", txt)
        self.assertIn("［転写者補助・原本の記述ではない］", txt)

    def test_two_char_terms_need_bigram_index(self):
        # the whole point of the dual index (see ingest/tokenize.py)
        tri = self.q("select count(*) from chunks_tri where chunks_tri match '\"腎炎\"'")[0][0]
        bi = self.q("select count(*) from chunks_bi where chunks_bi match ?", '"' + bigram_text("腎炎") + '"')[0][0]
        self.assertEqual(tri, 0)
        self.assertGreaterEqual(bi, 1)
        # latin substring: only trigram finds 'GFR' inside the single token 'eGFR' (chunk about 架空薬X)
        drug = self.q("select chunk_id from chunks where text like '%架空薬X%'")[0][0]
        tri_ids = {r[0] for r in self.q("select chunk_id from chunks_tri where chunks_tri match '\"gfr\"'")}
        bi_ids = {r[0] for r in self.q("select chunk_id from chunks_bi where chunks_bi match '\"gfr\"'")}
        self.assertIn(drug, tri_ids)
        self.assertNotIn(drug, bi_ids)


class TokenizerContract(unittest.TestCase):
    def test_vectors_match(self):
        vec = json.loads((ROOT / "tests" / "vectors" / "tokenize.json").read_text(encoding="utf-8"))
        self.assertGreater(len(vec), 10)
        for v in vec:
            self.assertEqual(bigram_text(v["in"]), v["bigram"], v["in"])
            self.assertEqual(query_terms(v["in"]), v["terms"], v["in"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
