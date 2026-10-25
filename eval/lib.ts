// Evaluation library (docs/enhancement-plan.md T1-8; docs/evaluation.md).  Pure functions + two search backends,
// shared by eval/run_eval.ts (retrieval: hit@k / MRR, with and without the dictionary) and eval/run_ask_eval.ts
// (answers: citations, gold pages, must-mention words, saying "not found").  Tested in worker/test/eval.test.ts.
import type { Db } from "../worker/src/db.ts";
import { scanIdentifiers } from "../worker/src/idguard.ts";
import { getParent, searchParents } from "../worker/src/search.ts";
import type { TermGroup } from "../worker/src/synonyms.ts";

// ---------------------------------------------------------------------------------- questions
export interface Expect {
  /** every string occurs in the returned section */
  text_contains?: string[];
  /** printed pages; the section's page range must include one of them */
  pages?: number[];
  book_id?: string;
}

export interface Question {
  id: string;
  group: string;
  /** "high": a miss here could change a clinical decision; listed first */
  severity: "high" | "normal";
  /** what search_books would send (retrieval evaluation) */
  queries: string[];
  /** the question as the doctor would type it (answer evaluation; falls back to the queries) */
  question?: string;
  expect: Expect;
  /** answer evaluation: words the answer should contain */
  must_mention?: string[];
  /** the books are not expected to cover it: the answer should say it was not found */
  negative?: boolean;
  note?: string;
}

const PLACEHOLDER = /BOOK_ID|（先生が書く/;

/**
 * Parses a questions file (JSON Lines; blank lines and lines starting with # are skipped).  Collects every problem and
 * throws once.  A line that still holds a template placeholder, or text that looks like a patient identifier, is
 * rejected: question files follow docs/clinical-use.md (no names, no IDs) even though they stay on the doctor's PC.
 */
export function parseQuestions(text: string): Question[] {
  const out: Question[] = [];
  const errors: string[] = [];
  const ids = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const at = `line ${i + 1}`;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch (e) {
      errors.push(`${at}: invalid JSON (${(e as Error).message})`);
      return;
    }
    const where = typeof o?.id === "string" && o.id ? `${at} (${o.id})` : at;
    if (typeof o?.id !== "string" || !o.id) errors.push(`${at}: "id" is required`);
    else if (ids.has(o.id)) errors.push(`${where}: duplicate id`);
    else ids.add(o.id);
    const queries = Array.isArray(o?.queries) ? o.queries.filter((x: unknown) => typeof x === "string" && x.trim()) : [];
    if (!queries.length || queries.length > 5) errors.push(`${where}: "queries" must hold 1-5 non-empty strings`);
    const severity = o?.severity ?? "normal";
    if (severity !== "high" && severity !== "normal") errors.push(`${where}: "severity" must be "high" or "normal"`);
    const expect: Expect = o?.expect && typeof o.expect === "object" ? o.expect : {};
    if (expect.pages && !(Array.isArray(expect.pages) && expect.pages.every((p) => Number.isInteger(p)))) errors.push(`${where}: "expect.pages" must be integers`);
    if (!o?.negative && !expect.pages?.length && !expect.text_contains?.length && !expect.book_id) {
      errors.push(`${where}: give at least one of expect.pages / expect.text_contains / expect.book_id (or "negative": true)`);
    }
    const texts = [...queries, o?.question, ...(o?.must_mention ?? []), o?.note, ...(expect.text_contains ?? []), expect.book_id].filter((t) => typeof t === "string");
    if (texts.some((t) => PLACEHOLDER.test(t))) errors.push(`${where}: still the template example (replace BOOK_ID / 「（先生が書く…）」)`);
    const hits = [...new Set(texts.flatMap((t) => scanIdentifiers(t).map((h) => h.label)))];
    if (hits.length) errors.push(`${where}: looks like a patient identifier (${hits.join("、")}). Remove it (docs/clinical-use.md)`);
    out.push({
      id: o?.id,
      group: typeof o?.group === "string" && o.group ? o.group : "all",
      severity,
      queries,
      question: typeof o?.question === "string" ? o.question : undefined,
      expect,
      must_mention: Array.isArray(o?.must_mention) ? o.must_mention.filter((x: unknown) => typeof x === "string") : undefined,
      negative: o?.negative === true,
      note: typeof o?.note === "string" ? o.note : undefined,
    });
  });
  if (errors.length) throw new Error(`questions file has ${errors.length} problem(s):\n  ` + errors.join("\n  "));
  return out;
}

// ---------------------------------------------------------------------------------- retrieval
export interface Hit {
  parent_id: string;
  book_id: string;
  page_start: number | null;
  page_end: number | null;
  page_label: string;
  path: string;
}

export interface Backend {
  search(queries: string[], o: { parents: number; expand: boolean }): Promise<Hit[]>;
  text(parentId: string): Promise<string>;
}

/** "p.12" / "p.10-11" -> numbers; anything else -> nulls */
export function parsePageLabel(label: string): { page_start: number | null; page_end: number | null } {
  const m = /^p\.(\d+)(?:-(\d+))?$/.exec((label ?? "").trim());
  if (!m) return { page_start: null, page_end: null };
  return { page_start: Number(m[1]), page_end: Number(m[2] ?? m[1]) };
}

const label = (a: number | null, b: number | null) => (a == null ? "" : b != null && b !== a ? `p.${a}-${b}` : `p.${a}`);

/** Local SQLite built by ingest.  `dictionary` overrides the built-in one when expansion is on (tests). */
export function dbBackend(db: Db, opts: { dictionary?: TermGroup[] } = {}): Backend {
  const texts = new Map<string, string>();
  return {
    async search(queries, { parents, expand }) {
      const res = await searchParents(db, queries, { parents, maxPerBook: parents, dictionary: expand ? opts.dictionary : [] });
      for (const p of res) texts.set(p.parent_id, p.text);
      return res.map((p) => ({ parent_id: p.parent_id, book_id: p.book_id, page_start: p.page_start, page_end: p.page_end, page_label: label(p.page_start, p.page_end), path: p.path }));
    },
    async text(id) {
      if (!texts.has(id)) texts.set(id, (await getParent(db, id))?.text ?? "");
      return texts.get(id)!;
    },
  };
}

/**
 * Headers for a Worker behind Cloudflare Access (docs/enhancement-plan.md T1-2): an Access service token (CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET, from
 * the environment only) makes Access add the Worker's second lock for a script.  Neither set = none.  Only one set is an error (a half token would be
 * refused by Access without saying why).
 */
export function accessHeaders(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const id = env.CF_ACCESS_CLIENT_ID?.trim();
  const secret = env.CF_ACCESS_CLIENT_SECRET?.trim();
  if (!id && !secret) return {};
  if (!id || !secret) throw new Error("set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET (or neither)");
  return { "cf-access-client-id": id, "cf-access-client-secret": secret };
}

/** The deployed Worker: /api/search (no LLM, free, not counted in the daily cap) + /api/parent for text checks. */
export function apiBackend(base: string, token: string, fetchImpl: typeof fetch = fetch): Backend {
  const root = base.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", ...accessHeaders() };
  const texts = new Map<string, string>();
  const fail = async (res: Response, what: string) => {
    const j: any = await res.json().catch(() => ({}));
    throw new Error(`${what}: HTTP ${res.status}${j?.error ? ` ${j.error}` : ""}`);
  };
  return {
    async search(queries, { parents, expand }) {
      const res = await fetchImpl(`${root}/api/search`, { method: "POST", headers, body: JSON.stringify({ queries, parents, max_per_book: parents, expand }) });
      if (!res.ok) await fail(res, "/api/search");
      const j: any = await res.json();
      return (j.results ?? []).map((r: any) => ({ parent_id: r.parent_id, book_id: r.book_id, page_label: r.page_label ?? "", path: r.path ?? "", ...parsePageLabel(r.page_label) }));
    },
    async text(id) {
      if (!texts.has(id)) {
        const res = await fetchImpl(`${root}/api/parent/${encodeURIComponent(id)}`, { headers });
        if (!res.ok) await fail(res, "/api/parent");
        texts.set(id, ((await res.json()) as any).text ?? "");
      }
      return texts.get(id)!;
    },
  };
}

export async function isCorrect(h: Hit, e: Expect, text: () => Promise<string>): Promise<boolean> {
  if (e.book_id && h.book_id !== e.book_id) return false;
  if (e.pages?.length) {
    const a = h.page_start ?? -1;
    const b = h.page_end ?? a;
    if (!e.pages.some((x) => x >= a && x <= b)) return false;
  }
  if (e.text_contains?.length) {
    const t = await text();
    if (!e.text_contains.every((s) => t.includes(s))) return false;
  }
  return true;
}

export interface RetrievalResult {
  q: Question;
  /** 1-based rank of the first correct section, null = miss; undefined for negative questions (not scored) */
  rank: number | null | undefined;
  hits: Hit[];
}

export async function evalRetrieval(backend: Backend, questions: Question[], o: { parents: number; expand: boolean }): Promise<RetrievalResult[]> {
  const out: RetrievalResult[] = [];
  for (const q of questions) {
    const hits = await backend.search(q.queries, o);
    if (q.negative) {
      out.push({ q, rank: undefined, hits });
      continue;
    }
    let rank: number | null = null;
    for (let i = 0; i < hits.length; i++) {
      if (await isCorrect(hits[i], q.expect, () => backend.text(hits[i].parent_id))) {
        rank = i + 1;
        break;
      }
    }
    out.push({ q, rank, hits });
  }
  return out;
}

export interface Stat {
  n: number;
  h1: number;
  h3: number;
  hN: number;
  rr: number;
}

/** Per group, per severity ("severity:high") and "ALL".  Negative questions are not scored. */
export function metrics(results: RetrievalResult[]): Map<string, Stat> {
  const m = new Map<string, Stat>();
  const bump = (k: string, rank: number | null) => {
    const s = m.get(k) ?? { n: 0, h1: 0, h3: 0, hN: 0, rr: 0 };
    s.n++;
    if (rank !== null) {
      if (rank <= 1) s.h1++;
      if (rank <= 3) s.h3++;
      s.hN++;
      s.rr += 1 / rank;
    }
    m.set(k, s);
  };
  for (const r of results) {
    if (r.rank === undefined) continue;
    bump(r.q.group, r.rank);
    bump(`severity:${r.q.severity}`, r.rank);
    bump("ALL", r.rank);
  }
  return m;
}

// ---------------------------------------------------------------------------------- answers
export interface AskCitation {
  kind: string;
  book_id?: string;
  page?: string | null;
  title?: string;
}

export interface AskOutcome {
  kind: "final" | "degraded" | "error" | "refused" | "limit" | "http_error";
  status: number;
  answer: string;
  citations: AskCitation[];
  searched_books?: boolean;
  message?: string;
  usage?: Record<string, number>;
}

/** One /api/ask call, read to the end of its SSE stream. */
export async function askOnce(
  base: string,
  token: string,
  q: Question,
  o: { web?: boolean; model?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<AskOutcome> {
  const res = await fetchImpl(`${base.replace(/\/+$/, "")}/api/ask`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...accessHeaders() },
    body: JSON.stringify({ question: q.question ?? q.queries.join(" "), web: !!o.web, ...(o.model ? { model: o.model } : {}) }),
  });
  if (!res.ok || !res.body) {
    const j: any = await res.json().catch(() => ({}));
    const kind = j?.code === "possible_identifier" ? "refused" : j?.code === "daily_limit" ? "limit" : "http_error";
    return { kind, status: res.status, answer: "", citations: [], message: j?.error ?? `HTTP ${res.status}` };
  }
  const text = await res.text();
  let deltas = "";
  let out: AskOutcome = { kind: "error", status: res.status, answer: "", citations: [], message: "stream ended without a result" };
  for (const raw of text.split("\n\n")) {
    const data = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    const ev = JSON.parse(data);
    if (ev.t === "delta") deltas += ev.text;
    else if (ev.t === "reset") deltas = "";
    else if (ev.t === "final") {
      out = {
        kind: "final",
        status: res.status,
        answer: ev.blocks.map((b: any) => b.text).join(""),
        citations: ev.blocks.flatMap((b: any) => b.citations ?? []),
        searched_books: ev.searched_books,
        usage: ev.usage,
      };
    } else if (ev.t === "degraded") out = { kind: "degraded", status: res.status, answer: deltas, citations: [], message: ev.message };
    else if (ev.t === "error") out = { kind: "error", status: res.status, answer: deltas, citations: [], message: ev.message };
  }
  return out;
}

const ABSTAIN = /見つかりませんでした|見つからなかった|記載が見つから|記載はありません|記載がありません|記載がない|記載は見当たら/;
const nf = (s: string) => s.normalize("NFKC").toLowerCase();

export interface AskScore {
  book_citations: number;
  /** a book citation falls on a gold page (null when the question has no gold pages) */
  cited_gold: boolean | null;
  mention_hit: string[];
  mention_miss: string[];
  /** the answer says the books did not have it */
  abstained: boolean;
}

export function scoreAsk(q: Question, o: AskOutcome): AskScore {
  const book = o.citations.filter((c) => c.kind === "book");
  let cited_gold: boolean | null = null;
  if (q.expect.pages?.length) {
    cited_gold = book.some((c) => {
      if (q.expect.book_id && c.book_id !== q.expect.book_id) return false;
      const { page_start, page_end } = parsePageLabel(c.page ?? "");
      return page_start != null && q.expect.pages!.some((x) => x >= page_start && x <= (page_end ?? page_start));
    });
  }
  const ans = nf(o.answer);
  const words = q.must_mention ?? [];
  return {
    book_citations: book.length,
    cited_gold,
    mention_hit: words.filter((w) => ans.includes(nf(w))),
    mention_miss: words.filter((w) => !ans.includes(nf(w))),
    abstained: ABSTAIN.test(o.answer),
  };
}
