import assert from "node:assert/strict";
import { before, test } from "node:test";
import { runAsk, type StreamEvent } from "../src/anthropic.ts";
import type { Db } from "../src/db.ts";
import { handle, type AppDeps } from "../src/handler.ts";
import { buildFixtureDb, openDb } from "./nodeDb.ts";

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

test("a model that keeps calling tools is cut off at maxTurns", async () => {
  const api = mockApi([() => toolUseTurn(["a"], "1"), () => toolUseTurn(["b"], "2")]);
  const evs = await collect({ db, apiKey: "k", model: "m", fetchImpl: api.fetchImpl, maxTurns: 2 }, { question: "q" });
  assert.equal(evs.at(-1)?.t, "error");
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
