import { placeholders, type Db } from "./db.ts";
import { bigramTokens, contentTerms, norm, queryTerms } from "./tokenize.ts";

export interface SearchOpts {
  /** candidate chunks fetched per index per query (default 30) */
  k?: number;
  /** parents (context units) returned (default 5) */
  parents?: number;
  /** diversity cap: max parents from one book (default 3) */
  maxPerBook?: number;
  bookIds?: string[];
  includeReferences?: boolean;
  /** rankings (best first) from other retrievers, e.g. vector search; fused by RRF */
  extraRankings?: string[][];
}

export interface Note {
  level: string;
  code: string;
  message: string;
  source: string;
}

export interface ParentResult {
  parent_id: string;
  book_id: string;
  book_title: string;
  edition: string | null;
  publisher: string | null;
  pub_year: number | null;
  chapter_id: string;
  section_title: string | null;
  author: string | null;
  path: string;
  page_start: number | null;
  page_end: number | null;
  text: string;
  score: number;
  matched: { chunk_id: string; page_label: string; kind: string; provenance: string }[];
  numeric_critical: boolean;
  has_transcriber_aid: boolean;
  text_reliability: string;
  notes: Note[];
  refs: { label: string; text: string; pmid: string | null }[];
}

const RRF_K = 60;
const q = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/** FTS5 MATCH expression for the bigram index (covers CJK terms >= 2 chars and whole Latin words). */
export function biMatch(query: string): string | null {
  const phrases = queryTerms(query)
    .map((t) => bigramTokens(t))
    .filter((t) => t.length > 0)
    .map((t) => q(t.join(" ")));
  return phrases.length ? phrases.join(" OR ") : null;
}

/** FTS5 MATCH expression for the trigram index (substring match, terms >= 3 chars only). */
export function triMatch(query: string): string | null {
  const phrases = queryTerms(query)
    .map((t) => norm(t))
    .filter((t) => [...t].length >= 3)
    .map(q);
  return phrases.length ? phrases.join(" OR ") : null;
}

function filters(opts: SearchOpts): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (!opts.includeReferences) parts.push("c.kind <> 'references'");
  if (opts.bookIds?.length) {
    parts.push(`c.book_id IN (${placeholders(opts.bookIds.length)})`);
    params.push(...opts.bookIds);
  }
  return { sql: parts.length ? " AND " + parts.join(" AND ") : "", params };
}

async function ftsRank(db: Db, table: "chunks_bi" | "chunks_tri", match: string, k: number, opts: SearchOpts): Promise<string[]> {
  const f = filters(opts);
  const rows = await db.all<{ chunk_id: string }>(
    `SELECT ${table}.chunk_id AS chunk_id FROM ${table}
       JOIN chunks c ON c.chunk_id = ${table}.chunk_id
      WHERE ${table} MATCH ?${f.sql}
      ORDER BY bm25(${table}) LIMIT ?`,
    match,
    ...f.params,
    k,
  );
  return rows.map((r) => r.chunk_id);
}

async function likeFallback(db: Db, query: string, k: number, opts: SearchOpts): Promise<string[]> {
  const terms = queryTerms(query).map(norm);
  if (!terms.length) return [];
  const f = filters(opts);
  const cond = terms.map(() => "c.index_text LIKE ? ESCAPE '\\'").join(" AND ");
  const params = terms.map((t) => `%${t.replace(/[\\%_]/g, "\\$&")}%`);
  const rows = await db.all<{ chunk_id: string }>(
    `SELECT c.chunk_id AS chunk_id FROM chunks c WHERE ${cond}${f.sql} LIMIT ?`,
    ...params,
    ...f.params,
    k,
  );
  return rows.map((r) => r.chunk_id);
}

export function rrf(rankings: string[][], weights?: number[]): Map<string, number> {
  const score = new Map<string, number>();
  rankings.forEach((list, li) => {
    const w = weights?.[li] ?? 1;
    list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + w / (RRF_K + rank + 1)));
  });
  return score;
}

/** A literal query that matches fewer chunks than this triggers the relaxed (content-word) retry. */
const MIN_STRICT_HITS = 3;
const RELAXED_WEIGHT = 0.5;

let triWarned = false;

async function lexicalLists(db: Db, query: string, k: number, opts: SearchOpts): Promise<string[][]> {
  const lists: string[][] = [];
  const bm = biMatch(query);
  const tm = triMatch(query);
  if (bm) lists.push(await ftsRank(db, "chunks_bi", bm, k, opts));
  if (tm) {
    // The trigram index only adds Latin/CJK substring recall. If this D1 build lacks the trigram tokenizer (or the
    // table was not created), degrade to the bigram index instead of failing every search.
    try {
      lists.push(await ftsRank(db, "chunks_tri", tm, k, opts));
    } catch (e) {
      if (!triWarned) {
        triWarned = true;
        console.warn(`trigram index unavailable, continuing with bigram only: ${(e as Error).message}`);
      }
    }
  }
  return lists;
}

/** Lexical retrieval over one or more keyword queries.  Returns chunk ids with fused scores (best first). */
export async function searchChunkIds(db: Db, queries: string[], opts: SearchOpts = {}): Promise<[string, number][]> {
  const k = opts.k ?? 30;
  const lists: string[][] = [];
  const weights: number[] = [];
  const add = (l: string[], w = 1) => {
    if (l.length) {
      lists.push(l);
      weights.push(w);
    }
  };
  for (const query of queries) for (const l of await lexicalLists(db, query, k, opts)) add(l);
  for (const r of opts.extraRankings ?? []) add(r);
  let fused = rrf(lists, weights);

  if (fused.size < MIN_STRICT_HITS) {
    // A sentence-like query ("感度と特異度の違いを教えて") is one exact-phrase term and finds nothing.
    // Retry with its content words (split at hiragana/punctuation), at lower weight.
    for (const query of queries) {
      const terms = contentTerms(query);
      if (!terms.length || terms.join(" ") === norm(query).trim()) continue;
      for (const l of await lexicalLists(db, terms.join(" "), k, opts)) add(l, RELAXED_WEIGHT);
    }
    fused = rrf(lists, weights);
  }
  if (fused.size === 0) {
    // 1-character CJK terms etc. are invisible to both indexes: last resort substring scan
    const lists2: string[][] = [];
    for (const query of queries) lists2.push(await likeFallback(db, query, 20, opts));
    fused = rrf(lists2.filter((l) => l.length));
  }
  return [...fused.entries()].sort((a, b) => b[1] - a[1]);
}

const SURFACED = ["W_RELIABILITY", "I_TRANSCRIBER_FLAG", "I_CHUNK_NOTE", "W_CITE_UNRESOLVED", "W_TABLE_COLS", "W_PAGE_REGRESSION"];

interface ChunkRow {
  chunk_id: string;
  parent_id: string;
  book_id: string;
  kind: string;
  provenance: string;
  page_label: string;
}

/** Small-to-big retrieval: search small chunks, return their (page-annotated) parent sections. */
export async function searchParents(db: Db, queries: string[], opts: SearchOpts = {}): Promise<ParentResult[]> {
  const ranked = (await searchChunkIds(db, queries, opts)).slice(0, 45);
  if (!ranked.length) return [];
  const ids = ranked.map(([id]) => id);
  const chunkRows = await db.all<ChunkRow>(
    `SELECT chunk_id, parent_id, book_id, kind, provenance, page_label FROM chunks WHERE chunk_id IN (${placeholders(ids.length)})`,
    ...ids,
  );
  const byId = new Map(chunkRows.map((r) => [r.chunk_id, r]));

  // parent score: best chunk + 0.3 x the rest (rewards parents supported by several chunks)
  const agg = new Map<string, { scores: number[]; matched: ParentResult["matched"]; book: string }>();
  for (const [id, s] of ranked) {
    const r = byId.get(id);
    if (!r) continue;
    const a = agg.get(r.parent_id) ?? { scores: [], matched: [], book: r.book_id };
    a.scores.push(s);
    a.matched.push({ chunk_id: id, page_label: r.page_label, kind: r.kind, provenance: r.provenance });
    agg.set(r.parent_id, a);
  }
  const scored = [...agg.entries()]
    .map(([pid, a]) => {
      const sorted = [...a.scores].sort((x, y) => y - x);
      return { pid, score: sorted[0] + 0.3 * sorted.slice(1).reduce((x, y) => x + y, 0), a };
    })
    .sort((x, y) => y.score - x.score);

  const want = opts.parents ?? 5;
  const cap = opts.maxPerBook ?? 3;
  const perBook = new Map<string, number>();
  const picked: typeof scored = [];
  for (const s of scored) {
    const n = perBook.get(s.a.book) ?? 0;
    if (n >= cap) continue;
    perBook.set(s.a.book, n + 1);
    picked.push(s);
    if (picked.length >= want) break;
  }
  if (!picked.length) return [];
  return hydrateParents(
    db,
    picked.map((p) => ({ pid: p.pid, score: p.score, matched: p.a.matched })),
  );
}

export async function getParent(db: Db, parentId: string): Promise<ParentResult | null> {
  return (await hydrateParents(db, [{ pid: parentId, score: 0, matched: [] }]))[0] ?? null;
}

async function hydrateParents(
  db: Db,
  picked: { pid: string; score: number; matched: ParentResult["matched"] }[],
): Promise<ParentResult[]> {
  const pids = picked.map((p) => p.pid);
  const ph = placeholders(pids.length);

  const parents = await db.all<any>(
    `SELECT p.parent_id, p.book_id, p.chapter_id, p.path, p.page_start, p.page_end, p.text,
            b.title AS book_title, b.edition, b.publisher, b.pub_year,
            ch.text_reliability, s.title AS section_title, s.author, p.section_id
       FROM parents p
       JOIN books b ON b.book_id = p.book_id
       JOIN chapters ch ON ch.chapter_id = p.chapter_id
       LEFT JOIN sections s ON s.section_id = p.section_id
      WHERE p.parent_id IN (${ph})`,
    ...pids,
  );
  const flags = await db.all<{ parent_id: string; nc: number; aid: number }>(
    `SELECT parent_id, MAX(numeric_critical) AS nc, MAX(CASE WHEN provenance='transcriber' THEN 1 ELSE 0 END) AS aid
       FROM chunks WHERE parent_id IN (${ph}) GROUP BY parent_id`,
    ...pids,
  );
  const flagBy = new Map(flags.map((f) => [f.parent_id, f]));

  const secIds = [...new Set(parents.map((p: any) => p.section_id).filter(Boolean))];
  const chIds = [...new Set(parents.map((p: any) => p.chapter_id))];
  const issues = await db.all<any>(
    `SELECT i.chunk_id, i.section_id, i.chapter_id, i.level, i.code, i.message, i.source,
            c.parent_id AS chunk_parent
       FROM issues i LEFT JOIN chunks c ON c.chunk_id = i.chunk_id
      WHERE (i.source <> 'ingest' OR i.code IN (${placeholders(SURFACED.length)}))
        AND ( c.parent_id IN (${ph})
           OR (i.chunk_id IS NULL AND i.section_id IN (${placeholders(secIds.length || 1)}))
           OR (i.chunk_id IS NULL AND i.section_id IS NULL AND i.chapter_id IN (${placeholders(chIds.length)})) )`,
    ...SURFACED,
    ...pids,
    ...(secIds.length ? secIds : ["-"]),
    ...chIds,
  );
  const refs = await db.all<any>(
    `SELECT DISTINCT c.parent_id, r.label, r.text, r.pmid
       FROM chunks c JOIN chunk_refs cr ON cr.chunk_id = c.chunk_id JOIN refs r ON r.ref_id = cr.ref_id
      WHERE c.parent_id IN (${ph})`,
    ...pids,
  );

  const out: ParentResult[] = [];
  for (const pick of picked) {
    const p = parents.find((x: any) => x.parent_id === pick.pid);
    if (!p) continue;
    const fl = flagBy.get(pick.pid);
    const notes: Note[] = issues
      .filter((i: any) => i.chunk_parent === pick.pid || (i.chunk_id == null && (i.section_id === p.section_id || (i.section_id == null && i.chapter_id === p.chapter_id))))
      .map((i: any) => ({ level: i.level, code: i.code, message: i.message, source: i.source }));
    const seen = new Set<string>();
    const uniqNotes = notes.filter((n) => (seen.has(n.code + n.message) ? false : (seen.add(n.code + n.message), true)));
    out.push({
      parent_id: p.parent_id,
      book_id: p.book_id,
      book_title: p.book_title,
      edition: p.edition,
      publisher: p.publisher,
      pub_year: p.pub_year,
      chapter_id: p.chapter_id,
      section_title: p.section_title,
      author: p.author,
      path: p.path,
      page_start: p.page_start,
      page_end: p.page_end,
      text: p.text,
      score: pick.score,
      matched: pick.matched,
      numeric_critical: !!fl?.nc,
      has_transcriber_aid: !!fl?.aid,
      text_reliability: p.text_reliability ?? "",
      notes: uniqNotes,
      refs: refs
        .filter((r: any) => r.parent_id === pick.pid)
        .slice(0, 12)
        .map((r: any) => ({ label: r.label, text: r.text, pmid: r.pmid })),
    });
  }
  return out;
}
