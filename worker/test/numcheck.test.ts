// Number check (T1-6): worker/src/numcheck.ts and its place in the answer loop.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { runAsk, type StreamEvent } from "../src/anthropic.ts";
import type { Db } from "../src/db.ts";
import { checkNumbers, containsNumber, MAX_FINDINGS, numKey } from "../src/numcheck.ts";
import { buildFixtureDb, openDb } from "./nodeDb.ts";

let db: Db;
before(() => {
  db = openDb(buildFixtureDb());
});

const base = { cited: [], retrieved: [], inputs: [] };
const status = (answer: string, extra: Partial<Parameters<typeof checkNumbers>[0]> = {}) =>
  Object.fromEntries(checkNumbers({ ...base, answer, ...extra }).map((f) => [f.text, f.status]));

test("numKey: one form for spaces, thousands separators, dashes and case", () => {
  assert.equal(numKey("1,000 mg/日"), "1000mg/日");
  assert.equal(numKey("0.05〜0.1 μg/kg/min"), "0.05-0.1μg/kg/min");
  assert.equal(numKey("０．５ MG"), "0.5mg");
});

test("containsNumber: a longer number does not contain a shorter one", () => {
  assert.equal(containsNumber("開始量は110mg/日", "10mg/日"), false);
  assert.equal(containsNumber("開始量は10mg/日", "10mg/日"), true);
  assert.equal(containsNumber("0.5mg", "5mg"), false);
  assert.equal(containsNumber("a110mg and 10mg", "10mg"), true);
});

test("cited / retrieved / not_found, with the page it was found on", () => {
  const f = checkNumbers({
    answer: "架空薬Xは 10 mg/日 で開始する。eGFR 30 未満では半量。最大 500 mg/日 まで。",
    cited: [{ cited_text: "架空薬Xを 10 mg/日 で開始し", page: "p.12", kind: "book" }],
    retrieved: [{ text: "…eGFR 30 未満の場合は半量とする…", page_label: "p.12-13" }],
    inputs: [],
  });
  assert.deepEqual(f, [
    { text: "10 mg/日", status: "cited", page: "p.12" },
    { text: "30 未満", status: "retrieved", page: "p.12-13" },
    { text: "500 mg/日", status: "not_found" },
  ]);
});

test("spelling differences between the answer and the book do not hide a match", () => {
  assert.deepEqual(status("0.05-0.1 μg/kg/min で開始。1000 mg を投与。", { retrieved: [{ text: "0.05〜0.1 µg/kg/min で開始、1,000 mg", page_label: "p.3" }] }), {
    "0.05-0.1 μg/kg/min": "retrieved",
    "1000 mg": "retrieved",
  });
});

test("the doctor's own numbers are not checked; web citations are marked", () => {
  assert.deepEqual(status("K 6.8 mEq/L では 10 mg を使う。", { inputs: ["70代、K 6.8 mEq/L、心電図変化あり"] }), { "10 mg": "not_found" });
  const f = checkNumbers({ ...base, answer: "目標は 140 mmHg 未満", cited: [{ cited_text: "140 mmHg 未満を目標", page: null, kind: "web" }] });
  assert.deepEqual(f, [{ text: "140 mmHg 未満", status: "cited", page: null, via: "web" }]);
});

test("page, figure and year numbers are not checked; duplicates are folded; the list is capped", () => {
  assert.deepEqual(status("第2版（2030年）p.12 参照。10 mg、10 mg、10 mg"), { "10 mg": "not_found" });
  const many = Array.from({ length: 80 }, (_, i) => `${i + 1000} mg`).join("、");
  assert.equal(checkNumbers({ ...base, answer: many }).length, MAX_FINDINGS);
});

// ---------------------------------------------------------------------------------- in the answer loop
type Ev = [string, any];
const sse = (evs: Ev[]) => new Response(evs.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

test("runAsk: final carries the number findings (cited / retrieved / not_found), from the sections it really retrieved", async () => {
  const fetchImpl = (async (_u: any, init: any) => {
    const body = JSON.parse(init.body);
    const tr = body.messages.at(-1).content?.[0];
    if (tr?.type !== "tool_result") {
      return sse([
        ["message_start", { type: "message_start", message: { usage: { input_tokens: 1 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "search_books", input: {} } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ queries: ["架空薬X"] }) } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } }],
      ]);
    }
    const src = tr.content[0].source;
    return sse([
      ["message_start", { type: "message_start", message: { usage: { input_tokens: 1 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "架空薬Xは 10 mg/日 で開始する。eGFR 30 未満では半量とする。最大 500 mg/日 まで増やす。" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "citations_delta", citation: { type: "search_result_location", source: src, cited_text: "架空薬Xを 10 mg/日 で開始し", start_block_index: 1, end_block_index: 2 } } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
    ]);
  }) as typeof fetch;
  const evs: StreamEvent[] = [];
  await runAsk({ db, apiKey: "k", model: "m", fetchImpl }, { question: "架空薬Xの使い方（70代、eGFR 25）" }, (e) => evs.push(e));
  const final = evs.at(-1) as Extract<StreamEvent, { t: "final" }>;
  assert.equal(final.t, "final");
  const by = Object.fromEntries(final.numbers.map((n) => [n.text, n.status]));
  assert.deepEqual(by, { "10 mg/日": "cited", "30 未満": "retrieved", "500 mg/日": "not_found" });
  assert.match(final.numbers.find((n) => n.status === "retrieved")!.page ?? "", /^p\./);
});
