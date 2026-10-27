// Case mode (docs/enhancement-plan.md 7.2): validation, what the model is sent, the identifier check on every field,
// saving/restoring the case with a conversation, and the pins that keep the screen's lists equal to the Worker's.
import assert from "node:assert/strict";
import { join } from "node:path";
import { before, test } from "node:test";
import type { Db } from "../src/db.ts";
import { runAsk, type StreamEvent } from "../src/anthropic.ts";
import { AGE_MAX, CaseInputError, LEGACY_AGES, MODE_LABELS, MODES, SETTINGS, SEXES, STRUCTURED_LIMIT, TEXT_LIMITS, ageText, caseTexts, isAgeYears, isEmptyCase, parseCase, parseMode, renderCase } from "../src/casemode.ts";
import { ConvInputError, convStore } from "../src/convstore.ts";
import { handle, type AppDeps } from "../src/handler.ts";
import { CASE_RULES, MODE_HEADINGS, OWN_SECTION_ASSESS, OWN_SECTION_DDX, SYSTEM_PROMPT, caseSystem } from "../src/prompt.ts";
import { buildFixtureDb, openDb, openRw, REPO } from "./nodeDb.ts";

const web: any = await import(join(REPO, "web", "case-model.js"));

let db: Db;
before(() => {
  db = openDb(buildFixtureDb());
});
const TOKEN = "test-token-0123456789abcdef";
const app = (extra: Partial<AppDeps> = {}): AppDeps => ({ db, apiKey: "k", appToken: TOKEN, model: "m", ...extra });
const post = (path: string, body: unknown) =>
  new Request(`http://x${path}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });

type Ev = [string, any];
/** A scripted fake of POST /v1/messages: a search first, then a plain answer. Records every request body. */
function fakeModel(answer = "症例の整理です。 [推論]") {
  const calls: any[] = [];
  const sse = (evs: Ev[]) =>
    new Response(evs.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  const fetchImpl = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (calls.length % 2 === 1) {
      const json = JSON.stringify({ queries: ["ゼルニア値 基準"] });
      return sse([
        ["message_start", { type: "message_start", message: { usage: { input_tokens: 10 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "search_books", input: {} } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }],
      ]);
    }
    return sse([
      ["message_start", { type: "message_start", message: { usage: { input_tokens: 20 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }],
    ]);
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const events = async (res: Response): Promise<any[]> =>
  (await res.text()).split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));

const CASE = {
  age: "72",
  sex: "男性",
  setting: "救急",
  complaint: "3日前から発熱と咳。昨日から尿量が減った。",
  vitals: "BP 92/54, HR 108, SpO2 94%",
  findings: "Cr 2.4 mg/dL（ふだんは 0.9）, K 5.8 mEq/L",
  history: "高血圧。内服はアムロジピン。",
  own: "",
};

// ---------------------------------------------------------------------------------- validation
test("parseCase: trims, normalises line ends, drops unknown keys, keeps unfilled fields empty", () => {
  const c = parseCase({ ...CASE, complaint: "  経過\r\n続き  ", own: undefined, extra: "dropped", __proto__: { x: 1 } });
  assert.equal(c.complaint, "経過\n続き");
  assert.equal(c.own, "");
  assert.ok(!("extra" in c));
  assert.deepEqual(Object.keys(c).sort(), ["age", "complaint", "findings", "history", "own", "setting", "sex", "structured", "vitals"]);
  assert.deepEqual(caseTexts(c), [c.complaint, c.vitals, c.findings, c.history, c.own, c.structured]);
});

test("parseCase: refuses non-objects, wrong types, unknown choices, over-long text and an empty case", () => {
  const code = (raw: unknown) => {
    try {
      parseCase(raw);
      return "";
    } catch (e) {
      assert.ok(e instanceof CaseInputError);
      return (e as CaseInputError).code;
    }
  };
  assert.equal(code("text"), "bad_case");
  assert.equal(code([CASE]), "bad_case");
  assert.equal(code({ ...CASE, complaint: 5 }), "bad_case");
  // the age is whole years, 0..130, as digits (the screen reads "７２歳" into "72" before it sends)
  for (const bad of ["75歳", "131", "72.5", "-3", "072", "７２", "七十二", "70代前半", " 72", "1e2"]) assert.equal(code({ ...CASE, age: bad }), "bad_case", bad);
  for (const ok of ["0", "1", "72", "130", "70代", "乳児", "90代以上"]) assert.equal(code({ ...CASE, age: ok }), "", ok); // the old bands still come back from saved conversations
  assert.equal(code({ ...CASE, sex: "男" }), "bad_case");
  assert.equal(code({ ...CASE, setting: "ICU" }), "bad_case");
  assert.equal(code({ ...CASE, own: "あ".repeat(TEXT_LIMITS.own + 1) }), "bad_case");
  assert.equal(code({ ...CASE, findings: "あ".repeat(TEXT_LIMITS.findings) }), ""); // exactly the limit is fine
  // age / sex / setting alone give the model nothing to work from
  assert.equal(code({ age: "72", sex: "男性", setting: "救急" }), "empty_case");
  assert.equal(code({ complaint: "   ", own: "見立てだけ" }), "empty_case");
  assert.ok(isEmptyCase(parseCaseLoose({ age: "72" })));
});
const parseCaseLoose = (o: object) => ({ age: "", sex: "", setting: "", complaint: "", vitals: "", findings: "", history: "", own: "", structured: "", ...o });

test("parseMode: the six modes; anything else is refused; absent is undefined", () => {
  assert.deepEqual([...MODES], ["assess", "ddx", "miss", "consult", "ask", "create"]);
  for (const m of MODES) assert.equal(parseMode(m), m);
  assert.equal(parseMode(undefined), undefined);
  assert.equal(parseMode(""), undefined);
  assert.throws(() => parseMode("treat"), (e: any) => e instanceof CaseInputError && e.code === "bad_mode");
  assert.throws(() => parseMode(3), CaseInputError);
});

test("renderCase: an unfilled field says 未入力 (not negative); the doctor's own assessment appears only when typed", () => {
  const text = renderCase(parseCase({ ...CASE, history: "" }));
  assert.match(text, /^【症例（入力）】/);
  assert.match(text, /陰性・正常ではありません/);
  assert.match(text, /- 年齢・性別: 72歳・男性/);
  assert.match(text, /- 既往・内服: （未入力）/);
  assert.match(text, /- 身体所見・検査・画像・心電図: Cr 2\.4 mg\/dL/);
  assert.ok(!text.includes("先生自身のアセスメント"));
  const own = renderCase(parseCase({ ...CASE, own: "感染に伴う腎前性AKI\n第一に考える" }));
  assert.match(own, /- 先生自身のアセスメント（先生の案）: 感染に伴う腎前性AKI\n  第一に考える/);
});

// ---------------------------------------------------------------------------------- what the model is sent
test("HTTP: a mode button sends the case before the request, the mode's rules as a second system block, and nothing in the history", async () => {
  const api = fakeModel();
  const res = await handle(
    post("/api/ask", { question: "", mode: "assess", case: CASE, history: [{ role: "user", text: "前の質問" }, { role: "assistant", text: "前の回答" }] }),
    app({ fetchImpl: api.fetchImpl, now: () => new Date("2026-10-24T00:00:00Z") }),
  );
  assert.equal(res.status, 200);
  assert.equal((await events(res)).at(-1).t, "final");
  const r1 = api.calls[0];
  // the cached base prompt is untouched; the case rules ride in a second block
  assert.equal(r1.system.length, 2);
  assert.equal(r1.system[0].cache_control.type, "ephemeral");
  assert.ok(r1.system[0].text.startsWith(SYSTEM_PROMPT));
  assert.ok(!r1.system[0].text.includes("症例モード"));
  assert.equal(r1.system[1].text, caseSystem("assess", false));
  assert.equal(r1.system[1].cache_control, undefined);
  // the final user message: the case, then the request (the button's label, since no text was sent)
  const last = r1.messages.at(-1);
  assert.equal(last.role, "user");
  assert.equal(typeof last.content, "string");
  assert.ok(last.content.startsWith("【症例（入力）】"));
  assert.ok(last.content.includes("Cr 2.4 mg/dL"));
  assert.ok(last.content.endsWith(`【依頼】${MODE_LABELS.assess}`));
  // earlier turns are plain text: the case is attached to the question being asked, never repeated in the history
  assert.deepEqual(r1.messages.slice(0, -1).map((m: any) => m.content), ["前の質問", "前の回答"]);
  // the tool loop is unchanged (no forced tool, our search tool only)
  assert.equal(r1.tool_choice, undefined);
  assert.deepEqual(r1.tools.map((t: any) => t.name), ["search_books"]);
});

test("HTTP: a plain question has one system block and no case text", async () => {
  const api = fakeModel();
  await (await handle(post("/api/ask", { question: "架空症候群の定義は？" }), app({ fetchImpl: api.fetchImpl }))).text();
  assert.equal(api.calls[0].system.length, 1);
  assert.equal(api.calls[0].messages.at(-1).content, "架空症候群の定義は？");
});

test("HTTP: each mode brings its own headings, in order; the doctor's own assessment adds one section, and only when typed", async () => {
  for (const mode of ["assess", "ddx", "miss", "consult"] as const) {
    const sys = caseSystem(mode, false);
    let from = sys.indexOf("この依頼の型");
    assert.ok(from > 0, mode);
    for (const h of MODE_HEADINGS[mode]) {
      const at = sys.indexOf(`## ${h}`, from);
      assert.ok(at >= from, `${mode}: ${h}`);
      from = at;
    }
    assert.ok(!sys.includes("先生自身のアセスメント"), mode); // nothing about the doctor's own assessment without one
  }
  assert.ok(!caseSystem("assess", false).includes(OWN_SECTION_ASSESS));
  assert.ok(!caseSystem("ddx", false).includes(OWN_SECTION_DDX));
  assert.match(caseSystem("assess", true), new RegExp(`## ${OWN_SECTION_ASSESS}`));
  assert.match(caseSystem("ddx", true), new RegExp(`## ${OWN_SECTION_DDX}`));
  // a difference, never a grade
  assert.match(caseSystem("assess", true), /正しい・誤りの判定、点数、評価はしません/);

  // and through the HTTP layer: the section is requested only when the case carries the doctor's assessment
  const without = fakeModel();
  await (await handle(post("/api/ask", { mode: "assess", case: CASE }), app({ fetchImpl: without.fetchImpl }))).text();
  assert.ok(!JSON.stringify(without.calls[0]).includes("先生の案"));
  assert.ok(!JSON.stringify(without.calls[0]).includes("先生自身のアセスメント"));
  const withOwn = fakeModel();
  await (await handle(post("/api/ask", { mode: "assess", case: { ...CASE, own: "腎前性AKIを第一に考える" } }), app({ fetchImpl: withOwn.fetchImpl }))).text();
  assert.match(withOwn.calls[0].system[1].text, /先生の案との差/);
  assert.match(withOwn.calls[0].messages.at(-1).content, /先生自身のアセスメント（先生の案）: 腎前性AKIを第一に考える/);
});

test("HTTP: a case without a mode is a free question about the case; a mode without a case is refused", async () => {
  const api = fakeModel();
  const res = await handle(post("/api/ask", { question: "輸液は何から考える？", case: CASE }), app({ fetchImpl: api.fetchImpl }));
  assert.equal(res.status, 200);
  await res.text();
  assert.match(api.calls[0].system[1].text, /この依頼の型: 症例を踏まえた質問/);
  assert.ok(api.calls[0].messages.at(-1).content.endsWith("【依頼】輸液は何から考える？"));

  const none = fakeModel();
  const noCase = await handle(post("/api/ask", { question: "q", mode: "ddx" }), app({ fetchImpl: none.fetchImpl }));
  assert.equal(noCase.status, 400);
  assert.equal(((await noCase.json()) as any).code, "case_required");
  const badMode = await handle(post("/api/ask", { question: "q", mode: "treat", case: CASE }), app({ fetchImpl: none.fetchImpl }));
  assert.equal(((await badMode.json()) as any).code, "bad_mode");
  const empty = await handle(post("/api/ask", { question: "q", mode: "ddx", case: { age: "72" } }), app({ fetchImpl: none.fetchImpl }));
  assert.equal(((await empty.json()) as any).code, "empty_case");
  // a typed question is required in "ask"; the buttons need none
  assert.equal((await handle(post("/api/ask", { case: CASE }), app({ fetchImpl: none.fetchImpl }))).status, 400);
  assert.equal(none.calls.length, 0);
});

// ---------------------------------------------------------------------------------- identifier check on every field
test("HTTP guard: an identifier-like text in ANY free-text field of the case is refused before the model is called; kinds only", async () => {
  for (const field of Object.keys(TEXT_LIMITS)) {
    const api = fakeModel();
    const res = await handle(post("/api/ask", { mode: "ddx", case: { ...CASE, [field]: `${field === "own" ? "見立て: " : ""}カルテ番号 12345678 の件` } }), app({ fetchImpl: api.fetchImpl }));
    assert.equal(res.status, 400, field);
    const j: any = await res.json();
    assert.equal(j.code, "possible_identifier", field);
    assert.ok(j.labels.includes("「カルテ番号」の語"), field);
    assert.ok(!JSON.stringify(j).includes("12345678"), field);
    assert.equal(api.calls.length, 0, field); // nothing reached the model
  }
  // acknowledged on the screen: it goes through
  const ok = fakeModel();
  const acked = await handle(post("/api/ask", { mode: "ddx", ack_identifier: true, case: { ...CASE, complaint: "カルテ番号 12345678" } }), app({ fetchImpl: ok.fetchImpl }));
  assert.equal(acked.status, 200);
  await acked.text();
  assert.equal(ok.calls.length > 0, true);
  // clinical wording passes: an age band, vitals, lab values with units, a drug name
  const fine = fakeModel();
  assert.equal((await handle(post("/api/ask", { mode: "ddx", case: CASE }), app({ fetchImpl: fine.fetchImpl }))).status, 200);
});

// ---------------------------------------------------------------------------------- the safety parts keep working in case mode
test("number check: the doctor's own numbers in the case are not flagged; a number from nowhere is", async () => {
  const api = fakeModel("- Cr 2.4 mg/dL で、K 5.8 mEq/L。 [推論]\n- 架空薬Xを 777 mg 投与する。 [推論]");
  const evs: StreamEvent[] = [];
  const kase = parseCase(CASE);
  await runAsk({ db, apiKey: "k", model: "m", fetchImpl: api.fetchImpl }, { question: MODE_LABELS.assess, caseBlock: renderCase(kase), modeSystem: caseSystem("assess", false) }, (e) => evs.push(e));
  const fin = evs.at(-1) as Extract<StreamEvent, { t: "final" }>;
  assert.equal(fin.t, "final");
  assert.deepEqual(fin.numbers.map((n) => [n.text, n.status]), [["777 mg", "not_found"]]);
});

test("degraded: when the answer fails before any search, the case's words (not the button label) are searched", async () => {
  const bad = (async () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 })) as typeof fetch;
  const kase = parseCase({ ...CASE, complaint: "ゼルニア値の低下を指摘された", findings: "" });
  const evs: StreamEvent[] = [];
  await runAsk({ db, apiKey: "k", model: "m", fetchImpl: bad }, { question: MODE_LABELS.ddx, caseBlock: renderCase(kase), modeSystem: caseSystem("ddx", false), hint: `${kase.complaint} ${kase.findings}` }, (e) => evs.push(e));
  const last = evs.at(-1) as Extract<StreamEvent, { t: "degraded" }>;
  assert.equal(last.t, "degraded");
  assert.ok(last.items.some((i) => /架空症候群/.test(i.title)));
});

test("daily cap: a case-mode ask is counted like any other ask", async () => {
  let n = 0;
  const counter = { increment: async () => ++n };
  const api = fakeModel();
  await (await handle(post("/api/ask", { mode: "ddx", case: CASE }), app({ fetchImpl: api.fetchImpl, dailyAskLimit: 5, counter }))).text();
  assert.equal(n, 1);
  // a refused request (identifier / bad case) is not counted
  await handle(post("/api/ask", { mode: "ddx", case: { ...CASE, vitals: "患者ID 99" } }), app({ fetchImpl: api.fetchImpl, dailyAskLimit: 5, counter }));
  await handle(post("/api/ask", { mode: "ddx", case: { age: "72" } }), app({ fetchImpl: api.fetchImpl, dailyAskLimit: 5, counter }));
  assert.equal(n, 1);
});

// ---------------------------------------------------------------------------------- saved with the conversation
test("conversation: the case a turn was asked with is saved in its payload and comes back; identifier-like text in it is refused", async () => {
  const s = convStore(openRw(), { retentionDays: 30 });
  const id = "conv-case-0001";
  const payload = { kind: "final", blocks: [{ text: "草案", citations: [] }], mode: "assess", case: CASE };
  assert.equal(await s.append(id, { question: MODE_LABELS.assess, answer: "草案", payload }, "2026-10-24T00:00:00Z"), 1);
  const got = await s.get(id);
  assert.deepEqual((got!.turns[0].payload as any).case, CASE);
  assert.equal((got!.turns[0].payload as any).mode, "assess");

  const rw = openRw();
  const s2 = convStore(rw, { retentionDays: 30 });
  await assert.rejects(
    s2.append(id, { question: MODE_LABELS.ddx, answer: "a", payload: { ...payload, case: { ...CASE, findings: "患者ID 12345 の検査" } } }, "2026-10-24T00:00:00Z"),
    (e: any) => e instanceof ConvInputError && e.code === "possible_identifier" && !e.message.includes("12345"),
  );
  assert.deepEqual(await s2.list("2026-10-24T00:00:00Z"), []); // refused before anything was written
});

// ---------------------------------------------------------------------------------- prompt pins
test("case rules: the source tags, unknown-is-not-negative, no patient-specific dose maths, no case values in web search", () => {
  for (const tag of ["[推論]", "[標準・出典未確認]", "[施設依存]"]) assert.ok(CASE_RULES.includes(tag), tag);
  assert.match(CASE_RULES, /「（未入力）」は未確認であり、陰性や正常ではありません/);
  assert.match(CASE_RULES, /要検算/);
  assert.match(CASE_RULES, /【出典未確認・要確認】/);
  assert.match(CASE_RULES, /web_search の検索語に入れません/);
  assert.match(CASE_RULES, /最終判断は先生がします/);
  assert.match(CASE_RULES, /施設プロトコルは別途確認/);
  assert.match(CASE_RULES, /頁を自分で書かない/); // pages come from the citation metadata
  // the doctor's own assessment is not mentioned in the rules shared by every request
  assert.ok(!CASE_RULES.includes("先生の案"));
});

// ---------------------------------------------------------------------------------- the screen's lists are the Worker's
test("web/case-model.js equals worker/src/casemode.ts: choices, limits and mode labels", () => {
  assert.equal(web.AGE_MAX, AGE_MAX);
  assert.deepEqual(web.LEGACY_AGES, [...LEGACY_AGES]);
  for (const v of ["0", "5", "72", "130", "131", "072", "7.5", "", "70代", "-1"]) assert.equal(web.isAgeYears(v), isAgeYears(v), String(v));
  for (const v of ["72", "0", "70代", "", "x"]) assert.equal(web.ageText(v), ageText(v), v);
  assert.deepEqual(web.SEXES, [...SEXES]);
  assert.deepEqual(web.SETTINGS, [...SETTINGS]);
  assert.deepEqual(Object.fromEntries(web.FIELDS.map((f: any) => [f.key, f.max])), TEXT_LIMITS);
  assert.deepEqual(web.TEXT_KEYS, Object.keys(TEXT_LIMITS));
  assert.equal(web.STRUCTURED_LIMIT, STRUCTURED_LIMIT);
  // the four buttons: not the free question, and not case creation (which has its own dialog)
  assert.deepEqual(web.MODES.map((m: any) => [m.id, m.label]), MODES.filter((m) => m !== "ask" && m !== "create").map((m) => [m, MODE_LABELS[m]]));
  assert.equal(web.CREATE_LABEL, MODE_LABELS.create);
});

test("web/case-model.js: cleanCase keeps only known keys and choices, cuts to the limit; summary and rows show what was typed", () => {
  const c = web.cleanCase({ ...CASE, age: "75歳", sex: "女性", extra: "x", complaint: "あ".repeat(2000), history: 7 });
  assert.equal(c.age, "75"); // typed as "75歳": read as whole years
  assert.equal(c.sex, "女性");
  assert.equal(c.complaint.length, TEXT_LIMITS.complaint);
  assert.equal(c.history, "");
  assert.ok(!("extra" in c));
  assert.deepEqual(web.cleanCase(null), web.emptyCase());
  assert.ok(web.isEmptyCase({ ...web.emptyCase(), age: "72", own: "x" }));
  assert.equal(web.caseSummary(parseCase(CASE)), "72歳・男性・救急｜3日前から発熱と咳。昨日から尿量が減った。");
  assert.deepEqual(web.caseRows({ ...web.emptyCase(), complaint: "発熱", sex: "女性" }), [["年齢・性別", "女性"], ["主訴と経過", "発熱"]]);
  assert.equal(web.caseKey(CASE), web.caseKey({ ...CASE, extra: "ignored" }));
  assert.notEqual(web.caseKey(CASE), web.caseKey({ ...CASE, vitals: "BP 80/50" }));
});

// ---------------------------------------------------------------------------------- structured intake (docs/clinical-use.md 1e)
const STRUCTURED = "場面・症候: 救急外来 × 腹痛（clinical-modules のフローの質問への答え。未入力の項目は未確認で、陰性ではありません）\n［受け入れ］\n救急隊の事前情報：バイタルは安定\n未入力の中核項目（2件。未確認）: 気道、呼吸の評価";

test("structured: the flow's answers are one more text of the case; alone it is enough; it is shown as typed and an absent one adds no row", () => {
  const c = parseCase({ age: "72", structured: `  ${STRUCTURED}\r\n` });
  assert.equal(c.structured, STRUCTURED);
  assert.ok(!isEmptyCase(c)); // the flow's answers alone are a case
  assert.ok(caseTexts(c).includes(STRUCTURED));
  const text = renderCase(c);
  assert.match(text, /- 場面・症候の質問への答え（先生が選んだ・入力したもの。未入力は未確認）: 場面・症候: 救急外来 × 腹痛/);
  assert.match(text, /- 主訴と経過: （未入力）/); // the other fields still say unknown, not negative
  assert.ok(!renderCase(parseCase(CASE)).includes("場面・症候の質問への答え")); // nothing added when the flow is not used
  assert.equal(parseCase({ ...CASE, structured: "" }).structured, "");
  assert.equal(parseCase({ ...CASE, structured: null }).structured, "");
  // limits and types
  const bad = (raw: unknown) => {
    try {
      parseCase(raw);
      return "";
    } catch (e) {
      return (e as CaseInputError).code;
    }
  };
  assert.equal(bad({ ...CASE, structured: 5 }), "bad_case");
  assert.equal(bad({ ...CASE, structured: "あ".repeat(STRUCTURED_LIMIT + 1) }), "bad_case");
  assert.equal(bad({ ...CASE, structured: "あ".repeat(STRUCTURED_LIMIT) }), "");
  // the form's own answers (`intake`) stay on the screen: the Worker drops them
  assert.ok(!("intake" in parseCase({ ...CASE, structured: STRUCTURED, intake: { flow: "x", answers: { a: "b" } } })));
});

test("structured: the model gets the answers and the unknown-is-not-negative wording; the form's own answers are not sent on; the search starts from the answered lines", async () => {
  const api = fakeModel();
  const res = await handle(post("/api/ask", { mode: "ddx", case: { ...CASE, structured: STRUCTURED, intake: { flow: "emergency-department.abdominal-pain", answers: { ems_state: "stable" } } } }), app({ fetchImpl: api.fetchImpl }));
  assert.equal(res.status, 200);
  await res.text();
  const first = JSON.stringify(api.calls[0].messages);
  assert.ok(first.includes("救急隊の事前情報：バイタルは安定"));
  assert.ok(first.includes("未入力の項目は未確認で、陰性ではありません"));
  assert.ok(!first.includes("ems_state"), "the screen's own answers are not forwarded");
});

test("structured: an identifier-like text in the flow's answers is refused before the model is called; kinds only", async () => {
  const api = fakeModel();
  const res = await handle(post("/api/ask", { mode: "assess", case: { ...CASE, structured: `${STRUCTURED}\n既往：カルテ番号 12345678` } }), app({ fetchImpl: api.fetchImpl }));
  assert.equal(res.status, 400);
  const j: any = await res.json();
  assert.equal(j.code, "possible_identifier");
  assert.ok(j.labels.includes("「カルテ番号」の語"));
  assert.ok(!JSON.stringify(j).includes("12345678"));
  assert.equal(api.calls.length, 0);
});

test("structured: the doctor's own numbers in the flow's answers are not flagged by the number check", async () => {
  const api = fakeModel("- 腹痛は 36 時間前から。 [推論]\n- 架空薬Xを 888 mg 投与する。 [推論]");
  const evs: StreamEvent[] = [];
  const kase = parseCase({ ...CASE, structured: "場面・症候: 救急外来 × 腹痛（x）\n［病歴・診察］\n発症からの時間：36 時間" });
  await runAsk({ db, apiKey: "k", model: "m", fetchImpl: api.fetchImpl }, { question: MODE_LABELS.ddx, caseBlock: renderCase(kase), modeSystem: caseSystem("ddx", false) }, (e) => evs.push(e));
  const fin = evs.at(-1) as Extract<StreamEvent, { t: "final" }>;
  assert.deepEqual(fin.numbers.map((n) => [n.text, n.status]), [["888 mg", "not_found"]]);
});

test("conversation: the form's answers kept with a turn (payload.case.intake) come back, and are checked at any depth", async () => {
  const s = convStore(openRw(), { retentionDays: 30 });
  const id = "conv-intake-001";
  const kase = { ...CASE, structured: STRUCTURED, intake: { flow: "emergency-department.abdominal-pain", answers: { ems_state: "stable", assoc: ["nausea", "fever"], note: "経過メモ" } } };
  const payload = { kind: "final", blocks: [{ text: "草案", citations: [] }], mode: "ddx", case: kase };
  assert.equal(await s.append(id, { question: MODE_LABELS.ddx, answer: "草案", payload }, "2026-10-24T00:00:00Z"), 1);
  assert.deepEqual((await s.get(id))!.turns[0].payload, payload);

  const s2 = convStore(openRw(), { retentionDays: 30 });
  for (const where of ["structured", "text answer", "list answer"]) {
    const bad =
      where === "structured"
        ? { ...kase, structured: `${STRUCTURED}\n患者ID 12345 の件` }
        : where === "text answer"
          ? { ...kase, intake: { ...kase.intake, answers: { note: "カルテ番号 12345678" } } }
          : { ...kase, intake: { ...kase.intake, answers: { assoc: ["ok", "電話 090-1234-5678"] } } };
    await assert.rejects(
      s2.append(id, { question: MODE_LABELS.ddx, answer: "a", payload: { ...payload, case: bad } }, "2026-10-24T00:00:00Z"),
      (e: any) => e instanceof ConvInputError && e.code === "possible_identifier" && !/12345|090/.test(e.message),
      where,
    );
  }
  assert.deepEqual(await s2.list("2026-10-24T00:00:00Z"), []);
});

test("web/case-model.js: structured and intake — kept when well-formed, dropped when not; the server copy has no intake; rows show the answers before the doctor's own plan", () => {
  const raw = { ...CASE, structured: STRUCTURED, intake: { flow: "emergency-department.abdominal-pain", answers: { ems_state: "stable", assoc: ["nausea", 7, "fever"], n: 36, bad: { x: 1 } } } };
  const c = web.cleanCase(raw);
  assert.equal(c.structured, STRUCTURED);
  assert.deepEqual(c.intake, { flow: "emergency-department.abdominal-pain", answers: { ems_state: "stable", assoc: ["nausea", "fever"], n: 36 } });
  // answers without their text mean nothing (the text is what is sent): the form is not restored
  assert.equal(web.cleanCase({ ...CASE, intake: raw.intake }).intake, null);
  assert.equal(web.cleanCase({ ...raw, intake: "x" }).intake, null);
  assert.equal(web.cleanCase({ ...raw, intake: { flow: 3, answers: {} } }).intake, null);
  assert.equal(web.cleanCase({ ...raw, intake: { flow: "f", answers: [] } }).intake, null);
  assert.equal(web.cleanCase({ ...raw, structured: "あ".repeat(STRUCTURED_LIMIT + 50) }).structured.length, STRUCTURED_LIMIT);
  assert.ok(!("intake" in web.caseForServer(c)));
  assert.equal(web.caseForServer(c).structured, STRUCTURED);
  assert.ok(!web.isEmptyCase({ ...web.emptyCase(), structured: "x" }));
  assert.ok(web.caseTexts(c).includes(STRUCTURED));
  const rows = web.caseRows({ ...web.emptyCase(), complaint: "発熱", structured: "答え", own: "見立て" }).map((r: string[]) => r[0]);
  assert.deepEqual(rows, ["主訴と経過", "場面・症候の入力", "先生自身のアセスメント（任意）"]);
  // the same case with and without the form's answers is not the same case for the identifier acknowledgement
  assert.notEqual(web.caseKey(raw), web.caseKey({ ...raw, structured: `${STRUCTURED}\n追加` }));
});

// ---------------------------------------------------------------------------------- the fictional mark (enhancement-plan 8.21 stage 4)
test("synthetic: a case may carry the fictional mark (true only); the model never sees it; web and Worker keep it alike", () => {
  assert.equal(parseCase({ ...CASE, synthetic: true }).synthetic, true);
  assert.ok(!("synthetic" in parseCase(CASE)));
  assert.ok(!("synthetic" in parseCase({ ...CASE, synthetic: null })));
  assert.throws(() => parseCase({ ...CASE, synthetic: "yes" }), CaseInputError);
  assert.throws(() => parseCase({ ...CASE, synthetic: false }), CaseInputError);
  assert.equal(renderCase(parseCase({ ...CASE, synthetic: true })), renderCase(parseCase(CASE)));
  assert.equal(web.cleanCase({ ...CASE, synthetic: true }).synthetic, true);
  assert.ok(!("synthetic" in web.cleanCase({ ...CASE, synthetic: "yes" })));
  assert.equal(web.SYNTHETIC_MARK, "〔架空症例〕");
  assert.notEqual(web.caseKey({ ...CASE, synthetic: true }), web.caseKey(CASE)); // a fictional case is not the same case as a real one
});

test("synthetic: an ask about a fictional case is counted in the daily cap but not in the answer counts (F4)", async () => {
  let asks = 0;
  const notes: any[] = [];
  const counter = { increment: async () => ++asks, note: async (day: string, kinds: readonly string[]) => void notes.push([day, [...kinds]]) };
  const run = async (kase: object) => (await handle(post("/api/ask", { mode: "ddx", case: kase }), app({ fetchImpl: fakeModel().fetchImpl, dailyAskLimit: 5, counter: counter as any }))).text();
  await run(CASE);
  assert.equal(asks, 1);
  assert.equal(notes.length, 1);
  await run({ ...CASE, synthetic: true });
  assert.equal(asks, 2);
  assert.equal(notes.length, 1);
});
