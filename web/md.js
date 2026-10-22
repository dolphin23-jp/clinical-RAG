// Tiny, dependency-free Markdown -> DOM renderer.
// Safety: every string reaches the DOM through textContent / createTextNode; no innerHTML anywhere.
// Supports what Claude answers and transcribed book text actually use:
//   headings, **bold**, `code`, [text](http(s) url), bullet/numbered lists (nested), pipe tables,
//   blockquotes, fenced code, horizontal rules, and (book mode) page markers / ■ sub-headings /
//   transcriber-aid labels.
// Citation chips are spliced in through private-use sentinels: CITE_OPEN + <group index> + CITE_CLOSE.

export const CITE_OPEN = "";
export const CITE_CLOSE = "";

const SENT_RE = /(\d+)/;
const TRAIL_SENT_RE = /((?:\d+)+)\s*$/;
const INLINE_SRC = /(\d+)|(\*\*[^*\n]+?\*\*)|(`[^`\n]+`)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const LIST_RE = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/;
const PAGE_MARK_RE = /^［(p\.[\d\-]+)］$/;
const AID_LABEL = "［転写者補助・原本の記述ではない］";

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export function inline(text, opts, parent) {
  // A fresh regex per call: inline() recurses (bold), and a shared /g regex would have its lastIndex reset by the
  // inner call, making the outer loop re-match the same span forever.
  const re = new RegExp(INLINE_SRC.source, "g");
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
    if (m[1]) {
      const idx = Number(SENT_RE.exec(m[1])[1]);
      const node = opts.onCite?.(idx);
      if (node) parent.append(node);
    } else if (m[2]) {
      const b = el("strong");
      inline(m[2].slice(2, -2), opts, b);
      parent.append(b);
    } else if (m[3]) {
      parent.append(el("code", null, m[3].slice(1, -1)));
    } else if (m[4]) {
      const mm = /^\[([^\]]+)\]\((.+)\)$/.exec(m[4]);
      const a = el("a", null, mm[1]);
      a.href = mm[2];
      a.rel = "noopener noreferrer";
      a.target = "_blank";
      parent.append(a);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

function splitRow(line) {
  let trailing = "";
  const t = TRAIL_SENT_RE.exec(line);
  if (t) {
    trailing = t[1];
    line = line.slice(0, t.index);
  }
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const cells = s.split("|").map((c) => c.trim());
  if (trailing) cells[cells.length - 1] += trailing;
  return cells;
}

const isTableStart = (lines, i) => i + 1 < lines.length && lines[i].includes("|") && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes("-");
const isFence = (l) => /^\s*```/.test(l);
const isHeading = (l) => /^#{1,6}\s+\S/.test(l);
const isHr = (l) => /^\s*([-*_])(\s*\1){2,}\s*$/.test(l) && !l.includes("|");
const isQuote = (l) => /^\s*>/.test(l);

function startsBlock(lines, i, book) {
  const l = lines[i];
  return (
    isFence(l) ||
    isHeading(l) ||
    isHr(l) ||
    isQuote(l) ||
    LIST_RE.test(l) ||
    isTableStart(lines, i) ||
    (book && (PAGE_MARK_RE.test(l.trim()) || l.startsWith("■ ") || l.trim() === AID_LABEL))
  );
}

function renderTable(rows, opts) {
  const wrap = el("div", "tbl");
  const table = el("table");
  const [head, , ...body] = rows;
  const thead = el("thead");
  const tr = el("tr");
  for (const c of splitRow(head)) {
    const th = el("th");
    inline(c, opts, th);
    tr.append(th);
  }
  thead.append(tr);
  const tbody = el("tbody");
  for (const r of body) {
    const row = el("tr");
    for (const c of splitRow(r)) {
      const td = el("td");
      inline(c, opts, td);
      row.append(td);
    }
    tbody.append(row);
  }
  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

function renderList(items, opts) {
  // items: [{indent, ordered, text}] -> nested ul/ol by indent
  const root = el(items[0].ordered ? "ol" : "ul");
  const stack = [{ indent: items[0].indent, list: root }];
  let lastLi = null;
  for (const it of items) {
    let top = stack[stack.length - 1];
    if (it.indent > top.indent + 1 && lastLi) {
      const nested = el(it.ordered ? "ol" : "ul");
      lastLi.append(nested);
      stack.push({ indent: it.indent, list: nested });
    } else {
      while (stack.length > 1 && it.indent < top.indent - 1) {
        stack.pop();
        top = stack[stack.length - 1];
      }
    }
    const li = el("li");
    inline(it.text, opts, li);
    stack[stack.length - 1].list.append(li);
    lastLi = li;
  }
  return root;
}

export function renderMarkdown(src, opts = {}) {
  const frag = document.createDocumentFragment();
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const book = !!opts.book;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (isFence(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) buf.push(lines[i++]);
      i++;
      const pre = el("pre");
      pre.append(el("code", null, buf.join("\n")));
      frag.append(pre);
      continue;
    }
    if (book) {
      const pm = PAGE_MARK_RE.exec(line.trim());
      if (pm) {
        frag.append(el("div", "pgmark", pm[1]));
        i++;
        continue;
      }
      if (line.trim() === AID_LABEL) {
        frag.append(el("div", "aid-label", "転写者補助（原本の記述ではない）"));
        i++;
        continue;
      }
      if (line.startsWith("■ ")) {
        const h = el("h4", "subhead");
        inline(line.slice(2), opts, h);
        frag.append(h);
        i++;
        continue;
      }
    }
    if (isHeading(line)) {
      const m = /^(#{1,6})\s+(.*)$/.exec(line);
      const h = el("h" + Math.min(6, Math.max(3, m[1].length + 1))); // #,## -> h3 ; ### -> h4 ...
      inline(m[2].trim(), opts, h);
      frag.append(h);
      i++;
      continue;
    }
    if (isHr(line)) {
      frag.append(el("hr"));
      i++;
      continue;
    }
    if (isTableStart(lines, i)) {
      const rows = [lines[i], lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(lines[i++]);
      frag.append(renderTable(rows, opts));
      continue;
    }
    if (isQuote(line)) {
      const buf = [];
      while (i < lines.length && isQuote(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      const bq = el("blockquote");
      bq.append(renderMarkdown(buf.join("\n"), opts));
      frag.append(bq);
      continue;
    }
    if (LIST_RE.test(line)) {
      const items = [];
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (m) {
          items.push({ indent: m[1].replace(/\t/g, "  ").length, ordered: /\d/.test(m[2]), text: m[3] });
          i++;
        } else if (items.length && lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && !startsBlock(lines, i, book)) {
          items[items.length - 1].text += " " + lines[i].trim(); // wrapped continuation of the previous item
          i++;
        } else break;
      }
      frag.append(renderList(items, opts));
      continue;
    }
    // paragraph: gather until blank line or the start of another block
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i, book)) buf.push(lines[i++]);
    const p = el("p");
    buf.forEach((l, k) => {
      if (k) p.append(el("br"));
      inline(l.trim(), opts, p);
    });
    frag.append(p);
  }
  return frag;
}

/** Plain text of markdown source, without citation sentinels (for the clipboard and chat history). */
export function stripCiteMarks(s) {
  return String(s).replace(/\d+/g, "");
}
