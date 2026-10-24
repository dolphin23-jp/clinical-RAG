// Retrieval evaluation (docs/evaluation.md).  No LLM is called, so it costs nothing and is not counted in the daily cap.
//   node --no-warnings eval/run_eval.ts <db.sqlite> <questions.jsonl> [--parents 5] [--verbose] [--compare-dict]
//   node --no-warnings eval/run_eval.ts --api https://<worker> <questions.jsonl> [...]     (token in env MEDBOOK_TOKEN)
//
// --api searches the deployed index (all books; the importer's work/library.sqlite only holds the last import).
// --compare-dict runs every question with and without the search dictionary (worker/src/synonyms.ts) and lists the
// questions whose rank changed.  Question format: eval/clinical.template.jsonl.
// Metrics: hit@1, hit@3, hit@N, MRR (first correct section), per group, per severity and overall.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Db } from "../worker/src/db.ts";
import { apiBackend, dbBackend, evalRetrieval, metrics, parseQuestions, type Backend, type Question, type RetrievalResult, type Stat } from "./lib.ts";

function openDb(path: string): Db {
  const d = new DatabaseSync(path, { readOnly: true });
  return {
    async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
      return d.prepare(sql).all(...(params as any[])) as unknown as T[];
    },
  };
}

const args: string[] = process.argv.slice(2);
function die(msg: string): never {
  console.error(msg);
  process.exit(2);
  throw new Error(msg);
}
const flag = (name: string) => args.includes(name);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const positional = args.filter((a, i) => !a.startsWith("--") && !["--parents", "--api"].includes(args[i - 1] ?? ""));
const apiBase = opt("--api");
const [dbPath, qPath] = apiBase ? [undefined, positional[0]] : positional;
if (!qPath || (!apiBase && !dbPath)) {
  console.error("usage: node eval/run_eval.ts <db.sqlite> <questions.jsonl> [--parents N] [--verbose] [--compare-dict]");
  console.error("       node eval/run_eval.ts --api https://<worker> <questions.jsonl> [...]   (env MEDBOOK_TOKEN)");
  process.exit(2);
}
const nParents = Number(opt("--parents")) || 5;
const verbose = flag("--verbose");

let backend: Backend;
if (apiBase) {
  const token = process.env.MEDBOOK_TOKEN ?? "";
  if (token.length < 16) {
    console.error("set the access token in the environment variable MEDBOOK_TOKEN (the APP_TOKEN of the Worker)");
    process.exit(2);
  }
  backend = apiBackend(apiBase, token);
} else backend = dbBackend(openDb(dbPath!));

function load(path: string): Question[] {
  try {
    return parseQuestions(readFileSync(path, "utf-8"));
  } catch (e) {
    return die((e as Error).message);
  }
}
const questions = load(qPath);
// severity high first, so a miss that could change a decision is read first
questions.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1));

const fmtRank = (r: number | null | undefined) => (r === undefined ? "neg" : r === null ? "MISS" : `@${r}`);
function show(results: RetrievalResult[]) {
  for (const r of results) {
    console.log(`${fmtRank(r.rank).padEnd(5)} ${r.q.id.padEnd(10)} [${r.q.group.padEnd(10)}]${r.q.severity === "high" ? "[high]" : "      "} ${r.q.queries.join(" | ")}`);
    if (r.rank === null || r.rank === undefined || verbose) for (const h of r.hits.slice(0, 3)) console.log(`        -> ${h.book_id} ${h.page_label}  ${h.path}`);
  }
}
const pct = (x: number, n: number) => (n ? ((100 * x) / n).toFixed(0) : "-").padStart(4) + "%";
const order = (m: Map<string, Stat>) => [...m.keys()].sort((a, b) => (a === "ALL" ? 1 : b === "ALL" ? -1 : a.localeCompare(b)));
function table(m: Map<string, Stat>) {
  console.log(`\ngroup              n   hit@1   hit@3   hit@${nParents}   MRR`);
  for (const g of order(m)) {
    const s = m.get(g)!;
    console.log(`${g.padEnd(17)} ${String(s.n).padStart(3)}  ${pct(s.h1, s.n)}   ${pct(s.h3, s.n)}   ${pct(s.hN, s.n)}   ${(s.rr / s.n).toFixed(2)}`);
  }
}

const withDict = await evalRetrieval(backend, questions, { parents: nParents, expand: true });
show(withDict);
table(metrics(withDict));
const negatives = withDict.filter((r) => r.rank === undefined).length;
if (negatives) console.log(`\n(negative questions: ${negatives}, not scored here: check their answers with eval/run_ask_eval.ts)`);

if (flag("--compare-dict")) {
  const without = await evalRetrieval(backend, questions, { parents: nParents, expand: false });
  const a = metrics(withDict);
  const b = metrics(without);
  console.log(`\nwith vs without the dictionary            hit@1          hit@3          MRR`);
  for (const g of order(a)) {
    const x = a.get(g)!;
    const y = b.get(g) ?? { n: 0, h1: 0, h3: 0, hN: 0, rr: 0 };
    console.log(`${g.padEnd(30)} ${pct(x.h1, x.n)} / ${pct(y.h1, y.n)}   ${pct(x.h3, x.n)} / ${pct(y.h3, y.n)}   ${(x.rr / x.n).toFixed(2)} / ${(y.n ? y.rr / y.n : 0).toFixed(2)}`);
  }
  const changed = withDict
    .map((r, i) => ({ id: r.q.id, on: r.rank, off: without[i].rank }))
    .filter((c) => c.on !== undefined && c.on !== c.off);
  console.log(changed.length ? "\nrank changed by the dictionary (with <- without):" : "\nno rank changed by the dictionary");
  for (const c of changed) console.log(`  ${c.id.padEnd(10)} ${fmtRank(c.on)} <- ${fmtRank(c.off)}`);
}
