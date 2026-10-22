"""Parser/chunker for the transcribed-book markdown format.

Format facts this parser relies on (all measured on a real 67-page chapter, see docs/FORMAT.md):

* YAML frontmatter: book, chapter_no, chapter_title, pages, sections[] with page ranges,
  text_reliability, notes.
* `# <chapter title>　<section letter> <section title>` = one H1 per lettered section.
* A line `出典ページ: p.X[-Y]` is emitted ONLY when the page changes.  Headings do NOT reset
  the page: the page carries forward until the next such line.
* Blockquote lines starting with 節/転写注記/出典/内容/記法/所属 are transcription metadata.
  Other `> ` lines are real text boxes (囲み) and are kept.
* Figures: `**図N-M　title**`, optional image line, then `- キャプション:` (verbatim),
  `- 図中の文字・構造:` + `- 図の意図:` (TRANSCRIBER-WRITTEN, not the book's words).
* Tables: `**表N-M　title**` + Markdown table + optional `(表の注: ...)` transcriber note.
* References under `引用文献` / `参考文献`, numbered `n)` or lettered `a)`, per section.
* A parenthesised author name on its own line closes a section: `(深川雅史)`.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

META_RE = re.compile(r"^>\s*(節|転写注記|出典|内容|記法|所属)\s*[:：]")
PAGE_RE = re.compile(r"^出典ページ:\s*(.+?)\s*$")
PNUM_RE = re.compile(r"p\.?\s*(\d+)(?:\s*[-–−〜～]\s*(\d+))?")
HEAD_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*$")
CAP_RE = re.compile(r"^\*\*((?:図|表)[0-9０-９][0-9０-９\-－ー〜~a-zA-Z]*)[\s　]*(.*?)\*\*\s*$")
IMG_RE = re.compile(r"^!\[([^\]]*)\]\(([^)]+)\)\s*$")
TRAILER_RE = re.compile(r"^[（(]([^()（）0-9:：注]{2,40})[)）]\s*$")
SUP_RE = re.compile(r"<sup>([^<]+)</sup>")
REF_START_RE = re.compile(r"^(\d+|[a-z])\)\s+(.*)$")
PMID_RE = re.compile(r"PMID:?\s*(\d+)")
TRANSCRIBER_NOTE_RE = re.compile(r"^[（(](?:表の注|図の注|注)[:：]")
AID_BOILERPLATE_RE = re.compile(r"[（(]※.*[）)]\s*$")
SECTION_FM_RE = re.compile(r"^\s*([A-Za-z0-9]+)\s+(.*?)\s*\(p\.(\d+)(?:-(\d+))?\)\s*$")
REF_HEAD_RE = re.compile(r"引用文献|参考文献")
H1_SECTION_RE = re.compile(r"(?:　|^第\s*\d+\s*章\s+)([A-Za-z0-9]{1,3})\s+(\S.*)$")

DOSE_RE = re.compile(
    r"(?:\d\s*)(?:mg|μg|µg|mcg|ng|mEq|mmol|mosm|iu|単位|g/dl|mg/dl|mmhg|ml/(?:min|hr|h|kg)|ml/分|ml/時|l/日|ml/日)",
    re.I,
)
THRESH_RE = re.compile(r"[≧≦≥≤<>＜＞]\s*\d|\d\s*(?:以上|以下|未満|超)")
LAB_RE = re.compile(
    r"eGFR|GFR|\bCr\b|クレアチニン|ナトリウム|カリウム|\bNa\b|\bK\b|\bCa\b|リン|pH|HCO3|重炭酸|尿蛋白|アルブミン|\bHb\b|mg/dL|mEq|mmHg|g/日|mL/min",
    re.I,
)

MAX_MERGE = 700  # merge small body units up to this many chars
MAX_UNIT = 950  # split a single unit longer than this at a sentence boundary
PARENT_MAX = 3500  # largest heading-subtree we return whole as "parent" context


def parse_pages(label: str | None) -> tuple[int | None, int | None]:
    if not label:
        return None, None
    m = PNUM_RE.search(label)
    if not m:
        return None, None
    a = int(m.group(1))
    b = int(m.group(2)) if m.group(2) else a
    return a, max(a, b)


@dataclass
class Chunk:
    seq: int = 0
    kind: str = "body"  # body | key_points | table | figure | figure_aid | references
    provenance: str = "book"  # book | transcriber
    section: str = ""  # H1 title (e.g. 'A 腎臓病診療の特徴')
    path: tuple[str, ...] = ()  # (section, h2, h3, ...)
    page_start: int | None = None
    page_end: int | None = None
    text: str = ""
    figure_id: str | None = None
    image: str | None = None
    author: str | None = None
    cites: list[str] = field(default_factory=list)  # numeric/alpha labels cited in text
    numeric_flags: list[str] = field(default_factory=list)
    transcriber_note: str = ""
    parent_key: tuple[str, ...] = ()
    chunk_id: str = ""
    parent_id: str = ""

    @property
    def page_label(self) -> str:
        if self.page_start is None:
            return ""
        if self.page_end and self.page_end != self.page_start:
            return f"p.{self.page_start}-{self.page_end}"
        return f"p.{self.page_start}"


@dataclass
class Ref:
    section: str
    label: str
    text: str
    pmid: str | None
    page_start: int | None = None


@dataclass
class SectionInfo:
    letter: str
    title: str
    fm_start: int | None = None
    fm_end: int | None = None
    author: str | None = None
    transcription_notes: list[str] = field(default_factory=list)


@dataclass
class Chapter:
    source_path: str
    book_id: str
    meta: dict
    book_title: str
    edition: str | None
    publisher: str | None
    pub_year: int | None
    chapter_no: int
    chapter_title: str
    page_start: int | None
    page_end: int | None
    chapter_id: str
    sections: dict[str, SectionInfo]
    chunks: list[Chunk]
    refs: list[Ref]
    h1_styles: list[str] = field(default_factory=list)


# ----------------------------------------------------------------------------- helpers
def numeric_flags(text: str) -> list[str]:
    flags = []
    if DOSE_RE.search(text):
        flags.append("dose_unit")
    if THRESH_RE.search(text):
        flags.append("threshold")
        if LAB_RE.search(text):
            flags.append("lab_threshold")
    return flags


def extract_cites(text: str) -> list[str]:
    labels: list[str] = []
    for m in SUP_RE.finditer(text):
        inner = m.group(1).replace("）", ")")
        for part in re.split(r"[,，、]", inner):
            part = part.strip().rstrip(")").strip()
            if not part:
                continue
            rng = re.fullmatch(r"(\d+)\s*[-–〜～]\s*(\d+)", part)
            if rng and int(rng.group(2)) - int(rng.group(1)) < 30:
                labels.extend(str(n) for n in range(int(rng.group(1)), int(rng.group(2)) + 1))
            else:
                labels.append(part)
    seen, out = set(), []
    for l in labels:
        if l not in seen:
            seen.add(l)
            out.append(l)
    return out


def split_long(text: str, limit: int = MAX_UNIT) -> list[str]:
    """Split an over-long unit at sentence ends ('．' / '。' / newline); never mid-sentence."""
    if len(text) <= limit:
        return [text]
    pieces = re.split(r"(?<=[．。\n])", text)
    out, cur = [], ""
    for p in pieces:
        if cur and len(cur) + len(p) > limit:
            out.append(cur.strip())
            cur = ""
        cur += p
    if cur.strip():
        out.append(cur.strip())
    return out


def split_frontmatter(raw: str) -> tuple[dict, str]:
    m = re.match(r"^---\n(.*?)\n---\n", raw, re.S)
    if not m:
        return {}, raw
    return (yaml.safe_load(m.group(1)) or {}), raw[m.end() :]


# ----------------------------------------------------------------------------- main
def parse_chapter(path: str | Path, book_id: str) -> Chapter:
    raw = Path(path).read_text(encoding="utf-8")
    fm, body = split_frontmatter(raw)
    lines = body.splitlines()

    book_title = str(fm.get("book", "")).strip()
    em = re.search(r"第\s*(\d+)\s*版", book_title)
    edition = em.group(1) if em else None
    chapter_no = int(fm.get("chapter_no", 0))
    chapter_title = str(fm.get("chapter_title", "")).strip()
    p0, p1 = parse_pages(f"p.{fm.get('pages', '')}") if fm.get("pages") else (None, None)
    chapter_id = f"{book_id}:ch{chapter_no:02d}"

    sections: dict[str, SectionInfo] = {}
    for s in fm.get("sections", []) or []:
        m = SECTION_FM_RE.match(str(s))
        if m:
            letter = m.group(1)
            a = int(m.group(3))
            b = int(m.group(4)) if m.group(4) else a
            sections[letter] = SectionInfo(letter, m.group(2), a, b)

    publisher = pub_year = None
    chunks: list[Chunk] = []
    refs: list[Ref] = []

    heading: dict[int, str] = {}
    cur_section = ""
    cur_letter = ""
    cur_page: tuple[int | None, int | None] = (None, None)
    buf: list[str] = []
    buf_note: list[str] = []
    buf_page_start: tuple[int | None, int | None] = (None, None)
    ref_entries: list[list] = []  # [label, text, page_start]
    h1_styles: set[str] = set()

    def cur_path() -> tuple[str, ...]:
        return tuple(heading[k] for k in sorted(heading) if heading[k])

    def in_refs() -> bool:
        last = cur_path()[-1] if cur_path() else ""
        return bool(REF_HEAD_RE.search(last))

    def is_key_points() -> bool:
        last = cur_path()[-1] if cur_path() else ""
        return "アプローチのポイント" in last

    def add_chunk(kind: str, text: str, pages, provenance="book", **kw) -> Chunk:
        c = Chunk(
            kind=kind,
            provenance=provenance,
            section=cur_section,
            path=cur_path(),
            page_start=pages[0],
            page_end=pages[1],
            text=text.strip(),
            **kw,
        )
        c.cites = extract_cites(c.text)
        c.numeric_flags = numeric_flags(c.text)
        chunks.append(c)
        return c

    def flush_refs():
        nonlocal ref_entries
        if not ref_entries:
            return
        group: list[str] = []
        gpages = None
        size = 0
        for lab, txt, pg in ref_entries:
            txt = txt.strip()
            m = PMID_RE.search(txt)
            refs.append(Ref(cur_section, lab, txt, m.group(1) if m else None, pg[0] if pg else None))
            line = f"{lab}) {txt}"
            if group and size + len(line) > 900:
                add_chunk("references", "\n".join(group), gpages)
                group, size, gpages = [], 0, None
            group.append(line)
            size += len(line)
            gpages = gpages or pg
        if group:
            add_chunk("references", "\n".join(group), gpages)
        ref_entries = []

    def flush_buf():
        nonlocal buf, buf_note, buf_page_start
        text = "\n".join(buf).strip()
        note = " ".join(buf_note).strip()
        pages = buf_page_start
        buf, buf_note = [], []
        if not text:
            return
        kind = "key_points" if is_key_points() else "body"
        for piece in split_long(text):
            c = add_chunk(kind, piece, pages)
            c.transcriber_note = note

    def start_buf_if_needed():
        nonlocal buf_page_start
        if not buf:
            buf_page_start = cur_page

    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        stripped = line.strip()

        m = HEAD_RE.match(line)
        if m:
            flush_buf()
            flush_refs()
            lvl, title = len(m.group(1)), m.group(2).strip()
            raw_h1 = m.group(2)
            if lvl == 1:
                # Two H1 spellings occur in real files (A-F: '<chapter title>　A title',
                # G-M: '第1章 G title').  Find the section letter instead of splitting blindly.
                sm = H1_SECTION_RE.search(title)
                if sm:
                    cur_letter = sm.group(1)
                    title = f"{sm.group(1)} {sm.group(2).strip()}"
                else:
                    cur_letter = title.split()[0] if title.split() else ""
                cur_section = title
                sections.setdefault(cur_letter, SectionInfo(cur_letter, title))
                h1_styles.add("sep" if "　" in raw_h1 else "short")
                heading = {}
            for k in [k for k in heading if k >= lvl]:
                del heading[k]
            heading[lvl] = title
            i += 1
            continue

        m = PAGE_RE.match(line)
        if m:
            flush_buf()
            cur_page = parse_pages(m.group(1))
            i += 1
            continue

        if META_RE.match(line):
            if cur_letter in sections and line.startswith(("> 転写注記", ">転写注記")):
                sections[cur_letter].transcription_notes.append(re.sub(r"^>\s*転写注記\s*[:：]\s*", "", line))
            if line.startswith("> 出典") and publisher is None:
                pm = re.search(r"[(（]([^，,)）]+)[，,]\s*((?:19|20)\d{2})[)）]", line)
                if pm:
                    publisher, pub_year = pm.group(1), int(pm.group(2))
            i += 1
            continue

        if stripped == "":
            i += 1
            continue

        # ---- figure / table blocks -------------------------------------------------
        cm = CAP_RE.match(stripped)
        if cm:
            flush_buf()
            flush_refs()
            label, title = cm.group(1), cm.group(2).strip()
            is_fig = label.startswith("図")
            j = i + 1
            block: list[str] = []
            while j < n:
                l2 = lines[j]
                s2 = l2.strip()
                if s2 == "":
                    k = j + 1
                    while k < n and lines[k].strip() == "":
                        k += 1
                    if k < n and _continues(lines[k], is_fig):
                        j = k
                        continue
                    break
                if _continues(l2, is_fig):
                    block.append(l2)
                    j += 1
                else:
                    break
            pages = cur_page
            if is_fig:
                _emit_figure(add_chunk, label, title, block, pages)
            else:
                _emit_table(add_chunk, label, title, block, pages)
            i = j
            continue

        # ---- table without caption -------------------------------------------------
        if stripped.startswith("|"):
            flush_buf()
            j = i
            rows: list[str] = []
            while j < n and lines[j].strip().startswith("|"):
                rows.append(lines[j].rstrip())
                j += 1
            add_chunk("table", "\n".join(rows), cur_page)
            i = j
            continue

        # ---- section-closing author trailer ----------------------------------------
        tm = TRAILER_RE.match(stripped)
        if tm and (in_refs() or _next_is_heading_or_eof(lines, i)):
            sections[cur_letter].author = tm.group(1).strip()
            i += 1
            continue

        # ---- references ------------------------------------------------------------
        if in_refs():
            rm = REF_START_RE.match(stripped)
            if rm:
                ref_entries.append([rm.group(1), rm.group(2), cur_page])
            elif ref_entries:
                ref_entries[-1][1] += " " + stripped
            i += 1
            continue

        # ---- inline transcriber notes, images, text boxes, ordinary text -----------
        if TRANSCRIBER_NOTE_RE.match(stripped):
            start_buf_if_needed()
            buf_note.append(stripped)
            i += 1
            continue
        if IMG_RE.match(stripped):  # stray image outside a figure block: ignore line
            i += 1
            continue
        start_buf_if_needed()
        if line.startswith(">"):
            line = re.sub(r"^>\s?", "", line)
        buf.append(line.rstrip())
        i += 1

    flush_buf()
    flush_refs()

    # merge small adjacent body units with the same heading path
    chunks = _merge_small(chunks)
    for idx, c in enumerate(chunks):
        c.seq = idx + 1
        c.chunk_id = f"{chapter_id}:{c.seq:04d}"
        letter = c.section.split()[0] if c.section.split() else ""
        if letter in sections:
            c.author = sections[letter].author
    _assign_parents(chunks, chapter_id)

    return Chapter(
        source_path=str(path),
        book_id=book_id,
        meta=fm,
        book_title=book_title,
        edition=edition,
        publisher=publisher,
        pub_year=pub_year,
        chapter_no=chapter_no,
        chapter_title=chapter_title,
        page_start=p0,
        page_end=p1,
        chapter_id=chapter_id,
        sections=sections,
        chunks=chunks,
        refs=refs,
        h1_styles=sorted(h1_styles),
    )


def _next_is_heading_or_eof(lines: list[str], i: int) -> bool:
    k = i + 1
    while k < len(lines) and lines[k].strip() == "":
        k += 1
    return k >= len(lines) or bool(HEAD_RE.match(lines[k]))


def _continues(line: str, is_fig: bool) -> bool:
    s = line.strip()
    if is_fig:
        return (
            bool(IMG_RE.match(s))
            or s.startswith(("- キャプション", "- 図中の文字・構造", "- 図の意図"))
            or line.startswith("  ")
        )
    return s.startswith("|") or bool(TRANSCRIBER_NOTE_RE.match(s))


def _emit_figure(add_chunk, label, title, block, pages):
    image = None
    caption = ""
    struct_lines: list[str] = []
    intent = ""
    mode = None
    for l in block:
        s = l.strip()
        im = IMG_RE.match(s)
        if im:
            image = im.group(2).strip()
            continue
        if s.startswith("- キャプション"):
            caption = re.sub(r"^- キャプション\s*[:：]\s*", "", s)
            mode = "cap"
        elif s.startswith("- 図中の文字・構造"):
            struct_lines = [re.sub(r"^- 図中の文字・構造\s*[:：]\s*", "", s)]
            mode = "struct"
        elif s.startswith("- 図の意図"):
            intent = re.sub(r"^- 図の意図\s*[:：]\s*", "", s)
            mode = "intent"
        elif l.startswith("  "):
            if mode == "struct":
                struct_lines.append(s.lstrip("- ").strip())
            elif mode == "cap":
                caption += " " + s
            elif mode == "intent":
                intent += " " + s
    head = f"**{label}　{title}**".strip()
    cap_text = head + (("\n" + caption) if caption else "")
    add_chunk("figure", cap_text, pages, "book", figure_id=label, image=image)
    aid_parts = [p for p in ["\n".join(x for x in struct_lines if x).strip(), intent.strip()] if p]
    if aid_parts:
        aid = AID_BOILERPLATE_RE.sub("", "\n".join(aid_parts)).strip()
        add_chunk(
            "figure_aid",
            f"{label} {title}\n{aid}",
            pages,
            "transcriber",
            figure_id=label,
            image=image,
        )


def _emit_table(add_chunk, label, title, block, pages):
    rows = [l.rstrip() for l in block if l.strip().startswith("|")]
    notes = [l.strip() for l in block if TRANSCRIBER_NOTE_RE.match(l.strip())]
    text = f"**{label}　{title}**\n" + "\n".join(rows)
    c = add_chunk("table", text, pages, "book", figure_id=label)
    c.transcriber_note = " ".join(notes)


def _merge_small(chunks: list[Chunk]) -> list[Chunk]:
    out: list[Chunk] = []
    for c in chunks:
        p = out[-1] if out else None
        if (
            p
            and c.kind == "body"
            and p.kind == "body"
            and p.path == c.path
            and len(p.text) + len(c.text) + 1 <= MAX_MERGE
        ):
            p.text += "\n" + c.text
            if c.page_end is not None:
                p.page_end = max(filter(None, [p.page_end, c.page_end]))
            if p.page_start is None:
                p.page_start = c.page_start
            p.cites = _uniq(p.cites + extract_cites(c.text))
            p.numeric_flags = _uniq(p.numeric_flags + c.numeric_flags)
            if c.transcriber_note:
                p.transcriber_note = (p.transcriber_note + " " + c.transcriber_note).strip()
        else:
            out.append(c)
    return out


def _uniq(xs):
    seen, out = set(), []
    for x in xs:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


def _assign_parents(chunks: list[Chunk], chapter_id: str) -> None:
    """parent = the highest heading ancestor (below H1) whose whole subtree is <= PARENT_MAX chars."""
    size: dict[tuple[str, ...], int] = {}
    for c in chunks:
        if c.kind == "references":
            continue
        for d in range(1, len(c.path) + 1):
            size[c.path[:d]] = size.get(c.path[:d], 0) + len(c.text)
    ids: dict[tuple[str, ...], str] = {}
    for c in chunks:
        if c.kind == "references":
            key = c.path
        else:
            key = c.path
            for d in range(min(2, len(c.path)), len(c.path) + 1):
                if size.get(c.path[:d], 0) <= PARENT_MAX:
                    key = c.path[:d]
                    break
        c.parent_key = key
        if key not in ids:
            ids[key] = f"{chapter_id}:s{len(ids) + 1:03d}"
        c.parent_id = ids[key]
