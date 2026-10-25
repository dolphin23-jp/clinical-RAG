// The evaluation tools (eval/lib.ts; docs/evaluation.md).  The API backend and the answer evaluation are exercised
// against the real handler with a scripted fake of the Anthropic API, so no network and no cost.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import {
  accessHeaders,
  apiBackend,
  askOnce,
  dbBackend,
  evalRetrieval,
  isCorrect,
  metrics,
  parsePageLabel,
  parseQuestions,
  scoreAsk,
  type Question,
} from "../../eval/lib.ts";
import type { Db } from "../src/db.ts";
import { handle, type AppDeps } from "../src/handler.ts";
import { buildFixtureDb, openDb, REPO } from "./nodeDb.ts";

let db: Db;
before(() => {
  db = openDb(buildFixtureDb());
});

const TOKEN = "test-token-0123456789abcdef";
const shim = (deps: Partial<AppDeps> = {}) =>
  (async (url: any, init?: any) => handle(new Request(url, init), { db, apiKey: "k", appToken: TOKEN, model: "m", ...deps })) as typeof fetch;
const line = (o: object) => JSON.stringify(o);

// ---------------------------------------------------------------------------------- Access service token (T1-2)
test("accessHeaders: an Access service token from the environment makes a script pass the Worker's second lock; none means no headers; half is an error", () => {
  assert.deepEqual(accessHeaders({}), {});
  assert.deepEqual(accessHeaders({ CF_ACCESS_CLIENT_ID: " id.access ", CF_ACCESS_CLIENT_SECRET: "sec" }), { "cf-access-client-id": "id.access", "cf-access-client-secret": "sec" });
  assert.throws(() => accessHeaders({ CF_ACCESS_CLIENT_ID: "id" }), /both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET/);
  assert.throws(() => accessHeaders({ CF_ACCESS_CLIENT_SECRET: "s" }), /both/);
  // the secret is never part of an error message
  try {
    accessHeaders({ CF_ACCESS_CLIENT_SECRET: "hunter2-secret" });
  } catch (e) {
    assert.doesNotMatch((e as Error).message, /hunter2/);
  }
});

// ---------------------------------------------------------------------------------- questions file
test("parseQuestions: comments and blank lines are skipped; defaults filled", () => {
  const qs = parseQuestions(["# comment", "", line({ id: "a", queries: ["ゼルニア値"], expect: { pages: [10] } })].join("\n"));
  assert.equal(qs.length, 1);
  assert.equal(qs[0].group, "all");
  assert.equal(qs[0].severity, "normal");
  assert.equal(qs[0].negative, false);
});

test("parseQuestions: every problem is reported with its line, at once", () => {
  const text = [
    line({ id: "a", queries: ["x"], expect: { pages: [1] } }),
    line({ id: "a", queries: ["x"], expect: { pages: [1] } }),
    line({ queries: ["x"], expect: { pages: [1] } }),
    line({ id: "c", queries: [], expect: { pages: [1] } }),
    line({ id: "d", queries: ["x"], severity: "urgent", expect: { pages: [1] } }),
    line({ id: "e", queries: ["x"], expect: {} }),
    "{not json",
  ].join("\n");
  assert.throws(
    () => parseQuestions(text),
    (e: Error) =>
      /6 problem/.test(e.message) && /line 2 \(a\): duplicate id/.test(e.message) && /line 3: "id" is required/.test(e.message) &&
      /line 4 \(c\): "queries"/.test(e.message) && /severity/.test(e.message) && /line 6 \(e\): give at least one/.test(e.message) && /line 7: invalid JSON/.test(e.message),
  );
});

test("parseQuestions: the shipped template is rejected as-is (placeholders) and every example is otherwise well-formed", () => {
  const text = readFileSync(join(REPO, "eval", "clinical.template.jsonl"), "utf-8");
  assert.throws(() => parseQuestions(text), (e: Error) => /template example/.test(e.message) && !/invalid JSON|"queries"|duplicate/.test(e.message));
});

test("parseQuestions: identifier-like text stops the run, and the message names only the kind", () => {
  const text = line({ id: "x", queries: ["患者ID 123456 高K血症"], expect: { pages: [1] } });
  assert.throws(() => parseQuestions(text), (e: Error) => /patient identifier/.test(e.message) && !e.message.includes("123456"));
  // age band, lab values, findings are fine
  assert.equal(parseQuestions(line({ id: "y", queries: ["70代 K 6.8 心電図"], question: "70代男性、K 6.8、テント状T波", expect: { pages: [1] } })).length, 1);
});

// ---------------------------------------------------------------------------------- retrieval
test("parsePageLabel and isCorrect", async () => {
  assert.deepEqual(parsePageLabel("p.10-11"), { page_start: 10, page_end: 11 });
  assert.deepEqual(parsePageLabel("p.12"), { page_start: 12, page_end: 12 });
  assert.deepEqual(parsePageLabel(""), { page_start: null, page_end: null });
  const h = { parent_id: "p", book_id: "fx", page_start: 10, page_end: 11, page_label: "p.10-11", path: "" };
  const t = async () => "ゼルニア値が基準の半分以下";
  assert.equal(await isCorrect(h, { pages: [11] }, t), true);
  assert.equal(await isCorrect(h, { pages: [12] }, t), false);
  assert.equal(await isCorrect(h, { book_id: "other" }, t), false);
  assert.equal(await isCorrect(h, { text_contains: ["半分以下", "ゼルニア値"] }, t), true);
  assert.equal(await isCorrect(h, { text_contains: ["架空薬X"] }, t), false);
});

const QS: Question[] = parseQuestions(
  [
    line({ id: "def", group: "keyword", severity: "high", queries: ["ゼルニア値 定義"], expect: { book_id: "fx", text_contains: ["半分以下"] } }),
    line({ id: "drug", group: "keyword", queries: ["架空薬X"], expect: { pages: [12] } }),
    line({ id: "syn", group: "concept", queries: ["zernia level"], expect: { text_contains: ["ゼルニア値"] } }),
    line({ id: "miss", group: "concept", queries: ["ぬるぽぬるぽ存在しない語"], expect: { pages: [99] } }),
    line({ id: "neg", group: "negative", negative: true, queries: ["ゼルニア値"], expect: {} }),
  ].join("\n"),
);

test("evalRetrieval + metrics on the fixture (local backend), with a test dictionary", async () => {
  const backend = dbBackend(db, { dictionary: [{ terms: ["ゼルニア値", "zernia level"] }] });
  const on = await evalRetrieval(backend, QS, { parents: 5, expand: true });
  const rank = Object.fromEntries(on.map((r) => [r.q.id, r.rank]));
  assert.equal(rank.def, 1);
  assert.ok(typeof rank.drug === "number");
  assert.ok(typeof rank.syn === "number", "found only through the dictionary");
  assert.equal(rank.miss, null);
  assert.equal(rank.neg, undefined); // negative questions are not scored
  const off = await evalRetrieval(backend, QS, { parents: 5, expand: false });
  assert.equal(off.find((r) => r.q.id === "syn")!.rank, null);
  const m = metrics(on);
  assert.equal(m.get("ALL")!.n, 4);
  assert.equal(m.get("severity:high")!.h1, 1);
  assert.equal(m.get("concept")!.n, 2);
});

test("the API backend (/api/search + /api/parent) agrees with the local backend", async () => {
  const api = apiBackend("http://x/", TOKEN, shim());
  const local = dbBackend(db);
  for (const expand of [true, false]) {
    const a = await evalRetrieval(api, QS, { parents: 5, expand });
    const b = await evalRetrieval(local, QS, { parents: 5, expand });
    assert.deepEqual(a.map((r) => r.rank), b.map((r) => r.rank));
    assert.deepEqual(a.map((r) => r.hits.map((h) => h.parent_id)), b.map((r) => r.hits.map((h) => h.parent_id)));
  }
  await assert.rejects(apiBackend("http://x", "wrong-token-0123456789", shim()).search(["x"], { parents: 5, expand: true }), /HTTP 401/);
});

// ---------------------------------------------------------------------------------- answers
type Ev = [string, any];
function sse(evs: Ev[]): Response {
  return new Response(evs.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
/** fake Anthropic: search with the question's first word, then answer citing block 1 of the first result */
function fakeAnthropic(answer: string, cite = true) {
  return (async (_u: any, init: any) => {
    const body = JSON.parse(init.body);
    const last = body.messages.at(-1);
    const tr = Array.isArray(last.content) ? last.content.find((b: any) => b.type === "tool_result") : null;
    if (!tr) {
      const q = String(last.content).split(/[\s、。？]/)[0];
      return sse([
        ["message_start", { type: "message_start", message: { usage: { input_tokens: 1 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "search_books", input: {} } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ queries: [q] }) } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } }],
      ]);
    }
    const src = Array.isArray(tr.content) ? tr.content[0]?.source : undefined;
    const evs: Ev[] = [
      ["message_start", { type: "message_start", message: { usage: { input_tokens: 1 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } }],
    ];
    if (cite && src) {
      evs.push(["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "citations_delta", citation: { type: "search_result_location", source: src, cited_text: "…", start_block_index: 1, end_block_index: 2 } } }]);
    }
    evs.push(["content_block_stop", { type: "content_block_stop", index: 0 }], ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }]);
    return sse(evs);
  }) as typeof fetch;
}

const ASK = parseQuestions(
  [
    line({ id: "g", queries: ["ゼルニア値"], question: "ゼルニア値 の定義", expect: { book_id: "fx", pages: [10, 11] }, must_mention: ["半分以下", "急性"] }),
    line({ id: "n", negative: true, queries: ["ぬるぽ"], question: "ぬるぽ の治療", expect: {} }),
  ].join("\n"),
);

test("askOnce + scoreAsk: citations on gold pages and must-mention words", async () => {
  const o = await askOnce("http://x", TOKEN, ASK[0], {}, shim({ fetchImpl: fakeAnthropic("ゼルニア値が基準の半分以下になった状態。") }));
  assert.equal(o.kind, "final");
  const s = scoreAsk(ASK[0], o);
  assert.equal(s.book_citations, 1);
  assert.equal(s.cited_gold, true);
  assert.deepEqual(s.mention_hit, ["半分以下"]);
  assert.deepEqual(s.mention_miss, ["急性"]);
  assert.equal(s.abstained, false);
});

test("askOnce + scoreAsk: a negative question answered with 'not found'", async () => {
  const o = await askOnce("http://x", TOKEN, ASK[1], {}, shim({ fetchImpl: fakeAnthropic("手元の書籍には記載が見つかりませんでした。", false) }));
  const s = scoreAsk(ASK[1], o);
  assert.equal(s.cited_gold, null);
  assert.equal(s.abstained, true);
});

test("askOnce: identifier refusal, daily cap and degraded answers are told apart", async () => {
  const idq = { ...ASK[0], question: "カルテ番号 12345678 の件" };
  assert.equal((await askOnce("http://x", TOKEN, idq, {}, shim())).kind, "refused");
  const capped = shim({ fetchImpl: fakeAnthropic("x"), dailyAskLimit: 1, counter: { increment: async () => 2 } });
  const lim = await askOnce("http://x", TOKEN, ASK[0], {}, capped);
  assert.equal(lim.kind, "limit");
  assert.equal(lim.status, 429);
  const down = (async () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 })) as typeof fetch;
  const deg = await askOnce("http://x", TOKEN, ASK[0], {}, shim({ fetchImpl: down }));
  assert.equal(deg.kind, "degraded");
  assert.match(deg.message ?? "", /529/);
});
