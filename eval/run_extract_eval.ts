// Evaluation of the extraction from a pasted memo (docs/enhancement-plan.md 8.15).  It needs the real model and costs a few requests.  Nothing is
// stored by the Worker; the results are printed and, with --out, written to a file (put it under work/, which git ignores: the memos are yours).
//
// Two ways to run it:
//   against the deployed Worker (the whole path: the token, the daily cap, the Worker's own environment; each case counts in the daily cap):
//     MEDBOOK_TOKEN=... node --no-warnings eval/run_extract_eval.ts --api https://<worker> eval/extract.local.jsonl [--verbose] [--out work/extract_eval.json]
//   --local: straight to the Anthropic API from this machine, with no Worker, no deploy and no token of the app (a key in ANTHROPIC_API_KEY, or in the
//     variable named by --key-env).  It runs the same code as the Worker (the prompt, the schema, the checks of the answer: worker/src/extract.ts),
//     so the model's behaviour and the share of answers the checks keep are the same; it does not exercise the Worker's route, token or cap.
//     [--model <id>] (default: $EXTRACT_MODEL, else claude-sonnet-5-5, the Worker's default)
//     ANTHROPIC_API_KEY=... node --no-warnings eval/run_extract_eval.ts --local eval/extract.invented.jsonl --verbose --out work/extract_eval.json
//
// Reading the result: "forbidden" is the number that matters (a proposal for a question the memo does not support: an unmentioned finding made
// "none"/"present", an order made a thing done).  The target is 0; the exit code is 1 when it is not.  "wrong" (a proposal with another value than
// the expected one) is the next worst; "missing" and "extra" are for you to judge (a missing one costs a tap; an extra one is checked by the
// screen's confirmation, and may be right).  Cases: eval/extract.template.jsonl (the format), eval/extract.invented.jsonl (a starting set).
import { readFileSync, writeFileSync } from "node:fs";
import { CATALOG_SOURCE } from "../worker/src/extract-catalog.ts";
import { ExtractInputError, ExtractUpstreamError, parseExtractRequest, runExtract } from "../worker/src/extract.ts";
import { parseCases, scoreCase, summarize, type CaseScore, type GotProposal } from "./extract_lib.ts";

const args: string[] = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const WITH_VALUE = ["--api", "--out", "--key-env", "--model", "--anthropic-base"];
const positional = args.filter((a, i) => !a.startsWith("--") && !WITH_VALUE.includes(args[i - 1] ?? ""));
const local = args.includes("--local");
const apiBase = opt("--api");
const path = positional[0];
const token = process.env.MEDBOOK_TOKEN ?? "";
const keyEnv = opt("--key-env") ?? "ANTHROPIC_API_KEY";
const apiKey = process.env[keyEnv] ?? "";
if (!path || (!local && !apiBase)) {
  console.error("usage: MEDBOOK_TOKEN=... node --no-warnings eval/run_extract_eval.ts --api https://<worker> <cases.jsonl> [--verbose] [--out work/extract_eval.json]");
  console.error("   or: ANTHROPIC_API_KEY=... node --no-warnings eval/run_extract_eval.ts --local [--model <id>] <cases.jsonl> [--verbose] [--out work/extract_eval.json]");
  process.exit(2);
}
if (local && apiKey.length < 16) {
  console.error(`--local needs the Anthropic API key in the environment variable ${keyEnv} (the key is not printed, not written to --out, and not sent anywhere but the Anthropic API)`);
  process.exit(2);
}
if (!local && token.length < 16) {
  console.error("set the access token in the environment variable MEDBOOK_TOKEN (the APP_TOKEN of the Worker)");
  process.exit(2);
}
const cases = parseCases(readFileSync(path, "utf-8"));
// @ts-ignore the screen's schema is plain JavaScript (no declaration file); only its commit is read
const { FLOW_SCHEMA_SOURCE } = (await import("../web/flow-schema.js")) as { FLOW_SCHEMA_SOURCE: { commit: string } };
const verbose = args.includes("--verbose");
// the screen's own model: which group (together / one by one) each proposal would be in
// @ts-ignore plain JavaScript, no declaration file
const { FLOWS } = (await import("../web/flow-schema.js")) as { FLOWS: Record<string, any> };
// @ts-ignore plain JavaScript, no declaration file
const MODEL = (await import("../web/extract-model.js")) as { reviewProposals: Function; classify: Function };
const riskOf = (flowId: string, proposals: GotProposal[], text: string): Map<string, "low" | "high"> => {
  const flow = FLOWS[flowId];
  const { items } = MODEL.reviewProposals(flow, proposals, text);
  return new Map((MODEL.classify(flow, {}, {}, items) as { qid: string; risk: "low" | "high" }[]).map((i) => [i.qid, i.risk]));
};

interface Got {
  proposals: GotProposal[];
  dropped?: Record<string, number>;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  model?: string;
}
/** One case, asked of the deployed Worker or (--local) of the Anthropic API.  Throws an Error whose message says what went wrong. */
async function extractOne(c: { flow: string; text: string }): Promise<Got> {
  if (!local) {
    const res = await fetch(`${(apiBase as string).replace(/\/$/, "")}/api/extract`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ flow: c.flow, schema: FLOW_SCHEMA_SOURCE.commit, text: c.text }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status} ${j.error ?? ""}`);
    return { proposals: Array.isArray(j.proposals) ? j.proposals : [], dropped: j.dropped, usage: j.usage, model: j.model };
  }
  try {
    const parsed = parseExtractRequest({ flow: c.flow, schema: CATALOG_SOURCE.commit, text: c.text });
    const model = opt("--model") ?? (process.env.EXTRACT_MODEL || "claude-sonnet-5-5");
    const r = await runExtract({ apiKey, model, apiBase: opt("--anthropic-base") }, parsed);
    return { proposals: r.proposals as GotProposal[], dropped: r.dropped, usage: r.usage, model: r.model ?? model };
  } catch (e) {
    if (e instanceof ExtractInputError || e instanceof ExtractUpstreamError) throw new Error(e.message);
    throw e;
  }
}

if (local) console.log(`mode: local (the Anthropic API, key from ${keyEnv}); the Worker's route, token and daily cap are not involved`);
const scores: CaseScore[] = [];
const raw: unknown[] = [];
const models = new Set<string>();
let cacheRead = 0;
let input = 0;
let output = 0;
let slowest = 0;
let totalMs = 0;
for (const c of cases) {
  const t0 = Date.now();
  let got: Got;
  try {
    got = await extractOne(c);
  } catch (e) {
    console.error(`${c.id}: ${(e as Error).message}`);
    process.exitCode = 1;
    continue;
  }
  const ms = Date.now() - t0;
  slowest = Math.max(slowest, ms);
  totalMs += ms;
  const proposals = got.proposals;
  const s = scoreCase(c, proposals, riskOf(c.flow, proposals, c.text));
  scores.push(s);
  raw.push({ id: c.id, ms, proposals, dropped: got.dropped, usage: got.usage, model: got.model });
  if (got.model) models.add(got.model);
  cacheRead += got.usage?.cache_read_input_tokens ?? 0;
  input += got.usage?.input_tokens ?? 0;
  output += got.usage?.output_tokens ?? 0;
  const flag = s.forbiddenTogether.length ? "  ★★forbidden in the 'confirm together' group" : s.forbidden.length ? "  ★forbidden" : s.wrong.length ? "  !wrong" : "";
  const dropped = Object.values(got.dropped ?? {}).reduce((a, n) => a + (n || 0), 0);
  console.log(`${c.id}: hit ${s.hits.length} / missing ${s.missing.length} / wrong ${s.wrong.length} / extra ${s.extra.length} / forbidden ${s.forbidden.length}  (${ms} ms${dropped ? `, ${dropped} dropped by the checks` : ""})${flag}`);
  if (verbose || s.forbidden.length || s.wrong.length) {
    for (const q of s.forbidden) console.log(`    forbidden: ${q} was proposed${s.forbiddenTogether.includes(q) ? " (and the screen would put it in the 'confirm together' group)" : ""}`);
    for (const w of s.wrong) console.log(`    wrong: ${w.q} got ${JSON.stringify(w.got)} want ${JSON.stringify(w.want)}`);
  }
  if (verbose) {
    for (const q of s.missing) console.log(`    missing: ${q}`);
    for (const q of s.extra) console.log(`    extra: ${q}`);
    if (dropped) console.log(`    dropped by the checks: ${JSON.stringify(got.dropped)}`);
  }
}
const sum = summarize(scores);
console.log("");
console.log(`cases ${sum.cases}  expected ${sum.expected}  hit ${sum.hits}  missing ${sum.missing}  wrong ${sum.wrong}  extra ${sum.extra}  FORBIDDEN ${sum.forbidden} (in the 'confirm together' group: ${sum.forbiddenTogether})`);
console.log(`tokens: input ${input} (read from the cache ${cacheRead}), output ${output}: the first request of a flow writes the cache; later ones read it`);
if (scores.length) console.log(`time per case: ${Math.round(totalMs / scores.length)} ms on average, ${slowest} ms at most${models.size ? `; answered by ${[...models].join(", ")}` : ""}`);
if (sum.forbidden) console.log(`forbidden in: ${sum.casesWithForbidden.join(", ")} (the target is 0: read the memo and the rule that let it through)`);
const out = opt("--out");
if (out) writeFileSync(out, JSON.stringify({ mode: local ? "local" : "worker", summary: sum, scores, raw }, null, 2));
if (sum.forbidden) process.exitCode = 1;
