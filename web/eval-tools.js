// Pure helpers for the measurement / evaluation screen (web/tools.js).  Browser twins of the PC tools:
//   summarizeNumeric + wilson      <-> scripts/sample_numeric.py summarize / wilson  (tests/vectors/numeric_report.json)
//   retrievalMetrics, scoreAsk ... <-> eval/lib.ts metrics / scoreAsk / parsePageLabel (worker/test/tools.test.ts)
// No DOM, no network, no storage here.

export function wilson(k, n, z = 1.96) {
  if (!n) return [NaN, NaN];
  const p = k / n;
  const den = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * rows: worksheet rows ({ no, book_id, flag, chunk_id }); judged: { [no]: { verdict: "ok"|"err"|"skip", kind, shift } }.
 * Same shape and rules as summarize() in scripts/sample_numeric.py.
 */
export function summarizeNumeric(rows, judged) {
  const s = { rows: rows.length, unjudged: 0, ok: 0, err: 0, skip: 0, by_book: {}, by_flag: {}, chunks: [0, 0], kinds: {}, page_shift: [0, 0] };
  const chunks = new Map();
  for (const r of rows) {
    const j = judged[r.no];
    const v = j && j.verdict;
    if (!v) {
      s.unjudged++;
      continue;
    }
    s[v]++;
    if (v === "skip") continue;
    const e = v === "err" ? 1 : 0;
    for (const [agg, key] of [[s.by_book, r.book_id], [s.by_flag, r.flag]]) {
      agg[key] = agg[key] || [0, 0];
      agg[key][0] += e;
      agg[key][1] += 1;
    }
    chunks.set(r.chunk_id, (chunks.get(r.chunk_id) || false) || !!e);
    if (e && j.kind) s.kinds[j.kind] = (s.kinds[j.kind] || 0) + 1;
    s.page_shift[1]++;
    if (j.shift) s.page_shift[0]++;
  }
  s.chunks = [[...chunks.values()].filter(Boolean).length, chunks.size];
  return s;
}

export function parsePageLabel(label) {
  const m = /^p\.(\d+)(?:-(\d+))?$/.exec(String(label || "").trim());
  if (!m) return { page_start: null, page_end: null };
  return { page_start: Number(m[1]), page_end: Number(m[2] || m[1]) };
}

/**
 * results: [{ group, severity, negative, rank_on, rank_off }] from /api/eval/retrieval.  key "on"|"off".
 * Returns { [group | "severity:x" | "ALL"]: { n, h1, h3, hN, rr } }; negative questions are not scored (as eval/lib.ts).
 */
export function retrievalMetrics(results, key) {
  const m = {};
  const bump = (k, rank) => {
    const s = (m[k] = m[k] || { n: 0, h1: 0, h3: 0, hN: 0, rr: 0 });
    s.n++;
    if (rank !== null && rank !== undefined) {
      if (rank <= 1) s.h1++;
      if (rank <= 3) s.h3++;
      s.hN++;
      s.rr += 1 / rank;
    }
  };
  for (const r of results) {
    if (r.negative) continue;
    const rank = key === "off" ? r.rank_off : r.rank_on;
    bump(r.group, rank);
    bump(`severity:${r.severity}`, rank);
    bump("ALL", rank);
  }
  return m;
}

const ABSTAIN = /見つかりませんでした|見つからなかった|記載が見つから|記載はありません|記載がありません|記載がない|記載は見当たら/;
const nf = (s) => String(s || "").normalize("NFKC").toLowerCase();

/** q: a parsed question line; o: { answer, citations } from /api/ask.  Same rules as scoreAsk in eval/lib.ts. */
export function scoreAsk(q, o) {
  const book = (o.citations || []).filter((c) => c.kind === "book");
  const expect = q.expect || {};
  let cited_gold = null;
  if (expect.pages && expect.pages.length) {
    cited_gold = book.some((c) => {
      if (expect.book_id && c.book_id !== expect.book_id) return false;
      const { page_start, page_end } = parsePageLabel(c.page || "");
      return page_start !== null && expect.pages.some((x) => x >= page_start && x <= (page_end ?? page_start));
    });
  }
  const ans = nf(o.answer);
  const words = q.must_mention || [];
  return {
    book_citations: book.length,
    cited_gold,
    mention_hit: words.filter((w) => ans.includes(nf(w))),
    mention_miss: words.filter((w) => !ans.includes(nf(w))),
    abstained: ABSTAIN.test(o.answer || ""),
  };
}

/** "12, 13 14" -> [12, 13, 14]; anything that is not a whole number is dropped */
export function pagesFrom(text) {
  return String(text || "")
    .split(/[\s,、，]+/)
    .filter((t) => /^\d+$/.test(t))
    .map(Number);
}

/** "a, b\nc" -> ["a", "b", "c"] */
export function listFrom(text) {
  return String(text || "")
    .split(/[\n,、，]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}
