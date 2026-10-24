// Numeric transcription-error worksheet, served to the app so the doctor can work on an iPad
// (docs/enhancement-plan.md T1-7; docs/evaluation.md).  Twin of scripts/sample_numeric.py for the PC: the number
// extraction is shared and pinned by tests/vectors/numeric_expr.json; the draw uses its own seeded generator, so the
// same seed gives a different sample here and in the Python script (use one or the other for a measurement).
// Read-only: the doctor's judgments stay on the device (doctor's decision, 2026-10-24); nothing is written here.
import { placeholders, type Db } from "./db.ts";

// ---------------------------------------------------------------------------------- number expressions
const NUM = String.raw`\d+(?:[.,]\d+)?`;
const RANGE = String.raw`${NUM}(?:\s*[-–〜~～]\s*${NUM})?`;
const UNIT_BASE =
  "μg|µg|mcg|ug|mg|ng|kg|g|mEq|mmol|μmol|µmol|mOsm|mosm|IU|単位|mL|ml|dL|dl|L|mmHg|Torr|%|倍|回|錠|アンプル|バイアル|" +
  "時間|分|秒|日|週|hr|h|min|sec";
const UNIT_DEN = String.raw`kg|日|時間|時|分|min|hr|h|dL|dl|L|mL|ml|回|day|m2|m²|μL|µL|uL|mm3|mm³|1\.73\s*m2|1\.73\s*m²`;
const UNIT = String.raw`(?:${UNIT_BASE})(?![A-Za-z])(?:\s*/\s*(?:${UNIT_DEN})(?![A-Za-z]))*`;
// the number must not continue a word or another number ("HCO3- 18" is not a range 3-18; "SpO2" is not a 2)
const EXPR = new RegExp(
  String.raw`(?<before>[≧≦≥≤<>＜＞]\s*)?(?<num>(?<![A-Za-z0-9.,])${RANGE})\s*(?<unit>${UNIT})?(?:\s*(?<after>以上|以下|未満|超))?`,
  "g",
);
const NOT_A_VALUE_BEFORE = /(p\.|P\.|頁|図|表|第|PMID:?\s*)$/;

export const norm = (s: string): string => s.normalize("NFKC");

/** [start, end, expression] for every number with a unit or a comparison, in NFKC-normalised text. */
export function numberExpressions(text: string): [number, number, string][] {
  const out: [number, number, string][] = [];
  for (const m of text.matchAll(EXPR)) {
    const g = m.groups ?? {};
    if (!(g.unit || g.before || g.after)) continue;
    const s = m.index!;
    const e = s + m[0].trimEnd().length;
    if (NOT_A_VALUE_BEFORE.test(text.slice(Math.max(0, s - 4), s))) continue;
    out.push([s, e, text.slice(s, e).trim()]);
  }
  return out;
}

// ---------------------------------------------------------------------------------- sampling
export const primaryFlag = (flags: string | null | undefined): "dose_unit" | "lab_threshold" =>
  (flags ?? "").split(",").includes("dose_unit") ? "dose_unit" : "lab_threshold";

/** Split `total` as evenly as possible, never more than a key has; leftovers go to keys with room (same as the Python twin). */
export function allocate(total: number, sizes: Record<string, number>): Record<string, number> {
  const keys = Object.keys(sizes).sort();
  const alloc: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  let remaining = Math.min(total, keys.reduce((a, k) => a + sizes[k], 0));
  while (remaining > 0) {
    const room = keys.filter((k) => alloc[k] < sizes[k]);
    if (!room.length) break;
    const share = Math.max(1, Math.floor(remaining / room.length));
    for (const k of room) {
      const take = Math.min(share, sizes[k] - alloc[k], remaining);
      alloc[k] += take;
      remaining -= take;
      if (remaining === 0) break;
    }
  }
  return alloc;
}

/** mulberry32: small deterministic generator, enough for drawing a reproducible sample */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(items: T[], n: number, next: () => number): T[] {
  const a = [...items];
  for (let i = 0; i < Math.min(n, a.length); i++) {
    const j = i + Math.floor(next() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

export interface Candidate {
  chunk_id: string;
  book_id: string;
  flags: string | null;
}

/** Stratified draw: even across books, then even across the two flags inside each book. */
export function draw(candidates: Candidate[], nChunks: number, seed: number): string[] {
  const next = rng(seed);
  const byBook = new Map<string, Map<string, string[]>>();
  for (const c of [...candidates].sort((a, b) => (a.chunk_id < b.chunk_id ? -1 : a.chunk_id > b.chunk_id ? 1 : 0))) {
    const f = byBook.get(c.book_id) ?? new Map<string, string[]>();
    const flag = primaryFlag(c.flags);
    f.set(flag, [...(f.get(flag) ?? []), c.chunk_id]);
    byBook.set(c.book_id, f);
  }
  const perBook = allocate(nChunks, Object.fromEntries([...byBook].map(([b, f]) => [b, [...f.values()].reduce((a, l) => a + l.length, 0)])));
  const picked: string[] = [];
  for (const book of [...byBook.keys()].sort()) {
    const strata = byBook.get(book)!;
    const perFlag = allocate(perBook[book], Object.fromEntries([...strata].map(([f, ids]) => [f, ids.length])));
    for (const flag of [...strata.keys()].sort()) picked.push(...pick(strata.get(flag)!, perFlag[flag], next));
  }
  return picked;
}

// ---------------------------------------------------------------------------------- worksheet
export interface WorksheetRow {
  no: string;
  chunk_id: string;
  parent_id: string;
  book_id: string;
  book_title: string;
  page_label: string;
  flag: string;
  number: string;
  /** text around the number; the number itself is between 【 and 】 */
  context: string;
  path: string;
}

const CONTEXT = 40;
const LIST_SQL =
  "SELECT c.chunk_id AS chunk_id, c.book_id AS book_id, c.numeric_flags AS flags FROM chunks c " +
  "WHERE c.numeric_critical = 1 AND c.provenance = 'book' AND c.kind NOT IN ('references', 'figure_aid')";
const DETAIL_SQL = (n: number) =>
  "SELECT c.chunk_id AS chunk_id, c.parent_id AS parent_id, c.book_id AS book_id, b.title AS book_title, c.page_label AS page_label, " +
  `c.numeric_flags AS flags, c.path AS path, c.text AS text FROM chunks c JOIN books b ON b.book_id = c.book_id WHERE c.chunk_id IN (${placeholders(n)})`;

export interface SampleOpts {
  chunks: number;
  perChunk: number;
  seed: number;
  bookIds?: string[];
}

export async function numericWorksheet(db: Db, o: SampleOpts): Promise<{ rows: WorksheetRow[]; drawn: number; candidates: number; empty: number }> {
  let cands = await db.all<Candidate>(LIST_SQL);
  if (o.bookIds?.length) cands = cands.filter((c) => o.bookIds!.includes(c.book_id));
  const ids = draw(cands, o.chunks, o.seed);
  const details: any[] = [];
  for (let i = 0; i < ids.length; i += 40) {
    const part = ids.slice(i, i + 40); // D1 binds at most 100 parameters per statement
    details.push(...(await db.all(DETAIL_SQL(part.length), ...part)));
  }
  const order = new Map(ids.map((id, i) => [id, i]));
  details.sort((a, b) => (order.get(a.chunk_id) ?? 0) - (order.get(b.chunk_id) ?? 0));
  const rows: WorksheetRow[] = [];
  const withRows = new Set<string>();
  for (const ch of details) {
    const text = norm(String(ch.text ?? ""));
    const seen = new Set<string>();
    let taken = 0;
    for (const [s, e, expr] of numberExpressions(text)) {
      if (seen.has(expr)) continue;
      seen.add(expr);
      rows.push({
        no: `N${String(rows.length + 1).padStart(3, "0")}`,
        chunk_id: ch.chunk_id,
        parent_id: ch.parent_id ?? "",
        book_id: ch.book_id,
        book_title: ch.book_title ?? "",
        page_label: ch.page_label ?? "",
        flag: primaryFlag(ch.flags),
        number: expr,
        context: (text.slice(Math.max(0, s - CONTEXT), s) + "【" + text.slice(s, e) + "】" + text.slice(e, e + CONTEXT)).replace(/\n/g, " "),
        path: ch.path ?? "",
      });
      withRows.add(ch.chunk_id);
      if (++taken >= o.perChunk) break;
    }
  }
  return { rows, drawn: ids.length, candidates: cands.length, empty: ids.length - withRows.size };
}
