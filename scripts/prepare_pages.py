"""Turn a book PDF (or a folder of page images) into per-page WebP files for the R2 bucket.

  python3 scripts/prepare_pages.py --book rk4 --pdf book.pdf --offset -12 --out pages_out
  python3 scripts/prepare_pages.py --book rk4 --images scans/ --offset 0 --out pages_out --emit-upload-script upload.sh

Files are written as  <out>/pages/<book_id>/<printed page>.webp  and the R2 key is  pages/<book_id>/<n>.webp
(the Worker serves /api/page/<book_id>/<n> from exactly that key).

--offset maps the PDF/image sequence number to the PRINTED page number that the transcription uses in
`出典ページ: p.N`:   printed = sequence + offset.   Example: the PDF's page 15 is printed page 3  ->  --offset -12.
Pages whose printed number would be < 1 (cover, front matter) are skipped.

Needs poppler's `pdftoppm` for PDFs and Pillow.  Keep the bucket private: the Worker checks the bearer token
before it streams an image.  Page images of a commercial book are for your own use only.
"""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image


def natural_key(p: Path):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", p.name)]


def render_pdf(pdf: Path, workdir: Path, dpi: int, first: int | None, last: int | None) -> list[Path]:
    if not shutil.which("pdftoppm"):
        sys.exit("pdftoppm (poppler-utils) is required for --pdf")
    cmd = ["pdftoppm", "-r", str(dpi), "-png"]
    if first:
        cmd += ["-f", str(first)]
    if last:
        cmd += ["-l", str(last)]
    subprocess.run(cmd + [str(pdf), str(workdir / "p")], check=True)
    return sorted(workdir.glob("p-*.png"), key=natural_key)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--book", required=True, help="book_id used at ingest time (e.g. rk4)")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--pdf")
    src.add_argument("--images", help="folder of page images, sorted by natural file-name order")
    ap.add_argument("--offset", type=int, default=0, help="printed page = sequence number + offset")
    ap.add_argument("--first", type=int, help="first PDF page to render (sequence number)")
    ap.add_argument("--last", type=int, help="last PDF page to render")
    ap.add_argument("--width", type=int, default=1200, help="max width in px (default 1200)")
    ap.add_argument("--quality", type=int, default=72)
    ap.add_argument("--dpi", type=int, default=130)
    ap.add_argument("--out", default="pages_out")
    ap.add_argument("--emit-upload-script", metavar="FILE", help="also write a shell script of `wrangler r2 object put` commands")
    ap.add_argument("--bucket", default="medbook-pages")
    a = ap.parse_args()

    out = Path(a.out) / "pages" / a.book
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        if a.pdf:
            files = render_pdf(Path(a.pdf), Path(td), a.dpi, a.first, a.last)
            start = a.first or 1
        else:
            files = sorted([p for p in Path(a.images).iterdir() if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"}], key=natural_key)
            start = 1
        if not files:
            sys.exit("no pages found")
        written: list[tuple[int, Path]] = []
        total = 0
        for i, f in enumerate(files):
            seq = start + i
            printed = seq + a.offset
            if printed < 1:
                continue
            with Image.open(f) as im:
                im = im.convert("L") if im.mode in ("1", "L", "P") and im.getcolors(256) and len(im.getcolors(256)) <= 16 else im.convert("RGB")
                if im.width > a.width:
                    im = im.resize((a.width, round(im.height * a.width / im.width)), Image.LANCZOS)
                dest = out / f"{printed}.webp"
                im.save(dest, "WEBP", quality=a.quality, method=6)
            written.append((printed, dest))
            total += dest.stat().st_size
    print(f"{len(written)} pages -> {out}  ({total / 1e6:.1f} MB; first printed p.{written[0][0]}, last p.{written[-1][0]})")
    if a.emit_upload_script:
        lines = ["#!/bin/sh", "set -e", "# run from the worker/ directory (needs `npx wrangler login` once)"]
        for n, p in written:
            lines.append(f"npx wrangler r2 object put {a.bucket}/pages/{a.book}/{n}.webp --file '{p.resolve()}' --content-type image/webp --remote")
        Path(a.emit_upload_script).write_text("\n".join(lines) + "\n")
        print(f"upload script: {a.emit_upload_script}  (a few hundred small files take minutes; fine for a one-time job)")


if __name__ == "__main__":
    main()
