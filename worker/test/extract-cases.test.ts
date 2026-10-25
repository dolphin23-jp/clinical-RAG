// The evaluation of the extraction (docs/evaluation.md 3.3b): the committed case files are consistent with the question list (a typo in an id
// would otherwise show up as a "missing" or pass as a "must not" that can never fail), and the runner (eval/run_extract_eval.ts) works
// end to end in both of its modes, against a stub of the Anthropic API / the Worker (no real model is called here).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CATALOG } from "../src/extract-catalog.ts";
import * as X from "../src/extract.ts";
import { parseCases, type ExtractCase } from "../../eval/extract_lib.ts";
import { REPO } from "./nodeDb.ts";

const CASE_FILES = ["eval/extract.template.jsonl", "eval/extract.invented.jsonl"];
const load = (rel: string): ExtractCase[] => parseCases(readFileSync(join(REPO, rel), "utf-8"));

// ---------------------------------------------------------------------------------- the committed case files
for (const rel of CASE_FILES) {
  test(`${rel}: every flow, question and value is in the question list, and the memo holds the numbers and times it is expected to give`, () => {
    const cases = load(rel);
    assert.ok(cases.length >= 4, "a file of cases is not empty");
    for (const c of cases) {
      const at = `${rel} ${c.id}`;
      const flow = CATALOG[c.flow];
      assert.ok(flow, `${at}: flow ${c.flow} is not in the list`);
      const byId = new Map(flow.questions.map((q) => [q.id, q]));
      assert.ok(c.text.length <= X.MAX_TEXT, `${at}: the memo is over the limit`);
      assert.ok(!/\d{4}\s*年|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(c.text.normalize("NFKC")), `${at}: a memo carries no date (use "2時間前")`);
      for (const q of c.must_not ?? []) assert.ok(byId.has(q), `${at}: must_not ${q} is not a question of ${c.flow}`);
      for (const [id, want] of Object.entries(c.expect)) {
        const q = byId.get(id);
        assert.ok(q, `${at}: expect ${id} is not a question of ${c.flow}`);
        const ids = new Set((q.options ?? []).map(([o]) => o));
        switch (q.type) {
          case "choice":
            assert.ok(typeof want === "string" && ids.has(want), `${at}: ${id}=${JSON.stringify(want)} is not an option`);
            break;
          case "multi": {
            const list = Array.isArray(want) ? want : [];
            assert.ok(list.length > 0 && list.every((o) => ids.has(o)), `${at}: ${id}=${JSON.stringify(want)} holds a value that is not an option`);
            for (const o of list) if (q.exclusive?.includes(o)) assert.equal(list.length, 1, `${at}: ${id}: ${o} is exclusive and goes alone`);
            break;
          }
          case "number":
            assert.ok(typeof want === "number" && Number.isFinite(want), `${at}: ${id} wants a number`);
            assert.ok(X.numberTokens(c.text).includes(want as number), `${at}: ${id}=${want} is not a number written in the memo`);
            break;
          case "time":
            assert.ok(typeof want === "string" && /^\d{2}:\d{2}$/.test(want), `${at}: ${id} wants "HH:MM"`);
            assert.ok(X.timesIn(c.text).includes(want as string), `${at}: ${id}=${want} is not a time written in the memo`);
            break;
          default:
            assert.fail(`${at}: ${id} is a text question: its value is the memo's own words, so it is not put in expect`);
        }
      }
    }
  });
}

test("the invented set is a spread, not four of one kind: several flows, and cases that expect nothing at all (plans, doubts) as well as cases that expect many", () => {
  const cases = load("eval/extract.invented.jsonl");
  assert.ok(new Set(cases.map((c) => c.flow)).size >= 4);
  assert.ok(cases.filter((c) => Object.keys(c.expect).length === 0).length >= 3, "cases that expect no proposal at all");
  assert.ok(cases.filter((c) => Object.keys(c.expect).length >= 6).length >= 3, "cases with many stated facts");
  assert.ok(cases.every((c) => (c.must_not ?? []).length >= 2), "every case says what the memo does not support");
});

// ---------------------------------------------------------------------------------- the runner, with stubs
const KEY = "sk-test-0123456789abcdefghij";
interface Seen {
  headers: IncomingMessage["headers"];
  url: string;
  body: any;
}
/** A stub of the Anthropic Messages API: answers every request with `answer(body)` and records what it was sent. */
async function stub(answer: (body: any) => unknown, status = 200): Promise<{ server: Server; base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (d) => (data += d));
    req.on("end", () => {
      const body = JSON.parse(data || "{}");
      seen.push({ headers: req.headers, url: req.url ?? "", body });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer(body)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}
const message = (proposals: unknown[]) => ({
  type: "message",
  model: "claude-sonnet-5-5",
  stop_reason: "end_turn",
  content: [{ type: "text", text: JSON.stringify({ proposals }) }],
  usage: { input_tokens: 900, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 700 },
});
function run(argv: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    // (an explicit environment: the runner must not pick up the developer's real key or token)
    const p = spawn("node", ["--no-warnings", "eval/run_extract_eval.ts", ...argv], { cwd: REPO, env: { PATH: process.env.PATH ?? "", ...env } });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}
const tmp = () => mkdtempSync(join(tmpdir(), "extract-eval-"));
const caseLine = (o: object) => JSON.stringify(o) + "\n";
const MEMO = "呼吸数28、室内気でSpO2 88%。";

test("runner --local: asks the Anthropic API directly with the key from the environment, scores the answers, and never prints or saves the key", async () => {
  const s = await stub(() => message([{ q: "rr", v: ["28"], frag: "呼吸数28" }, { q: "spo2", v: ["88"], frag: "SpO2 88%" }, { q: "o2", v: ["ra"], frag: "室内気" }]));
  try {
    const dir = tmp();
    const file = join(dir, "cases.jsonl");
    writeFileSync(file, caseLine({ id: "c1", flow: "emergency-department.dyspnea", text: MEMO, expect: { rr: 28, spo2: 88, o2: "ra" }, must_not: ["temp", "jvd"] }));
    const outFile = join(dir, "out.json");
    const r = await run(["--local", "--anthropic-base", s.base, "--out", outFile, file], { ANTHROPIC_API_KEY: KEY });
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /c1: hit 3 \/ missing 0 \/ wrong 0 \/ extra 0 \/ forbidden 0/);
    assert.match(r.out, /FORBIDDEN 0/);
    assert.match(r.out, /tokens: input 900 .*output 60/);
    assert.match(r.out, /answered by claude-sonnet-5-5/);
    // what was sent: the app's own request (same code as the Worker), with the key as the Anthropic API wants it
    assert.equal(s.seen.length, 1);
    assert.equal(s.seen[0].url, "/v1/messages");
    assert.equal(s.seen[0].headers["x-api-key"], KEY);
    assert.equal(s.seen[0].body.model, "claude-sonnet-5-5");
    assert.equal(s.seen[0].body.output_config.format.type, "json_schema");
    assert.ok(JSON.stringify(s.seen[0].body.messages).includes("呼吸数28"));
    // the key goes nowhere else
    const saved = readFileSync(outFile, "utf-8");
    assert.ok(!saved.includes(KEY) && !r.out.includes(KEY) && !r.err.includes(KEY));
    assert.equal(JSON.parse(saved).mode, "local");
  } finally {
    s.server.close();
  }
});

test("runner --local: --model chooses the model; a forbidden proposal (an unsupported question that passed the checks) is reported and the exit code is 1", async () => {
  // temp is proposed from a quote that holds a number but is about the respiratory rate
  const s = await stub(() => message([{ q: "temp", v: ["28"], frag: "呼吸数28" }]));
  try {
    const dir = tmp();
    const file = join(dir, "cases.jsonl");
    writeFileSync(file, caseLine({ id: "c2", flow: "emergency-department.dyspnea", text: MEMO, expect: {}, must_not: ["temp"] }));
    const r = await run(["--local", "--anthropic-base", s.base, "--model", "claude-haiku-5-5", file], { ANTHROPIC_API_KEY: KEY });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /forbidden: temp was proposed/);
    assert.match(r.out, /FORBIDDEN 1/);
    assert.equal(s.seen[0].body.model, "claude-haiku-5-5");
  } finally {
    s.server.close();
  }
});

test("runner --local: a quote that is not in the memo is dropped by the Worker's checks and shown as missing (not as a hit), and the count of dropped ones is printed", async () => {
  const s = await stub(() => message([{ q: "rr", v: ["28"], frag: "呼吸数は三十" }]));
  try {
    const dir = tmp();
    const file = join(dir, "cases.jsonl");
    writeFileSync(file, caseLine({ id: "c3", flow: "emergency-department.dyspnea", text: MEMO, expect: { rr: 28 }, must_not: [] }));
    const r = await run(["--local", "--anthropic-base", s.base, "--verbose", file], { ANTHROPIC_API_KEY: KEY });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /c3: hit 0 \/ missing 1 .*1 dropped by the checks/);
    assert.match(r.out, /dropped by the checks: .*"quote":1/);
  } finally {
    s.server.close();
  }
});

test("runner --local: an upstream error is reported for the case and the exit code is 1; no key → exit 2 and nothing is sent; a memo that looks like an identifier stops the run before anything is sent", async () => {
  const s = await stub(() => ({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), 401);
  try {
    const dir = tmp();
    const file = join(dir, "cases.jsonl");
    writeFileSync(file, caseLine({ id: "c4", flow: "emergency-department.dyspnea", text: MEMO, expect: {}, must_not: [] }));
    const bad = await run(["--local", "--anthropic-base", s.base, file], { ANTHROPIC_API_KEY: KEY });
    assert.equal(bad.code, 1);
    assert.match(bad.err, /c4: Anthropic API 401 \(authentication_error\)/);
    assert.ok(!bad.err.includes(KEY) && !bad.out.includes(KEY));

    const before = s.seen.length;
    const nokey = await run(["--local", "--anthropic-base", s.base, file], {});
    assert.equal(nokey.code, 2);
    assert.match(nokey.err, /ANTHROPIC_API_KEY/);
    assert.equal(s.seen.length, before, "nothing is sent without a key");

    // the cases file is read first: a memo with an identifier in it is refused at load, with nothing sent
    const idFile = join(dir, "id.jsonl");
    writeFileSync(idFile, caseLine({ id: "c4b", flow: "emergency-department.dyspnea", text: "患者ID 12345678。呼吸数28。", expect: {}, must_not: [] }));
    const refused = await run(["--local", "--anthropic-base", s.base, idFile], { ANTHROPIC_API_KEY: KEY });
    assert.notEqual(refused.code, 0);
    assert.match(refused.err, /holds an identifier/);
    assert.equal(s.seen.length, before, "nothing is sent for a memo with an identifier");

    // a different variable name can be chosen
    const named = await run(["--local", "--key-env", "MY_EVAL_KEY", "--anthropic-base", s.base, file], { MY_EVAL_KEY: KEY });
    assert.equal(named.code, 1, "reached the stub (which answers 401)");
    assert.equal(s.seen[s.seen.length - 1].headers["x-api-key"], KEY);
  } finally {
    s.server.close();
  }
});

test("runner without --local still asks the deployed Worker (token required) and reads its proposals", async () => {
  const s = await stub(() => ({ proposals: [{ q: "rr", v: "28", frag: "呼吸数28" }], dropped: { unknown: 0, quote: 0, value: 0, duplicate: 0, shape: 0 }, usage: { input_tokens: 10, output_tokens: 5 }, model: "claude-sonnet-5-5" }));
  try {
    const dir = tmp();
    const file = join(dir, "cases.jsonl");
    writeFileSync(file, caseLine({ id: "c5", flow: "emergency-department.dyspnea", text: MEMO, expect: { rr: 28 }, must_not: [] }));
    const r = await run(["--api", s.base, file], { MEDBOOK_TOKEN: "t".repeat(20) });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /c5: hit 1 \/ missing 0/);
    assert.equal(s.seen[0].url, "/api/extract");
    assert.equal(s.seen[0].headers.authorization, `Bearer ${"t".repeat(20)}`);
    const none = await run(["--api", s.base, file], {});
    assert.equal(none.code, 2);
    assert.match(none.err, /MEDBOOK_TOKEN/);
  } finally {
    s.server.close();
  }
});
