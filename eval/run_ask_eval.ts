// Answer evaluation against the deployed Worker (docs/evaluation.md).  THIS CALLS THE MODEL: it costs money (about
// 5-15 yen per question with Sonnet, README estimate, not measured) and counts toward the daily cap (DAILY_ASK_LIMIT).
//   node --no-warnings eval/run_ask_eval.ts --api https://<worker> <questions.jsonl> [--max N] [--only id1,id2] [--web] [--model M]
//     -> prints the plan and stops;  add --yes to run.   Token in env MEDBOOK_TOKEN.
//
// Per question: did the answer cite the books, did a citation fall on a gold page, which must-mention words appeared,
// and for negative questions whether the answer said the books did not have it.  Results (answer text included: it
// quotes the books) go to work/ask_eval/<timestamp>.jsonl, which is gitignored.  A daily-cap refusal stops the run.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { askOnce, parseQuestions, scoreAsk, type AskOutcome, type AskScore, type Question } from "./lib.ts";

const ROOT = resolve(import.meta.dirname, "..");
const args: string[] = process.argv.slice(2);
function die(msg: string): never {
  console.error(msg);
  process.exit(2);
  throw new Error(msg);
}
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const valued = new Set(["--api", "--max", "--only", "--model"]);
const positional = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1] ?? ""));
const apiBase = opt("--api");
const qPath = positional[0];
if (!apiBase || !qPath) die("usage: node eval/run_ask_eval.ts --api https://<worker> <questions.jsonl> [--max N] [--only a,b] [--web] [--model M] [--yes]");
const token = process.env.MEDBOOK_TOKEN ?? "";
if (token.length < 16) die("set the access token in the environment variable MEDBOOK_TOKEN (the APP_TOKEN of the Worker)");

function load(path: string): Question[] {
  try {
    return parseQuestions(readFileSync(path, "utf-8"));
  } catch (e) {
    return die((e as Error).message);
  }
}
let questions = load(qPath);
const only = opt("--only")?.split(",").filter(Boolean);
if (only?.length) questions = questions.filter((q) => only.includes(q.id));
questions.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1));
const max = Number(opt("--max")) || questions.length;
questions = questions.slice(0, max);
const web = args.includes("--web");
const model = opt("--model");

if (!args.includes("--yes")) {
  console.log(`${questions.length} question(s) would be sent to ${apiBase}/api/ask${web ? " with web search" : ""}${model ? ` (model ${model})` : ""}.`);
  console.log(`Rough cost: ${questions.length * 5}-${questions.length * 15} yen with Sonnet (README estimate, not measured)${web ? " + web search" : ""}.`);
  console.log(`They count toward the daily cap (DAILY_ASK_LIMIT). Add --yes to run.`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(ROOT, "work", "ask_eval");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `${stamp}.jsonl`);
const lines: string[] = [];
const rows: { q: Question; o: AskOutcome; s: AskScore }[] = [];

for (const q of questions) {
  let o: AskOutcome;
  try {
    o = await askOnce(apiBase, token, q, { web, model });
  } catch (e) {
    o = { kind: "http_error", status: 0, answer: "", citations: [], message: (e as Error).message };
  }
  const s = scoreAsk(q, o);
  rows.push({ q, o, s });
  lines.push(JSON.stringify({ id: q.id, group: q.group, severity: q.severity, negative: q.negative, outcome: o, score: s }));
  const gold = s.cited_gold === null ? "    " : s.cited_gold ? "gold" : "----";
  const mm = q.must_mention?.length ? ` mention ${s.mention_hit.length}/${q.must_mention.length}` : "";
  const neg = q.negative ? (s.abstained ? " said-not-found" : " ANSWERED-NEGATIVE") : "";
  console.log(`${o.kind.padEnd(9)} ${q.id.padEnd(10)} cites ${String(s.book_citations).padStart(2)} ${gold}${mm}${neg}${o.message ? `  (${o.message.slice(0, 80)})` : ""}`);
  if (o.kind === "limit") {
    console.log("daily cap reached: stopping (the rest were not sent)");
    break;
  }
}
writeFileSync(outPath, lines.join("\n") + "\n", "utf-8");

const answered = rows.filter((r) => r.o.kind === "final");
const pos = answered.filter((r) => !r.q.negative);
const withGold = pos.filter((r) => r.s.cited_gold !== null);
const mention = pos.filter((r) => r.q.must_mention?.length);
const negs = answered.filter((r) => r.q.negative);
const count = (k: AskOutcome["kind"]) => rows.filter((r) => r.o.kind === k).length;
console.log(`\nsent ${rows.length}: final ${count("final")}, degraded ${count("degraded")}, error ${count("error")}, refused ${count("refused")}, limit ${count("limit")}, http ${count("http_error")}`);
console.log(`answers citing the books: ${pos.filter((r) => r.s.book_citations > 0).length}/${pos.length}`);
if (withGold.length) console.log(`a citation on a gold page: ${withGold.filter((r) => r.s.cited_gold).length}/${withGold.length}`);
if (mention.length) {
  const hit = mention.reduce((a, r) => a + r.s.mention_hit.length, 0);
  const all = mention.reduce((a, r) => a + r.q.must_mention!.length, 0);
  console.log(`must-mention words found: ${hit}/${all}`);
}
if (negs.length) console.log(`negative questions answered "not found": ${negs.filter((r) => r.s.abstained).length}/${negs.length}`);
const high = rows.filter((r) => r.q.severity === "high" && (r.o.kind !== "final" || r.s.cited_gold === false || r.s.mention_miss.length));
if (high.length) console.log(`\nseverity high, to read first: ${high.map((r) => r.q.id).join(", ")}`);
console.log(`\nresults (with answer text): ${outPath}`);
