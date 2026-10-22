import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ingest.ocr_convert import anchor_flags, convert, monotone_chain  # noqa: E402
from ingest.parse import parse_chapter  # noqa: E402
from ingest.validate import validate  # noqa: E402

FIX = ROOT / "tests" / "fixtures" / "ocr_book"


def label_before(text, needle):
    """The `出典ページ:` line in force where `needle` appears in the converted markdown."""
    head = text[: text.index(needle)]
    return [l for l in head.splitlines() if l.startswith("出典ページ:")][-1].split(":", 1)[1].strip()


def chunk_pages(ch, needle):
    c = [c for c in ch.chunks if needle in c.text][0]
    return c.page_start, c.page_end


class AnchorTests(unittest.TestCase):
    def test_misread_numbers_have_no_agreeing_neighbour(self):
        # events 0..5 are pages 5..10; the marker at event 3 was misread as 11
        ok = anchor_flags([5, 6, 11, 9, 10], [0, 1, 3, 4, 5])
        self.assertEqual(ok, [True, True, False, True, True])

    def test_two_chance_collisions_far_apart_are_not_trusted(self):
        # p.33->'3' at ordinal 33 and p.44->'14' at ordinal 44 share offset -30 but are not neighbours
        vals = [30, 31, 3, 36, 14, 45]
        ords = [30, 31, 33, 36, 44, 45]
        self.assertEqual(anchor_flags(vals, ords), [True, True, False, True, False, True])

    def test_monotone_chain_drops_out_of_order_agreeing_pair(self):
        self.assertEqual(monotone_chain([90, 91, 18, 19, 98, 99]), [True, True, False, False, True, True])


class ConvertTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text, cls.stats = convert(FIX, "架空OCR内科", section_chars=10**9)
        cls.dir = tempfile.mkdtemp()
        cls.path = Path(cls.dir) / "ch.md"
        cls.path.write_text(cls.text, encoding="utf-8")
        cls.ch = parse_chapter(cls.path, "ocrfx")

    def test_pages_from_page_end_events(self):
        t = self.text
        self.assertEqual(label_before(t, "本文A"), "p.5")
        self.assertEqual(label_before(t, "本文B"), "p.6")
        self.assertEqual(label_before(t, "本文C"), "p.7")  # ended by an unnumbered page break
        self.assertEqual(label_before(t, "本文D"), "p.8")  # ended by the misread '11'
        self.assertEqual(label_before(t, "本文E"), "p.10")
        self.assertEqual(self.stats["markers_dropped"], [11])
        self.assertEqual((self.stats["gaps_exact"], self.stats["gaps_shifted_by_1to3"], self.stats["gaps_range"]), (4, 0, 0))

    def test_parsed_chunks_keep_those_pages(self):
        # small neighbouring chunks under one heading are merged, so a chunk may span pages, but never miss its own
        a0, a1 = chunk_pages(self.ch, "本文A")
        self.assertTrue(a0 == 5 and a1 >= 5)
        c0, c1 = chunk_pages(self.ch, "本文C")
        self.assertTrue(c0 <= 7 <= c1)
        d0, d1 = chunk_pages(self.ch, "本文D")
        self.assertTrue(d0 <= 8 <= d1)

    def test_text_after_the_last_page_end_is_a_range_not_a_guess(self):
        # last page end is p.11, so the rest is p.12 give or take one missed break
        self.assertEqual(label_before(self.text, "本文F"), "p.12-13")

    def test_table_is_not_split_by_a_page_marker(self):
        tables = [c for c in self.ch.chunks if c.kind == "table"]
        self.assertEqual(len(tables), 1)
        self.assertIn("架空K", tables[0].text)
        self.assertIn("架空Na", tables[0].text)

    def test_cleanup(self):
        body = self.text.split("\n---\n", 1)[1]
        for junk in ("<!--", "<details>", "</details>", "<sub>", "![", "ここまで"):
            self.assertNotIn(junk, body)
        self.assertIn("［図］図：架空の経路", body)
        self.assertIn("［図中の文字］", body)
        self.assertEqual(sum(1 for l in body.splitlines() if l.startswith("# ")), 1)  # only the synthetic section H1
        self.assertIn("## 迷子のH1", body)  # stray H1 demoted

    def test_validates_clean_and_carries_reliability_warning(self):
        issues = validate(self.ch)
        self.assertEqual([i.code for i in issues if i.level == "error"], [])
        self.assertIn("W_RELIABILITY", [i.code for i in issues])
        self.assertNotIn("W_NO_AUTHOR", [i.code for i in issues])
        self.assertNotIn("W_PAGE_REGRESSION", [i.code for i in issues])

    def test_old_exports_without_page_markers_are_refused(self):
        d = Path(tempfile.mkdtemp())
        (d / "output").mkdir()
        (d / "output" / "全文.md").write_text("# 古い形式\n\n<!-- source: page_00001.png -->\n\n本文\n", encoding="utf-8")
        with self.assertRaises(SystemExit):
            convert(d, "古い形式")


if __name__ == "__main__":
    unittest.main()
