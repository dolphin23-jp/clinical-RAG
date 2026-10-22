import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ingest.build_db import add_chapter, connect  # noqa: E402
from ingest.export_sql import export  # noqa: E402
from ingest.ocr_convert import convert  # noqa: E402
from ingest.parse import parse_chapter  # noqa: E402
from ingest.validate import validate  # noqa: E402


def build(db, items):
    con = connect(db)
    for book_id, path in items:
        ch = parse_chapter(path, book_id)
        add_chapter(con, ch, validate(ch))
    con.close()


def apply(db, out_dir):
    con = sqlite3.connect(db)
    for f in sorted(Path(out_dir).glob("*.sql")):
        con.executescript(f.read_text(encoding="utf-8"))
    con.commit()
    return con


def counts(con, book):
    q = lambda sql: con.execute(sql, (book,)).fetchone()[0]
    return {
        "chunks": q("SELECT COUNT(*) FROM chunks WHERE book_id=?"),
        "parents": q("SELECT COUNT(*) FROM parents WHERE book_id=?"),
        "issues": q("SELECT COUNT(*) FROM issues WHERE chapter_id LIKE ? || ':%'"),
        # (no LIKE on the FTS tables: on the trigram table the planner would answer it from the index, which excludes chunk_id)
        "tri": q("SELECT COUNT(*) FROM chunks_tri WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE book_id=?)"),
        "bi": q("SELECT COUNT(*) FROM chunks_bi WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE book_id=?)"),
    }


class ScopedExportTests(unittest.TestCase):
    def test_per_book_reimport_leaves_other_books_alone_and_does_not_duplicate(self):
        tmp = Path(tempfile.mkdtemp())
        ocr_md = tmp / "ocr.md"
        ocr_md.write_text(convert(ROOT / "tests" / "fixtures" / "ocr_book", "架空OCR内科", 10**9)[0], encoding="utf-8")
        fx = ROOT / "tests" / "fixtures" / "synthetic_ch.md"

        both = tmp / "both.sqlite"
        build(both, [("fx", fx), ("ocrfx", ocr_md)])
        export(str(both), str(tmp / "d1_full"))
        target = tmp / "d1.sqlite"
        con = apply(target, tmp / "d1_full")
        before = {b: counts(con, b) for b in ("fx", "ocrfx")}
        self.assertTrue(all(c["chunks"] > 0 and c["chunks"] == c["tri"] == c["bi"] for c in before.values()))
        self.assertGreater(before["ocrfx"]["issues"], 0)

        # re-import only the OCR book from a DB that does not even contain the other one
        only = tmp / "only.sqlite"
        build(only, [("ocrfx", ocr_md)])
        files = export(str(only), str(tmp / "d1_one"), only_books=["ocrfx"])
        self.assertIn("DELETE FROM chunks_tri WHERE chunk_id IN", files[1].read_text(encoding="utf-8"))
        con = apply(target, tmp / "d1_one")
        apply(target, tmp / "d1_one")  # twice: still no duplicates
        after = {b: counts(sqlite3.connect(target), b) for b in ("fx", "ocrfx")}
        self.assertEqual(after, before)
        self.assertEqual(sqlite3.connect(target).execute("SELECT COUNT(*) FROM books").fetchone()[0], 2)


if __name__ == "__main__":
    unittest.main()
