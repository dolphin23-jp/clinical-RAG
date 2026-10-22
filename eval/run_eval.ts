// Retrieval evaluation harness.
//   node eval/run_eval.ts <db.sqlite> <questions.jsonl> [--parents 5] [--verbose]
//
// questions.jsonl, one JSON object per line:
//   {"id":"q1","group":"keyword","queries":["尤度比 使い方"],
//    "expect":{"text_contains":["尤度比"],"pages":[10,11,12],"book_id":"rk4"}}
// A returned parent counts as correct when ALL given expectations hold:
//   text_contains - every string occurs in the parent text
//   pages         - the parent's page range intersects this list   (optional)
//   book_id       - the parent comes from this book                 (optional)
// Metrics: hit@1, hit@3, hit@N, MRR (first correct parent), per group and overall.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Db } from "../worker/src/db.ts";
import { searchParents, type ParentResult } from "../worker/src/search.ts";

interface Question {
  id: string;
  group?: string;
  queries: string[];
  expect: { text_contains?: string[]; pages?: number[]; book_id?: string };
  note?: string;
}

function openDb(path: string): Db {
  const d = new DatabaseSync(path, { readOnly: true });
  return {
    async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
      return d.prepare(sql).all(...(params as any[])) as unknown as T[];
    },
  };
}

function correct(p: ParentResult, e: Question["expect"]): boolean {
  if (e.book_id && p.book_id !== e.book_id) return false;
  if (e.text_contains && !e.text_contains.every((s) => p.text.includes(s))) return false;
  if (e.pages?.length) {
    const a = p.page_start ?? -1;
    const b = p.page_end ?? a;
    if (!e.pages.some((x) => x >= a && x <= b)) return false;
  }
  return true;
}

const args = process.argv.slice(2);
const [dbPath, qPath] = args;
if (!dbPath || !qPath) {
  console.error("usage: node eval/run_eval.ts <db.sqlite> <questions.jsonl> [--parents N] [--verbose]");
  process.exit(2);
}
const nParents = Number(args[args.indexOf("--parents") + 1]) || 5;
const verbose = args.includes("--verbose");
const db = openDb(dbPath);
const questions: Question[] = readFileSync(qPath, "utf-8")
  .split("\n")
  .filter((l) => l.trim() && !l.startsWith("#"))
  .map((l) => JSON.parse(l));

const groups = new Map<string, { n: number; h1: number; h3: number; hN: number; rr: number }>();
const bump = (g: string, rank: number | null) => {
  const s = groups.get(g) ?? { n: 0, h1: 0, h3: 0, hN: 0, rr: 0 };
  s.n++;
  if (rank !== null) {
    if (rank <= 1) s.h1++;
    if (rank <= 3) s.h3++;
    s.hN++;
    s.rr += 1 / rank;
  }
  groups.set(g, s);
};

for (const q of questions) {
  const res = await searchParents(db, q.queries, { parents: nParents, maxPerBook: nParents });
  const idx = res.findIndex((p) => correct(p, q.expect));
  const rank = idx >= 0 ? idx + 1 : null;
  bump(q.group ?? "all", rank);
  bump("ALL", rank);
  const mark = rank === null ? "MISS" : `@${rank}`;
  console.log(`${mark.padEnd(5)} ${q.id.padEnd(8)} [${(q.group ?? "").padEnd(10)}] ${q.queries.join(" | ")}`);
  if (rank === null || verbose) {
    for (const p of res.slice(0, 3)) console.log(`        -> ${p.page_start}-${p.page_end}  ${p.path}`);
  }
}

console.log("\ngroup        n   hit@1   hit@3   hit@" + nParents + "   MRR");
for (const [g, s] of [...groups.entries()].sort((a, b) => (a[0] === "ALL" ? 1 : b[0] === "ALL" ? -1 : a[0].localeCompare(b[0])))) {
  const pct = (x: number) => ((100 * x) / s.n).toFixed(0).padStart(4) + "%";
  console.log(`${g.padEnd(11)} ${String(s.n).padStart(3)}  ${pct(s.h1)}   ${pct(s.h3)}   ${pct(s.hN)}   ${(s.rr / s.n).toFixed(2)}`);
}
