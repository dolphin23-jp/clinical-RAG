// Evaluation of the extraction from a pasted memo (docs/enhancement-plan.md 8.15).  It calls the deployed Worker's /api/extract, so it needs the
// real model and costs a few requests (each counts in the daily cap).  Nothing is stored by the Worker; the results are printed and, with --out,
// written to a file (put it under work/, which git ignores: the memos are yours).
//   MEDBOOK_TOKEN=... node --no-warnings eval/run_extract_eval.ts --api https://<worker> eval/extract.local.jsonl [--verbose] [--out work/extract_eval.json]
//
// Reading the result: "forbidden" is the number that matters (a proposal for a question the memo does not support: an unmentioned finding made
// "none"/"present", an order made a thing done).  The target is 0; the exit code is 1 when it is not.  "wrong" (a proposal with another value than
// the expected one) is the next worst; "missing" and "extra" are for you to judge (a missing one costs a tap; an extra one is checked by the
// screen's confirmation, and may be right).  Cases: eval/extract.template.jsonl.
import { readFileSync, writeFileSync } from "node:fs";
import { parseCases, scoreCase, summarize, type CaseScore, type GotProposal } from "./extract_lib.ts";

const args: string[] = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const positional = args.filter((a, i) => !a.startsWith("--") && !["--api", "--out"].includes(args[i - 1] ?? ""));
const apiBase = opt("--api");
const path = positional[0];
const token = process.env.MEDBOOK_TOKEN ?? "";
if (!apiBase || !path) {
  console.error("usage: MEDBOOK_TOKEN=... node --no-warnings eval/run_extract_eval.ts --api https://<worker> <cases.jsonl> [--verbose] [--out work/extract_eval.json]");
  process.exit(2);
}
if (token.length < 16) {
  console.error("set the access token in the environment variable MEDBOOK_TOKEN (the APP_TOKEN of the Worker)");
  process.exit(2);
}
const api = apiBase as string; // (checked above)
const cases = parseCases(readFileSync(path, "utf-8"));
// @ts-ignore the screen's schema is plain JavaScript (no declaration file); only its commit is read
const { FLOW_SCHEMA_SOURCE } = (await import("../web/flow-schema.js")) as { FLOW_SCHEMA_SOURCE: { commit: string } };
const verbose = args.includes("--verbose");

const scores: CaseScore[] = [];
const raw: unknown[] = [];
let cacheRead = 0;
let input = 0;
for (const c of cases) {
  const t0 = Date.now();
  const res = await fetch(`${api.replace(/\/$/, "")}/api/extract`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ flow: c.flow, schema: FLOW_SCHEMA_SOURCE.commit, text: c.text }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`${c.id}: HTTP ${res.status} ${j.error ?? ""}`);
    process.exitCode = 1;
    continue;
  }
  const proposals: GotProposal[] = Array.isArray(j.proposals) ? j.proposals : [];
  const s = scoreCase(c, proposals);
  scores.push(s);
  raw.push({ id: c.id, ms: Date.now() - t0, proposals, dropped: j.dropped, usage: j.usage });
  cacheRead += j.usage?.cache_read_input_tokens ?? 0;
  input += j.usage?.input_tokens ?? 0;
  const flag = s.forbidden.length ? "  ★forbidden" : s.wrong.length ? "  !wrong" : "";
  console.log(`${c.id}: hit ${s.hits.length} / missing ${s.missing.length} / wrong ${s.wrong.length} / extra ${s.extra.length} / forbidden ${s.forbidden.length}  (${Date.now() - t0} ms)${flag}`);
  if (verbose || s.forbidden.length || s.wrong.length) {
    for (const q of s.forbidden) console.log(`    forbidden: ${q} was proposed`);
    for (const w of s.wrong) console.log(`    wrong: ${w.q} got ${JSON.stringify(w.got)} want ${JSON.stringify(w.want)}`);
  }
  if (verbose) {
    for (const q of s.missing) console.log(`    missing: ${q}`);
    for (const q of s.extra) console.log(`    extra: ${q}`);
  }
}
const sum = summarize(scores);
console.log("");
console.log(`cases ${sum.cases}  expected ${sum.expected}  hit ${sum.hits}  missing ${sum.missing}  wrong ${sum.wrong}  extra ${sum.extra}  FORBIDDEN ${sum.forbidden}`);
console.log(`input tokens ${input} (read from the cache ${cacheRead}): the first request of a flow writes the cache; later ones read it`);
if (sum.forbidden) console.log(`forbidden in: ${sum.casesWithForbidden.join(", ")} (the target is 0: read the memo and the rule that let it through)`);
const out = opt("--out");
if (out) writeFileSync(out, JSON.stringify({ summary: sum, scores, raw }, null, 2));
if (sum.forbidden) process.exitCode = 1;
