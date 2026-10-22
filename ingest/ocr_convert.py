"""Convert an EbookText Studio auto-OCR book (output/全文.md) into the chapter-format markdown
that `ingest` understands, so OCR books and hand-transcribed chapters share one pipeline.

  python3 -m ingest.ocr_convert BOOK_DIR --title "書名" [--out FILE.md] [--section-chars 20000]

What the OCR file looks like (measured on a 223-screenshot, 229k-char book):
  * `<!-- source: page_00004.png -->` before the text of each screenshot (NOT a printed page).
  * `<!-- p.N ここまで -->` where the OCR saw printed page number N end.  Mostly sequential
    (5,6,7,8,9,12,…) but ~6 % are misreads (11, 14, 1058, 12, 19 …) and some pages are missing.
  * `<!-- 改ページ -->` unnumbered page breaks, `![図…](figures/…)` image links, `<sub>…表の原画像…</sub>`.
  * `##`/`###` headings are OCR guesses and are noisy; the only `#` is the book title.

Decisions (all conservative — wrong page numbers become wrong citations):
  * Every `p.N ここまで` and every `改ページ` is one page end (an "event").  A numbered marker is
    trusted only if other markers agree with it on (value - event ordinal): misreads sit at a
    different offset and are dropped.  Between two trusted markers P and N the page of each event is
    P+t when the event count matches N-P (checked on every gap); a mismatch of 1-3 (one page break
    missed or doubled) widens the label to a range of that width; a bigger mismatch labels the whole
    gap as a range.  Text before the first / after the last trusted marker is counted outwards with
    a tolerance that grows with distance.  A page range is shown as `p.10-12`, never as a guess.
  * No headings are invented: the book is cut into synthetic sections S01, S02 … of about
    --section-chars characters (only so the parser has an H1 per section); OCR headings stay as H2+.
  * The frontmatter says the text is unverified OCR, so every result carries a reliability warning.
  * Books exported by an older EbookText Studio have NO page-end markers (and no headings/tables);
    they are refused here — re-export them with the current version.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

MARK_RE = re.compile(r"^<!--\s*p\.(\d+)\s*ここまで\s*-->\s*$")
BREAK_RE = re.compile(r"^<!--\s*改ページ\s*-->\s*$")
SRC_RE = re.compile(r"^<!--\s*source:\s*(page_\d+)\.png(?:,\s*page:\s*(\d+))?\s*-->\s*$")
COMMENT_RE = re.compile(r"^<!--.*-->\s*$")
IMG_RE = re.compile(r"^!\[([^\]]*)\]\(([^)]*)\)\s*$")
SUB_RE = re.compile(r"^<sub>.*</sub>\s*$")
H_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*$")


def anchor_flags(vals: list[int], ordinals: list[int]) -> list[bool]:
    """A numbered marker is trusted only if other markers agree with it on `value - event ordinal`.

    Every page end (numbered or not) advances the ordinal by one, so the true page numbers of a
    stretch of the book share one offset.  Misread numbers (11, 1058, 19 ...) sit at other offsets.
    Two misreads can still collide by chance (observed: p.33→"3" and p.44→"14", both offset -30), so a
    class of exactly two needs the two markers to be neighbours in marker order; otherwise 3+ are required.
    """
    from collections import defaultdict

    cls: dict[int, list[int]] = defaultdict(list)  # offset -> positions in marker order
    for pos, (v, k) in enumerate(zip(vals, ordinals)):
        cls[v - k].append(pos)
    ok = [False] * len(vals)
    for positions in cls.values():
        if len(positions) >= 3 or (len(positions) == 2 and positions[1] - positions[0] == 1):
            for pos in positions:
                ok[pos] = True
    return ok


def monotone_chain(vals: list[int]) -> list[bool]:
    """Longest strictly increasing subsequence (ties: earliest).  Drops trusted-looking but out-of-order
    anchors, e.g. a printed section-local page number that happens to agree with its neighbour."""
    n = len(vals)
    best, prev = [1] * n, [-1] * n
    for i in range(n):
        for j in range(i):
            if vals[j] < vals[i] and best[j] + 1 > best[i]:
                best[i], prev[i] = best[j] + 1, j
    keep = [False] * n
    if n:
        k = max(range(n), key=lambda i: (best[i], -i))
        while k != -1:
            keep[k] = True
            k = prev[k]
    return keep


def convert(book_dir: str | Path, title: str, section_chars: int = 20000) -> tuple[str, dict]:
    src = Path(book_dir) / "output" / "全文.md"
    raw = src.read_text(encoding="utf-8")
    lines = raw.splitlines()

    # ---- pass 1: page-end events, cleaned anchors, per-line page labels ---------------------------
    # Every `p.N ここまで` (M) and every unnumbered `改ページ` (B) is one page end.  Kept M markers are
    # anchors with a trusted number; between two anchors P and N the events in between are pages
    # P+1..N-1 exactly when their count is N-P-1 (checked); otherwise the whole gap is a range.
    events: list[dict] = []
    for i, l in enumerate(lines):
        s_ = l.strip()
        m = MARK_RE.match(s_)
        if m:
            events.append({"idx": i, "kind": "M", "val": int(m.group(1)), "keep": False})
        elif BREAK_RE.match(s_):
            events.append({"idx": i, "kind": "B", "val": None, "keep": False})
    m_pos = [k for k, e in enumerate(events) if e["kind"] == "M"]
    keep = anchor_flags([events[k]["val"] for k in m_pos], m_pos)
    cand = [k for k, kp in zip(m_pos, keep) if kp]
    for k, kp in zip(cand, monotone_chain([events[k]["val"] for k in cand])):
        events[k]["keep"] = kp
    anchors = [k for k, e in enumerate(events) if e["keep"]]
    if not anchors:
        raise SystemExit(f"{src}: no usable 'p.N ここまで' markers; cannot assign printed pages")
    dropped = [events[k]["val"] for k in m_pos if not events[k]["keep"]]

    seg_label: list[tuple[int, int] | None] = [None] * len(lines)
    seg_start = [0] + [e["idx"] + 1 for e in events]  # first line of segment k (segment k ends at event k)

    def put(k: int, lab: tuple[int, int]) -> None:
        for ln in range(seg_start[k], events[k]["idx"] + 1):
            seg_label[ln] = lab

    exact = shifted = ranged = 0
    a0 = anchors[0]
    n0 = events[a0]["val"]
    for k in range(0, a0 + 1):  # before the first anchor: count backwards, widening the uncertainty
        dist = a0 - k
        pg, tol = n0 - dist, 1 + dist // 10
        put(k, (max(1, pg - tol), n0) if dist else (n0, n0))
    for a, b in zip(anchors, anchors[1:]):
        P, N = events[a]["val"], events[b]["val"]
        d = (N - P) - (b - a)  # 0: one event per page; else an event was missed (d>0) or doubled (d<0)
        if d == 0:
            exact += 1
            for t in range(1, b - a):
                put(a + t, (P + t, P + t))
            put(b, (N, N))
        elif abs(d) <= 3:
            shifted += 1
            for t in range(1, b - a):
                put(a + t, (P + t + min(0, d), P + t + max(0, d)))
            put(b, (N, N))
        else:
            ranged += 1
            for k in range(a + 1, b + 1):
                put(k, (P + 1, N))
    aL = anchors[-1]
    L = events[aL]["val"]
    for k in range(aL + 1, len(events) + 1):  # after the last anchor (k == len(events): text after the final event)
        dist = k - aL
        pg, tol = L + dist, 1 + dist // 10
        lab = (max(L + 1, pg - tol), pg + tol)
        if k < len(events):
            put(k, lab)
        else:
            for ln in range(events[-1]["idx"] + 1, len(lines)):
                seg_label[ln] = lab
    first_lab = seg_label[0]

    # ---- pass 2: clean lines, keep (line, label) --------------------------------------
    body: list[tuple[str, tuple[int, int]]] = []
    first_seen = False
    for i, l in enumerate(lines):
        s = l.strip()
        lab = seg_label[i] or first_lab
        if COMMENT_RE.match(s) or SUB_RE.match(s):
            continue
        if not s:
            body.append(("", lab))
            continue
        m = H_RE.match(l)
        if m and len(m.group(1)) == 1:
            if not first_seen:  # book title line
                first_seen = True
                continue
            l = "## " + m.group(2)  # a stray H1 would start a fake section
        first_seen = True
        if s.startswith("<details>") or s == "</details>":
            sm_ = re.search(r"<summary>(.*?)</summary>", s)
            if sm_:
                l = f"［{sm_.group(1)}］"
            else:
                continue
        im = IMG_RE.match(s)
        if im:
            alt = im.group(1).strip()
            if not alt:
                continue
            l = f"［図］{alt}"
        body.append((l.rstrip(), lab))

    # ---- sections: cut every ~section_chars at a blank line outside a table ------------------
    sections: list[list[tuple[str, tuple[int, int]]]] = [[]]
    size = 0
    for idx, (l, lab) in enumerate(body):
        sections[-1].append((l, lab))
        size += len(l) + 1
        nxt = body[idx + 1][0] if idx + 1 < len(body) else ""
        if size >= section_chars and l.strip() == "" and not nxt.lstrip().startswith("|"):
            sections.append([])
            size = 0
    sections = [s for s in sections if any(x[0].strip() for x in s)]

    out_secs = []
    decl = []
    for n, sec in enumerate(sections, 1):
        a = min(x[1][0] for x in sec if x[0].strip())
        b = max(x[1][1] for x in sec if x[0].strip())
        letter = f"S{n:02d}"
        stitle = f"本文 p.{a}-{b}" if a != b else f"本文 p.{a}"
        decl.append(f'  - "{letter} {stitle} (p.{a}-{b})"')
        text_lines = [f"# {title}　{letter} {stitle}", ""]
        cur = None
        pending = True  # always (re)state the page at the start of a section
        for l, lab in sec:
            is_row = l.lstrip().startswith("|")
            if lab != cur:
                cur, pending = lab, True
            if pending and not is_row:
                text_lines.append(f"出典ページ: p.{lab[0]}-{lab[1]}" if lab[0] != lab[1] else f"出典ページ: p.{lab[0]}")
                pending = False
            text_lines.append(l)
        out_secs.append("\n".join(text_lines).rstrip() + "\n")

    p0 = min(int(re.search(r"p\.(\d+)", d).group(1)) for d in decl)
    p1 = max(int(re.search(r"-(\d+)\)", d).group(1)) for d in decl)
    fm = "\n".join(
        [
            "---",
            f"title: {title} 全文（自動OCR）",
            f"book: {title}",
            "chapter_no: 1",
            "chapter_title: 全文（自動OCR）",
            f"pages: {p0}-{p1}",
            "source_format: auto-ocr",
            "sections:",
            *decl,
            "text_reliability: 自動OCR（NDLOCR-Lite）による。全文の照合は未実施。数値・用量・薬剤名・表・図は原本で確認が必要。頁番号はOCRが検出した「p.N ここまで」から推定した範囲で、幅のある表記は番号が検出できなかった頁を含む。",
            "notes: 節（S01…）は機械的な区切りで原本の節ではない。見出しはOCRの推定で不正確なことがある。",
            "---",
            "",
        ]
    )
    stats = {
        "source": str(src),
        "page_end_events": len(events),
        "markers_kept": len(anchors),
        "markers_dropped": dropped,
        "gaps_exact": exact,
        "gaps_shifted_by_1to3": shifted,
        "gaps_range": ranged,
        "sections": len(sections),
        "pages": f"{p0}-{p1}",
        "chars": sum(len(x) for x in out_secs),
    }
    return fm + "\n".join(out_secs), stats


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="ingest.ocr_convert")
    ap.add_argument("book_dir")
    ap.add_argument("--title", required=True)
    ap.add_argument("--out")
    ap.add_argument("--section-chars", type=int, default=20000)
    a = ap.parse_args(argv)
    text, stats = convert(a.book_dir, a.title, a.section_chars)
    out = Path(a.out) if a.out else Path(a.book_dir) / "output" / "chapter.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    print(f"wrote {out}")
    for k, v in stats.items():
        print(f"  {k}: {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
