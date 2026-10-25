"""The conversion log importer (ingest/conversion_log.py; docs/FORMAT.md section 7): a neutral JSON-lines log becomes `issues` rows with source
'conversion-log'.  The pipeline's own log format is not known here, so the tests pin this tool's own contract: what is accepted, what is refused (and
that a refused log writes nothing), that importing again replaces only the conversion-log rows of the named chapters, and that nothing of the book's
text can be carried into the table."""
import io
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ingest import conversion_log as cl  # noqa: E402
from ingest.build_db import add_chapter, connect  # noqa: E402
from ingest.cli import main as cli_main  # noqa: E402
from ingest.parse import parse_chapter  # noqa: E402
from ingest.validate import validate  # noqa: E402

FIX = ROOT / "tests" / "fixtures" / "synthetic_ch.md"


def lines(*objs):
    return "\n".join(json.dumps(o, ensure_ascii=False) for o in objs) + "\n"


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "fx.sqlite"
        con = connect(str(self.db))
        ch = parse_chapter(FIX, "fx")
        add_chapter(con, ch, validate(ch))
        con.close()

    def tearDown(self):
        self.tmp.cleanup()

    def rows(self, where="1=1"):
        con = sqlite3.connect(self.db)
        try:
            return con.execute(f"SELECT chapter_id, section_id, level, code, message, source FROM issues WHERE {where} ORDER BY issue_id").fetchall()
        finally:
            con.close()

    def run_cli(self, log_text, *extra):
        path = Path(self.tmp.name) / "log.jsonl"
        path.write_text(log_text, encoding="utf-8")
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            rc = cli_main(["conversion-log", "--db", str(self.db), *extra, "fx", str(path)])
        return rc, out.getvalue(), err.getvalue()

    def parse(self, text):
        con = sqlite3.connect(self.db)
        try:
            chapters, texts = cl.read_book(con, "fx")
        finally:
            con.close()
        return cl.parse_log(text, "fx", chapters, texts)


class ImportTests(Base):
    def test_a_log_becomes_warnings_beside_the_text_they_concern(self):
        before = self.rows()
        log = lines(
            {"chapter": 2, "status": "partial", "note": "表だけ拡大再照合"},
            {"chapter": "ch02", "section": "B", "pages": "12-14", "status": "mismatch", "note": "用量表の1行が原本と不一致（修正待ち）"},
            {"chapter": "fx:ch02", "section": "A", "status": "verified"},
            {"chapter": 2, "section": "A", "pages": "11", "status": "unverified"},
        )
        rc, out, err = self.run_cli(log)
        self.assertEqual((rc, err), (0, ""), err)
        self.assertIn("4 line(s)", out)
        added = self.rows("source = 'conversion-log'")
        self.assertEqual(
            added,
            [
                ("fx:ch02", None, "warn", "CL_PARTIAL", "変換ログ: 原本との照合は一部だけ：表だけ拡大再照合", "conversion-log"),
                ("fx:ch02", "fx:ch02:B", "warn", "CL_MISMATCH", "変換ログ: 原本との不一致が見つかっている（未修正）（p.12-14）：用量表の1行が原本と不一致（修正待ち）", "conversion-log"),
                ("fx:ch02", "fx:ch02:A", "warn", "CL_UNVERIFIED", "変換ログ: 原本との照合は未実施（p.11）", "conversion-log"),
            ],
        )  # `verified` wrote nothing
        self.assertEqual(self.rows("source <> 'conversion-log'"), before)  # the ingest's own issues are untouched

    def test_importing_again_replaces_the_rows_of_the_named_chapters_and_only_those(self):
        self.run_cli(lines({"chapter": 2, "status": "unverified"}))
        con = sqlite3.connect(self.db)
        con.execute("INSERT INTO issues(chapter_id, level, code, message, source) VALUES ('fx:ch99', 'warn', 'CL_PARTIAL', 'another chapter', 'conversion-log')")
        con.execute("INSERT INTO issues(chapter_id, level, code, message, source) VALUES ('fx:ch02', 'info', 'X', 'by hand', 'manual')")
        con.commit()
        con.close()
        rc, _, _ = self.run_cli(lines({"chapter": 2, "section": "B", "status": "partial"}))
        self.assertEqual(rc, 0)
        mine = self.rows("source = 'conversion-log' AND chapter_id = 'fx:ch02'")
        self.assertEqual([(r[1], r[3]) for r in mine], [("fx:ch02:B", "CL_PARTIAL")])  # the earlier chapter-level row is gone
        self.assertEqual(len(self.rows("chapter_id = 'fx:ch99'")), 1)  # another chapter: untouched
        self.assertEqual(len(self.rows("source = 'manual'")), 1)  # someone's own note: untouched
        # the same log twice is the same table
        again = self.rows("source = 'conversion-log'")
        self.run_cli(lines({"chapter": 2, "section": "B", "status": "partial"}))
        self.assertEqual(self.rows("source = 'conversion-log'"), again)

    def test_check_reads_and_reports_but_writes_nothing(self):
        before = self.rows()
        rc, out, _ = self.run_cli(lines({"chapter": 2, "status": "mismatch"}), "--check")
        self.assertEqual(rc, 0)
        self.assertIn("nothing written", out)
        self.assertEqual(self.rows(), before)

    def test_building_a_chapter_again_drops_its_log_rows_so_the_log_is_imported_again(self):
        self.run_cli(lines({"chapter": 2, "status": "unverified"}))
        self.assertEqual(len(self.rows("source = 'conversion-log'")), 1)
        con = connect(str(self.db))
        ch = parse_chapter(FIX, "fx")
        add_chapter(con, ch, validate(ch))
        con.close()
        self.assertEqual(self.rows("source = 'conversion-log'"), [])  # documented in FORMAT.md: import the log again after a rebuild

    def test_the_rows_travel_with_the_search_result_notes_columns(self):
        """The columns the worker reads (chapter_id / section_id / level / code / message / source) are filled as for the transcriber's flags."""
        self.run_cli(lines({"chapter": 2, "section": "B", "status": "mismatch"}))
        con = sqlite3.connect(self.db)
        row = con.execute("SELECT chunk_id, section_id, chapter_id, level, source FROM issues WHERE source = 'conversion-log'").fetchone()
        self.assertEqual(row, (None, "fx:ch02:B", "fx:ch02", "warn", "conversion-log"))
        self.assertIn(row[1], {r[0] for r in con.execute("SELECT section_id FROM sections")})
        con.close()


class RefusalTests(Base):
    def refuse(self, log, fragment):
        before = self.rows()
        rc, _, err = self.run_cli(log)
        self.assertEqual(rc, 1, err)
        self.assertIn("NOT imported", err)
        self.assertIn(fragment, err)
        self.assertEqual(self.rows(), before, "a refused log writes nothing")

    def test_every_problem_is_listed_at_once_and_nothing_is_written(self):
        log = '{"chapter": 9, "status": "partial"}\nnot json\n[1]\n' + lines({"chapter": 2, "section": "Z", "status": "fine"}) + lines({"chapter": 2, "status": "partial", "colour": 1})
        before = self.rows()
        rc, _, err = self.run_cli(log)
        self.assertEqual(rc, 1)
        for frag in ("line 1: chapter fx:ch09 is not in the database", "line 2: not JSON", "line 3: each line must be a JSON object", "line 4: status must be one of", "line 4: section Z is not in fx:ch02", "line 5: unknown key(s) colour"):
            self.assertIn(frag, err)
        self.assertEqual(self.rows(), before)

    def test_fields_are_checked(self):
        self.refuse(lines({"chapter": "other:ch02", "status": "partial"}), "chapter must be a number")
        self.refuse(lines({"chapter": 2, "status": "partial", "pages": "12 - 14"}), "pages must look like")
        self.refuse(lines({"chapter": 2, "status": "partial", "note": "あ" * 121}), "at most 120")
        self.refuse(lines({"chapter": 2, "status": "partial", "note": "一行目\n二行目"}), "one line without control characters")
        self.refuse(lines({"chapter": 2, "status": "partial", "note": "  "}), "non-empty string")
        self.refuse(lines({"chapter": True, "status": "partial"}), "chapter must be a number")
        self.refuse(lines({"chapter": 2}), "status must be one of")
        self.refuse("", "no entries")
        self.refuse("# only a comment\n\n", "no entries")

    def test_two_statuses_for_the_same_place_are_refused(self):
        self.refuse(lines({"chapter": 2, "section": "B", "status": "verified"}, {"chapter": 2, "section": "B", "status": "mismatch"}), "is both verified (line 1) and mismatch")
        # different places are fine: the chapter verified as a whole, one section not
        entries, errors = self.parse(lines({"chapter": 2, "status": "verified"}, {"chapter": 2, "section": "B", "status": "mismatch"}))
        self.assertEqual((len(entries), errors), (2, []))

    def test_a_note_cannot_carry_the_books_own_text(self):
        con = sqlite3.connect(self.db)
        body = con.execute("SELECT text FROM parents WHERE chapter_id = 'fx:ch02' ORDER BY length(text) DESC LIMIT 1").fetchone()[0]
        con.close()
        sentence = "架空症候群とは，ゼルニア値が基準の半分以下に低下した状態をいう"
        self.assertIn("ゼルニア値が基準の半分以下", body)
        self.refuse(lines({"chapter": 2, "status": "partial", "note": sentence}), "repeats the chapter's own text")
        # spacing and width do not hide it
        self.refuse(lines({"chapter": 2, "status": "partial", "note": "架空症候群とは、 ゼルニア値が基準の半分以下に 低下した状態を いう".replace("、", "，")}), "repeats the chapter's own text")
        # a short phrase that happens to appear in the book is a normal note
        entries, errors = self.parse(lines({"chapter": 2, "status": "partial", "note": "ゼルニア値の表"}))
        self.assertEqual(errors, [])

    def test_a_missing_database_or_book_stops_before_anything_else(self):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            self.assertEqual(cli_main(["conversion-log", "--db", str(Path(self.tmp.name) / "none.sqlite"), "fx", "x.jsonl"]), 2)
            path = Path(self.tmp.name) / "log.jsonl"
            path.write_text(lines({"chapter": 2, "status": "partial"}), encoding="utf-8")
            self.assertEqual(cli_main(["conversion-log", "--db", str(self.db), "nobook", str(path)]), 2)
        self.assertIn("no such database", err.getvalue())
        self.assertIn("has no chapters", err.getvalue())


class FormTests(unittest.TestCase):
    def test_chapter_id_forms(self):
        f = cl.chapter_id_of
        self.assertEqual([f(2, "fx"), f("2", "fx"), f("ch2", "fx"), f("ch02", "fx"), f("fx:ch02", "fx"), f(" 2 ", "fx")], ["fx:ch02"] * 6)
        self.assertEqual(f(12, "fx"), "fx:ch12")
        for bad in (0, -1, 1000, True, None, "", "x", "other:ch02", "ch", 2.5, [2]):
            self.assertIsNone(f(bad, "fx"), repr(bad))

    def test_the_statuses_and_their_levels(self):
        self.assertIsNone(cl.STATUS["verified"])
        self.assertEqual({k: v[:2] for k, v in cl.STATUS.items() if v}, {"partial": ("warn", "CL_PARTIAL"), "unverified": ("warn", "CL_UNVERIFIED"), "mismatch": ("warn", "CL_MISMATCH")})
        self.assertEqual(cl.SOURCE, "conversion-log")  # the worker surfaces every issue whose source is not 'ingest'


if __name__ == "__main__":
    unittest.main()
