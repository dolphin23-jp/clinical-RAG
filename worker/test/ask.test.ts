import assert from "node:assert/strict";
import { before, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runAsk, type StreamEvent } from "../src/anthropic.ts";
import type { Db } from "../src/db.ts";
import { handle, type AppDeps } from "../src/handler.ts";
import { DEFAULT_WEB_DOMAINS, SYSTEM_PROMPT } from "../src/prompt.ts";
import { USAGE_KINDS, d1Counter, jstDay, type AskCounter, type D1Like, type UsageKind } from "../src/usage.ts";
import { buildFixtureDb, openDb, openRw } from "./nodeDb.ts";

let db: Db;
before(() => {
  db = openDb(buildFixtureDb());
});

type Ev = [string, any];
/** A scripted fake of POST /v1/messages that streams SSE in awkward 23-byte chunks. */
function mockApi(script: ((body: any) => Ev[] | Response)[]) {
  const calls: any[] = [];
  const fetchImpl = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ body, headers: init.headers });
    const step = script[calls.length - 1];
    assert.ok(step, `unexpected extra API call #${calls.length}`);
    const out = step(body);
    if (out instanceof Response) return out;
    const text = out.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
    const bytes = new TextEncoder().encode(text);
    return new Response(
      new ReadableStream({
        start(c) {
          for (let i = 0; i < bytes.length; i += 23) c.enqueue(bytes.slice(i, i + 23));
          c.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const toolUseTurn = (queries: string[], id = "tu_1"): Ev[] => {
  const json = JSON.stringify({ queries });
  return [
    ["message_start", { type: "message_start", message: { usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "search_books", input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(0, 9) } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(9) } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } }],
    ["message_stop", { type: "message_stop" }],
  ];
};

function answerTurn(source: string, startBlock = 1): Ev[] {
  return [
    ["message_start", { type: "message_start", message: { usage: { input_tokens: 900, cache_read_input_tokens: 50 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ゼルニア値が基準の" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "半分以下で疑う。" } }],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "citations_delta",
          citation: { type: "search_result_location", source, title: "t", cited_text: "…", search_result_index: 0, start_block_index: startBlock, end_block_index: startBlock + 1 },
        },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 40 } }],
    ["message_stop", { type: "message_stop" }],
  ];
}

async function collect(deps: Parameters<typeof runAsk>[0], input: Parameters<typeof runAsk>[1]): Promise<StreamEvent[]> {
  const evs: StreamEvent[] = [];
  await runAsk(deps, input, (e) => evs.push(e));
  return evs;
}

test("happy path: search -> search_result blocks -> cited answer", async () => {
  let source = "";
  const api = mockApi([
    () => toolUseTurn(["ゼルニア値 基準"]),
    (body) => {
      const tr = body.messages.at(-1).content[0];
      source = tr.content[0].source;
      return answerTurn(source);
    },
  ]);
  const evs = await collect({ db, apiKey: "sk-test-secret", model: "m-test", fetchImpl: api.fetchImpl, now: new Date("2026-10-22T00:00:00Z") }, { question: "架空症候群の定義は？" });

  // --- request 1: NO forced tool_choice (Claude 5.5 rejects it), cached system prompt, our tool only
  const r1 = api.calls[0].body;
  assert.equal(r1.tool_choice, undefined);
  for (const k of ["temperature", "top_p", "top_k", "thinking"]) assert.equal(r1[k], undefined, k);
  assert.ok(r1.max_tokens >= 16000, "headroom for thinking tokens");
  assert.equal(r1.model, "m-test");
  assert.equal(r1.stream, true);
  assert.deepEqual(r1.tools.map((t: any) => t.name), ["search_books"]);
  assert.equal(r1.system[0].cache_control.type, "ephemeral");
  assert.match(r1.system[0].text, /2026-10-22/);
  assert.match(r1.system[0].text, /【出典未確認・要確認】/); // policy for numbers the books/web could not confirm
  assert.match(r1.system[0].text, /search_books/);
  assert.equal(api.calls[0].headers["x-api-key"], "sk-test-secret");

  // --- request 2: tool_use echoed back with parsed input, results are citable search_result blocks
  const r2 = api.calls[1].body;
  assert.equal(r2.tool_choice, undefined);
  const asst = r2.messages.at(-2);
  assert.equal(asst.role, "assistant");
  assert.deepEqual(asst.content[0].input, { queries: ["ゼルニア値 基準"] });
  const tr = r2.messages.at(-1);
  assert.equal(tr.role, "user");
  assert.equal(tr.content[0].type, "tool_result");
  assert.equal(tr.content[0].tool_use_id, "tu_1");
  const sr = tr.content[0].content;
  assert.ok(sr.length >= 1 && sr.every((b: any) => b.type === "search_result" && b.citations.enabled === true));
  assert.match(sr[0].source, /^medbook:\/\/fx:ch02:s\d+$/);
  assert.match(sr[0].content[0].text, /^［メタ情報］/);
  assert.ok(sr[0].content.length > 1);

  // --- events
  const types = evs.map((e) => e.t);
  assert.ok(types.includes("sources") && types.includes("delta") && types.at(-1) === "final", types.join());
  const final = evs.at(-1) as Extract<StreamEvent, { t: "final" }>;
  assert.equal(final.blocks[0].text, "ゼルニア値が基準の半分以下で疑う。");
  const c = final.blocks[0].citations[0];
  assert.equal(c.kind, "book");
  assert.equal(c.parent_id, source.replace("medbook://", ""));
  assert.match(String(c.page), /^p\.\d+/);
  assert.equal(final.usage.input_tokens, 1000);
  assert.equal(final.usage.output_tokens, 60);
  assert.equal(final.usage.book_searches, 1);
  assert.equal(final.searched_books, true);
  assert.ok(!JSON.stringify(evs).includes("sk-test-secret"));
});

const memoryAnswerTurn = (text = "記憶だけの回答"): Ev[] => [
  ["message_start", { type: "message_start", message: { usage: { input_tokens: 10 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }],
  ["message_stop", { type: "message_stop" }],
];

test("a first answer written without searching is never shown; the model is asked again to search", async () => {
  const api = mockApi([() => memoryAnswerTurn(), () => toolUseTurn(["ゼルニア値"]), (b) => answerTurn(b.messages.at(-1).content[0].content[0].source)]);
  const evs = await collect({ db, apiKey: "k", model: "m", fetchImpl: api.fetchImpl }, { question: "定義は？" });
  assert.equal(api.calls.length, 3);
  // retry #1 carries the explicit instruction, and the memory answer is not part of the conversation
  const r2 = api.calls[1].body;
  assert.equal(r2.messages.length, 1);
  assert.equal(r2.messages[0].content[0].text, "定義は？");
  assert.match(r2.messages[0].content[1].text, /search_books を呼んで/);
  assert.ok(!JSON.stringify(r2).includes("記憶だけの回答"));
  // the user never saw the memory answer
  assert.ok(!JSON.stringify(evs).includes("記憶だけの回答"));
  const final = evs.at(-1) as Extract<StreamEvent, { t: "final" }>;
  assert.equal(final.t, "final");
  assert.equal(final.searched_books, true);
  assert.equal(final.blocks[0].citations[0].kind, "book");
});

test("if the model still refuses to search after the nudge, the answer is shown but flagged searched_books=false", async () => {
  const api = mockApi([() => memoryAnswerTurn("一回目"), () => memoryAnswerTurn("二回目")]);
  const evs = await collect({ db, apiKey: "k", model: "m", fetchImpl: api.fetchImpl }, { question: "こんにちは" });
  assert.equal(api.calls.length, 2);
  const final = evs.at(-1) as Extract<StreamEvent, { t: "final" }>;
  assert.equal(final.searched_books, false);
  assert.equal(final.blocks[0].text, "二回目");
  assert.ok(!JSON.stringify(evs).includes("一回目"));
});

test("thinking blocks (empty text + signature) are echoed back unchanged in the tool loop; empty text blocks are dropped", async () => {
  const think: Ev[] = [
    ["message_start", { type: "message_start", message: { usage: { input_tokens: 10 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG-" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "ABC" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
    ["content_block_stop", { type: "content_block_stop", index: 1 }],
    ...toolUseTurn(["ゼルニア値"]).slice(1, 5).map(([e, d]): Ev => [e, { ...d, index: 2 }]),
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  const api = mockApi([() => think, (b) => answerTurn(b.messages.at(-1).content[0].content[0].source)]);
  const evs = await collect({ db, apiKey: "k", model: "m", fetchImpl: api.fetchImpl }, { question: "q" });
  const asst = api.calls[1].body.messages.at(-2).content;
  assert.deepEqual(asst.map((b: any) => b.type), ["thinking", "tool_use"]);
  assert.equal(asst[0].signature, "SIG-ABC");
  assert.equal(asst[0].thinking, "");
  assert.equal(evs.at(-1)?.t, "final");
});

test("commentary streamed before a later tool call is reset so it does not run into the answer", async () => {
  const chatty: Ev[] = [
    ["message_start", { type: "message_start", message: { usage: { input_tokens: 10 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "追加で調べます。" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ...toolUseTurn(["架空薬X"], "tu_2").slice(1, 5).map(([e, d]): Ev => [e, { ...d, index: 1 }]),
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  const api = mockApi([() => toolUseTurn(["ゼルニア値"]), () => chatty, (b) => answerTurn(b.messages.at(-1).content[0].content?.[0]?.source ?? "medbook://none")]);
  const evs = await collect({ db, apiKey: "k", model: "m", fetchImpl: api.fetchImpl }, { question: "q" });
  const types = evs.map((e) => e.t);
  const iReset = types.indexOf("reset");
  assert.ok(iReset > 0, types.join());
  const before = evs.slice(0, iReset).filter((e) => e.t === "delta").map((e: any) => e.text).join("");
  assert.equal(before, "追加で調べます。");
  const after = evs.slice(iReset).filter((e) => e.t === "delta").map((e: any) => e.text).join("");
  assert.ok(!after.includes("追加で調べます。"));
});

test("web option adds the web_search server tool with a domain allow-list", async () => {
  const api = mockApi([() => toolUseTurn(["x"]), (b) => answerTurn(b.messages.at(-1).content[0].content?.[0]?.source ?? "medbook://none")]);
  await collect({ db, apiKey: "k", model: "m", fetchImpl: api.fetchImpl, webDomains: ["kdigo.org"] }, { question: "q", web: true });
  const tools = api.calls[0].body.tools;
  assert.deepEqual(tools.map((t: any) => t.name), ["search_books", "web_search"]);
  assert.equal(tools[1].type, "web_search_20250305");
  assert.deepEqual(tools[1].allowed_domains, ["kdigo.org"]);
  assert.equal(tools[1].max_uses, 5);
});

test("history is sent as plain text and roles are normalised to alternate", async () => {
  const api = mockApi([() => toolUseTurn(["x"]), (b) => answerTurn("medbook://none")]);
  await collect(
    { db, apiKey: "k", model: "m", fetchImpl: api.fetchImpl },
    { question: "続きの質問", history: [{ role: "assistant", text: "先頭がassistant" }, { role: "user", text: "u1" }, { role: "user", text: "u2" }, { role: "assistant", text: "a1" }] },
  );
  const msgs = api.calls[0].body.messages;
  assert.equal(msgs[0].role, "user");
  assert.deepEqual(msgs.map((m: any) => m.role), ["user", "assistant", "user"]);
  assert.match(msgs[0].content, /u1\n\nu2/);
  assert.equal(msgs.at(-1).content, "続きの質問");
});

test("no hits -> tool_result tells the model to rephrase or say so", async () => {
  const api = mockApi([() => toolUseTurn(["ぬるぽぬるぽ存在しない語"]), () => answerTurn("medbook://none")]);
  const evs = await collect({ db, apiKey: "k", model: "m", fetchImpl: api.fetchImpl }, { question: "q" });
  const content = api.calls[1].body.messages.at(-1).content[0].content;
  assert.equal(typeof content, "string");
  assert.match(content, /見つかりませんでした/);
  assert.ok(!evs.some((e) => e.t === "sources"));
});

test("search budget is enforced per question", async () => {
  const api = mockApi([() => toolUseTurn(["ゼルニア値"], "a"), () => toolUseTurn(["架空薬X"], "b"), () => answerTurn("medbook://none")]);
  await collect({ db, apiKey: "k", model: "m", fetchImpl: api.fetchImpl, maxBookSearches: 1 }, { question: "q" });
  const second = api.calls[2].body.messages.at(-1).content[0];
  assert.equal(second.tool_use_id, "b");
  assert.match(second.content, /上限/);
});

test("API errors surface as a single error event without leaking the key", async () => {
  const api = mockApi([() => new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }), { status: 429 })]);
  const evs = await collect({ db, apiKey: "sk-test-secret", model: "m", fetchImpl: api.fetchImpl }, { question: "q" });
  const err = evs.at(-1) as Extract<StreamEvent, { t: "error" }>;
  assert.equal(err.t, "error");
  assert.match(err.message, /429.*slow down/);
  assert.ok(!JSON.stringify(evs).includes("sk-test-secret"));
});

test("a model that keeps calling tools is cut off at maxTurns; the sections it found are still handed over", async () => {
  const api = mockApi([() => toolUseTurn(["a"], "1"), () => toolUseTurn(["b"], "2")]);
  const evs = await collect({ db, apiKey: "k", model: "m", fetchImpl: api.fetchImpl, maxTurns: 2 }, { question: "q" });
  const last = evs.at(-1) as Extract<StreamEvent, { t: "degraded" }>;
  assert.equal(last.t, "degraded");
  assert.match(last.message, /上限（2回）/);
  assert.ok(last.items.length >= 1 && last.items.every((i) => i.source.startsWith("medbook://")));
  assert.ok(!evs.some((e) => e.t === "final"));
});

// ---------------------------------------------------------------------------------- degraded (T1-3)
test("degraded: the API fails before any search -> the question's content words are searched (no LLM) and shown", async () => {
  const api = mockApi([() => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 })]);
  const evs = await collect({ db, apiKey: "sk-test-secret", model: "m", fetchImpl: api.fetchImpl }, { question: "ゼルニア値の基準は？" });
  assert.equal(api.calls.length, 1);
  const last = evs.at(-1) as Extract<StreamEvent, { t: "degraded" }>;
  assert.equal(last.t, "degraded");
  assert.match(last.message, /529.*overloaded/);
  assert.ok(last.items.length >= 1);
  assert.ok(last.items.some((i) => /架空症候群/.test(i.title)));
  assert.deepEqual(last.items[0].queries, ["ゼルニア値 基準"]);
  assert.ok(!JSON.stringify(evs).includes("sk-test-secret"));
});

test("degraded: a stream that breaks mid-answer keeps the streamed text and hands over the sections already found", async () => {
  const broken: Ev[] = [
    ["message_start", { type: "message_start", message: { usage: { input_tokens: 9 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "途中までの回答" } }],
    ["error", { type: "error", error: { type: "overloaded_error", message: "stream broke" } }],
  ];
  const api = mockApi([() => toolUseTurn(["架空薬X"]), () => broken]);
  const evs = await collect({ db, apiKey: "k", model: "m", fetchImpl: api.fetchImpl }, { question: "架空薬Xの使い方" });
  const types = evs.map((e) => e.t);
  assert.ok(types.indexOf("delta") < types.indexOf("degraded"), types.join());
  assert.equal(evs.filter((e) => e.t === "delta").map((e: any) => e.text).join(""), "途中までの回答");
  const last = evs.at(-1) as Extract<StreamEvent, { t: "degraded" }>;
  assert.equal(last.t, "degraded");
  assert.match(last.message, /stream broke/);
  assert.deepEqual(last.items[0].queries, ["架空薬X"]); // the sections from the model's own search, not a re-search
  assert.ok(!types.includes("final"));
});

test("degraded: a refusal also hands over the sections found", async () => {
  const refusal: Ev[] = [
    ["message_start", { type: "message_start", message: { usage: { input_tokens: 9 } } }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  const api = mockApi([() => toolUseTurn(["ゼルニア値"]), () => refusal]);
  const evs = await collect({ db, apiKey: "k", model: "m", fetchImpl: api.fetchImpl }, { question: "q" });
  const last = evs.at(-1) as Extract<StreamEvent, { t: "degraded" }>;
  assert.equal(last.t, "degraded");
  assert.match(last.message, /refusal/);
});

test("degraded: a request the user cancelled ends as a plain error, without searching again", async () => {
  const ctl = new AbortController();
  ctl.abort();
  const fetchImpl = (async () => {
    throw new DOMException("The operation was aborted.", "AbortError");
  }) as typeof fetch;
  const evs = await collect({ db, apiKey: "k", model: "m", fetchImpl, signal: ctl.signal }, { question: "ゼルニア値の基準は？" });
  assert.deepEqual(evs.filter((e) => e.t === "degraded" || e.t === "error").map((e) => e.t), ["error"]);
});

// ---------------------------------------------------------------------------------- HTTP layer
const TOKEN = "test-token-0123456789abcdef";
function app(extra: Partial<AppDeps> = {}): AppDeps {
  return { db, apiKey: "k", appToken: TOKEN, model: "m", ...extra };
}
const authed = (init: RequestInit = {}): RequestInit => ({ ...init, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers as any) } });

test("HTTP: health is open; everything else needs the bearer token", async () => {
  assert.equal((await handle(new Request("http://x/api/health"), app())).status, 200);
  assert.equal((await handle(new Request("http://x/api/books"), app())).status, 401);
  assert.equal((await handle(new Request("http://x/api/books", { headers: { authorization: "Bearer wrong" } }), app())).status, 401);
  assert.equal((await handle(new Request("http://x/api/books", authed()), app())).status, 200);
  const unconfigured = await handle(new Request("http://x/api/books", authed()), app({ appToken: "short" }));
  assert.equal(unconfigured.status, 500);
});

test("HTTP: books, parent, page endpoints", async () => {
  const books: any = await (await handle(new Request("http://x/api/books", authed()), app())).json();
  assert.equal(books.books[0].book_id, "fx");
  assert.ok(books.books[0].chunks > 5);
  const pid = (await db.all<{ parent_id: string }>("SELECT parent_id FROM parents LIMIT 1"))[0].parent_id;
  const par: any = await (await handle(new Request(`http://x/api/parent/${encodeURIComponent(pid)}`, authed()), app())).json();
  assert.equal(par.parent_id, pid);
  assert.ok(par.blocks.length > 0);
  assert.equal((await handle(new Request("http://x/api/parent/nope", authed()), app())).status, 404);
  assert.equal((await handle(new Request("http://x/api/page/fx/12", authed()), app())).status, 404); // no store configured
  const store = { async get(k: string) { return k === "pages/fx/12.webp" ? { body: new Uint8Array([1, 2, 3]).buffer, contentType: "image/webp" } : null; } };
  const ok = await handle(new Request("http://x/api/page/fx/12", authed()), app({ pages: store }));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/webp");
  assert.equal((await handle(new Request("http://x/api/page/..%2Fetc/12", authed()), app({ pages: store }))).status, 404);
});

test("HTTP: /api/ask streams SSE and validates input", async () => {
  const bad = await handle(new Request("http://x/api/ask", authed({ method: "POST", body: JSON.stringify({ question: "" }) })), app());
  assert.equal(bad.status, 400);
  assert.equal((await handle(new Request("http://x/api/ask", authed({ method: "POST", body: "{not json" })), app())).status, 400);

  const api = mockApi([() => toolUseTurn(["ゼルニア値"]), (b) => answerTurn(b.messages.at(-1).content[0].content[0].source)]);
  const res = await handle(new Request("http://x/api/ask", authed({ method: "POST", body: JSON.stringify({ question: "定義は？", model: "not-allowed" }) })), app({ fetchImpl: api.fetchImpl }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /text\/event-stream/);
  const text = await res.text();
  const events = text.split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
  assert.equal(events.at(-1).t, "final");
  assert.equal(api.calls[0].body.model, "m"); // a model outside the allow-list falls back to the default
});

test("HTTP: /api/search returns retrieval results without calling the LLM", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("{}");
  }) as typeof fetch;
  const res = await handle(new Request("http://x/api/search", authed({ method: "POST", body: JSON.stringify({ queries: ["ゼルニア値"] }) })), app({ fetchImpl }));
  assert.equal(res.status, 200);
  const j: any = await res.json();
  assert.ok(j.results.length >= 1);
  assert.match(j.results[0].snippet, /./);
  assert.equal(called, false);
  assert.equal((await handle(new Request("http://x/api/search", authed({ method: "POST", body: JSON.stringify({ queries: [] }) })), app())).status, 400);
  assert.equal((await handle(new Request("http://x/api/search", { method: "POST", body: "{}" }), app())).status, 401);
});

// ---------------------------------------------------------------------------------- identifier guard (T1-1)
const post = (path: string, body: unknown) => new Request(`http://x${path}`, authed({ method: "POST", body: JSON.stringify(body) }));
const countingFetch = () => {
  const api = mockApi([() => toolUseTurn(["ゼルニア値"]), (b) => answerTurn(b.messages.at(-1).content[0].content[0].source)]);
  return api;
};

test("HTTP guard: an identifier in the question is refused before the model is called; only the kind is returned", async () => {
  const api = countingFetch();
  const res = await handle(post("/api/ask", { question: "患者ID 123456 の70代男性、K 6.8" }), app({ fetchImpl: api.fetchImpl }));
  assert.equal(res.status, 400);
  const j: any = await res.json();
  assert.equal(j.code, "possible_identifier");
  assert.ok(j.labels.includes("ID・MRN の後ろの数字"));
  assert.ok(!JSON.stringify(j).includes("123456"));
  assert.equal(api.calls.length, 0);
});

test("HTTP guard: age band, findings and lab values pass; names and dates are not detected (doctor's decision)", async () => {
  const api = countingFetch();
  const q = "70代男性、田中さん。2025-10-24 来院、3日前から倦怠感。K 6.8 mEq/L、Cr 2.1、eGFR 25、心電図でテント状T波";
  const res = await handle(post("/api/ask", { question: q }), app({ fetchImpl: api.fetchImpl }));
  assert.equal(res.status, 200);
  await res.text();
  assert.equal(api.calls.length, 2);
});

test("HTTP guard: the user's earlier turns are checked, the model's are not; ack_identifier lets a confirmed question through", async () => {
  const userHist = [{ role: "user", text: "カルテ番号 12345678 の件" }, { role: "assistant", text: "了解" }];
  assert.equal((await handle(post("/api/ask", { question: "続き", history: userHist }), app({ fetchImpl: countingFetch().fetchImpl }))).status, 400);
  const asstHist = [{ role: "user", text: "文献は？" }, { role: "assistant", text: "PMID 12345678 が参考になる" }];
  const ok = await handle(post("/api/ask", { question: "続き", history: asstHist }), app({ fetchImpl: countingFetch().fetchImpl }));
  assert.equal(ok.status, 200);
  await ok.text();
  const acked = await handle(post("/api/ask", { question: "患者ID 123456", ack_identifier: true }), app({ fetchImpl: countingFetch().fetchImpl }));
  assert.equal(acked.status, 200);
  await acked.text();
  // only the literal boolean counts as a confirmation
  assert.equal((await handle(post("/api/ask", { question: "患者ID 123456", ack_identifier: "yes" }), app())).status, 400);
});

test("HTTP guard: /api/search refuses identifier-like queries unless acknowledged", async () => {
  const res = await handle(post("/api/search", { queries: ["090-1234-5678"] }), app());
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as any).code, "possible_identifier");
  assert.equal((await handle(post("/api/search", { queries: ["090-1234-5678"], ack_identifier: true }), app())).status, 200);
});

test("HTTP: /api/search reports the dictionary terms it added", async () => {
  const j: any = await (await handle(post("/api/search", { queries: ["高K血症 治療"] }), app())).json();
  assert.ok(j.expanded.synonyms.includes("高カリウム血症") && j.expanded.synonyms.includes("hyperkalemia"));
  assert.ok(j.expanded.related.includes("カリウム吸着薬"));
});

// ---------------------------------------------------------------------------------- daily cap (T1-2)
function memCounter(fail = false) {
  const days = new Map<string, number>();
  const counter: AskCounter = {
    async increment(day) {
      if (fail) throw new Error("D1 down");
      days.set(day, (days.get(day) ?? 0) + 1);
      return days.get(day)!;
    },
  };
  return { counter, days };
}

test("daily cap: asks over the limit get 429 before the model is called; the day is Japan time", async () => {
  const { counter, days } = memCounter();
  const now = () => new Date("2026-10-24T15:30:00Z"); // 00:30 on the 25th in Japan
  const deps = (api: ReturnType<typeof countingFetch>) => app({ fetchImpl: api.fetchImpl, counter, dailyAskLimit: 2, now });
  for (let i = 0; i < 2; i++) {
    const r = await handle(post("/api/ask", { question: "ゼルニア値" }), deps(countingFetch()));
    assert.equal(r.status, 200);
    await r.text();
  }
  const third = countingFetch();
  const r3 = await handle(post("/api/ask", { question: "ゼルニア値" }), deps(third));
  assert.equal(r3.status, 429);
  const j: any = await r3.json();
  assert.equal(j.code, "daily_limit");
  assert.match(j.error, /日本時間の0時/);
  assert.equal(third.calls.length, 0);
  assert.deepEqual([...days.keys()], ["2026-10-25"]);
  assert.equal(jstDay(new Date("2026-10-24T14:59:59Z")), "2026-10-24");
});

test("daily cap: refused (identifier) and search-only requests are not counted; limit 0 = no cap; counter failure does not block", async () => {
  const { counter, days } = memCounter();
  await handle(post("/api/ask", { question: "患者ID 123456" }), app({ counter, dailyAskLimit: 1 }));
  await handle(post("/api/search", { queries: ["ゼルニア値"] }), app({ counter, dailyAskLimit: 1 }));
  assert.equal(days.size, 0);
  const off = await handle(post("/api/ask", { question: "ゼルニア値" }), app({ fetchImpl: countingFetch().fetchImpl, counter, dailyAskLimit: 0 }));
  assert.equal(off.status, 200);
  await off.text();
  assert.equal(days.size, 0);
  const broken = await handle(post("/api/ask", { question: "ゼルニア値" }), app({ fetchImpl: countingFetch().fetchImpl, counter: memCounter(true).counter, dailyAskLimit: 1 }));
  assert.equal(broken.status, 200);
  await broken.text();
});

test("daily cap: the D1 counter SQL stores only the day and numbers, and counts per day", async () => {
  const rw = openRw();
  const c = d1Counter(rw);
  assert.equal(await c.increment("2026-10-25"), 1);
  assert.equal(await c.increment("2026-10-25"), 2);
  assert.equal(await c.increment("2026-10-26"), 1);
  const info = rw.raw.prepare("PRAGMA table_info(usage_daily)").all() as any[];
  assert.deepEqual(info.map((r) => r.name), ["day", "asks", ...USAGE_KINDS]);
  // nothing but the day is text: every other column is an integer that cannot be empty
  assert.deepEqual(info.filter((r) => r.type !== "INTEGER").map((r) => r.name), ["day"]);
  assert.ok(info.filter((r) => r.name !== "day").every((r) => r.notnull === 1));
});

// ---------------------------------------------------------------------------------- how the answers went, per day (F4)
test("daily counts: the columns are added to the table that already exists, its counts are kept, and a day with no ask still gets its row", async () => {
  const rw = openRw();
  rw.raw.exec("CREATE TABLE usage_daily (day TEXT PRIMARY KEY, asks INTEGER NOT NULL); INSERT INTO usage_daily VALUES ('2026-10-24', 7)"); // production before F4
  const c = d1Counter(rw);
  await c.note!("2026-10-24", ["no_hits", "no_cite"]);
  await c.note!("2026-10-24", ["no_cite"]);
  await c.note!("2026-10-25", ["num_flag"]); // a day with no cap: no increment before
  await c.note!("2026-10-25", []); // nothing to add: no write
  assert.equal(await c.increment("2026-10-25"), 1);
  const rows = rw.raw.prepare("SELECT * FROM usage_daily ORDER BY day").all() as any[];
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { day: "2026-10-24", asks: 7, no_search: 0, no_hits: 1, no_cite: 2, num_flag: 0 },
    { day: "2026-10-25", asks: 1, no_search: 0, no_hits: 0, no_cite: 0, num_flag: 1 },
  ]);
  // a second counter over the same table (another isolate, after the columns exist) works and does not fail on the ALTER
  const again = d1Counter(rw);
  await again.note!("2026-10-24", ["no_search"]);
  assert.equal(((rw.raw.prepare("SELECT no_search FROM usage_daily WHERE day='2026-10-24'").get() as any).no_search), 1);
});

function textTurn(text: string, source?: string): Ev[] {
  return [
    ["message_start", { type: "message_start", message: { usage: { input_tokens: 900, cache_read_input_tokens: 50 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ...(source
      ? ([["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "citations_delta", citation: { type: "search_result_location", source, title: "t", cited_text: "…", search_result_index: 0, start_block_index: 1, end_block_index: 2 } } }]] as Ev[])
      : []),
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 40 } }],
    ["message_stop", { type: "message_stop" }],
  ];
}
const src = (b: any) => b.messages.at(-1).content[0].content[0].source;

/** A counter that remembers what it was told (the real SQL is tested above). */
function noting(failNote = false) {
  const notes: Array<[string, UsageKind[]]> = [];
  let asks = 0;
  const counter: AskCounter = {
    async increment() {
      return ++asks;
    },
    async note(day, kinds) {
      if (failNote) throw new Error("D1 down");
      notes.push([day, [...kinds]]);
    },
  };
  return { counter, notes };
}
async function askWith(script: ((body: any) => Ev[] | Response)[], extra: Partial<AppDeps> = {}, body: object = { question: "ゼルニア値" }) {
  const api = mockApi(script);
  const r = await handle(post("/api/ask", body), app({ fetchImpl: api.fetchImpl, now: () => new Date("2026-10-24T15:30:00Z"), ...extra }));
  const text = await r.text();
  return { api, status: r.status, text };
}

test("daily counts: a cited answer from the books counts nothing; the day is Japan time", async () => {
  const { counter, notes } = noting();
  const r = await askWith([() => toolUseTurn(["ゼルニア値"]), (b) => answerTurn(src(b))], { counter, dailyAskLimit: 100 });
  assert.equal(r.status, 200);
  assert.deepEqual(notes, [["2026-10-25", []]]);
});

test("daily counts: answered without searching -> no_search (and no_cite when nothing is cited)", async () => {
  const { counter, notes } = noting();
  await askWith([() => textTurn("一般論としてはこうです。"), () => textTurn("一般論としてはこうです。")], { counter });
  assert.deepEqual(notes.map((n) => n[1]), [["no_search", "no_cite"]]);
});

test("daily counts: searched, found nothing -> no_hits (and no_cite)", async () => {
  const { counter, notes } = noting();
  await askWith([() => toolUseTurn(["zzzz存在しない語"]), () => textTurn("書籍には記載が見つかりませんでした。")], { counter });
  assert.deepEqual(notes.map((n) => n[1]), [["no_hits", "no_cite"]]);
});

test("daily counts: searched and found, but cited nothing -> no_cite only", async () => {
  const { counter, notes } = noting();
  await askWith([() => toolUseTurn(["ゼルニア値"]), () => textTurn("見つかった節からは言い切れません。")], { counter });
  assert.deepEqual(notes.map((n) => n[1]), [["no_cite"]]);
});

test("daily counts: a number the books do not contain -> num_flag", async () => {
  const { counter, notes } = noting();
  await askWith([() => toolUseTurn(["ゼルニア値"]), (b) => textTurn("ゼルニア値が低ければ 999 mg を使う。", src(b))], { counter });
  assert.deepEqual(notes.map((n) => n[1]), [["num_flag"]]);
});

test("daily counts: a counter that fails does not touch the answer; a failed answer and a made-up case are not counted", async () => {
  const bad = noting(true);
  const r = await askWith([() => toolUseTurn(["ゼルニア値"]), (b) => answerTurn(src(b))], { counter: bad.counter });
  assert.equal(r.status, 200);
  assert.match(r.text, /"t":"final"/);
  assert.doesNotMatch(r.text, /D1 down/);
  const down = noting();
  const failed = await askWith([() => new Response("boom", { status: 500 })], { counter: down.counter });
  assert.match(failed.text, /"t":"(error|degraded)"/);
  assert.deepEqual(down.notes, []);
  const made = noting();
  await askWith([() => textTurn("## 導入文\n\nx\n")], { counter: made.counter }, { mode: "create", create: { theme: "腎前性AKI", setting: "救急", level: "標準", goal: "", pitfall: true } });
  assert.deepEqual(made.notes, []);
});

test("daily counts: what is handed to the counter is four yes/no values, never text from the question or the answer", async () => {
  const { counter, notes } = noting();
  await askWith([() => toolUseTurn(["ゼルニア値"]), (b) => textTurn("ゼルニア値が低ければ 999 mg を使う。", src(b))], { counter }, { question: "ゼルニア値が低い70代男性、K 6.8" });
  const flat = JSON.stringify(notes);
  assert.doesNotMatch(flat, /ゼルニア|70代|6\.8|999/);
  for (const [, kinds] of notes) for (const k of kinds) assert.ok((USAGE_KINDS as readonly string[]).includes(k));
});

// ---------------------------------------------------------------------------------- prompt (clinical-use 2.5-2.7)
test("system prompt keeps the clinical-reference rules and the specialty", () => {
  assert.match(SYSTEM_PROMPT, /腎臓内科を志し、内科一般と救急も診る/);
  assert.match(SYSTEM_PROMPT, /施設プロトコルは別途確認/);
  assert.match(SYSTEM_PROMPT, /要検算/);
  assert.match(SYSTEM_PROMPT, /年齢・検査値などの症例固有の値を入れず/);
  assert.match(SYSTEM_PROMPT, /最終判断は質問者自身/);
  assert.doesNotMatch(SYSTEM_PROMPT, /投与速度（mL\/hr）/); // the old instruction asked the model to convert to mL/hr
  for (const d of ["kdigo.org", "pmda.go.jp", "jaam.jp", "naika.or.jp"]) assert.ok(DEFAULT_WEB_DOMAINS.includes(d), d);
});

test("HTTP: /api/search can switch the dictionary off and lift the per-book cap (evaluation only; defaults unchanged)", async () => {
  const on: any = await (await handle(post("/api/search", { queries: ["高K血症"] }), app())).json();
  assert.ok(on.expanded.synonyms.length > 0);
  const off: any = await (await handle(post("/api/search", { queries: ["高K血症"], expand: false }), app())).json();
  assert.deepEqual(off.expanded, { synonyms: [], related: [] });
  // the fixture is one book with 5 sections (2 of them reference lists), so only include_references reaches 5
  const q = { queries: ["架空"], parents: 5, include_references: true };
  const capped: any = await (await handle(post("/api/search", q), app())).json();
  const lifted: any = await (await handle(post("/api/search", { ...q, max_per_book: 5 }), app())).json();
  assert.equal(capped.results.length, 3); // default diversity cap: 3 per book
  assert.equal(lifted.results.length, 5);
});
