// Stage 4b (docs/enhancement-plan.md 8.16): the assessment/plan draft for a scene, and the summary of the case record that goes with it.
// What is pinned: the screen's lists equal the Worker's, each scene's headings and the part of the chart each is, what the model is sent (the
// scene's headings, the record's rules, the summary after the case and nowhere else), the refusals (a scene outside the draft, a record
// scene with no record, a summary with no scene that follows a record, an identifier in the summary), and that nothing is stored.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import type { Db } from "../src/db.ts";
import { AI_NOTE, BRIEF_LIMIT, BRIEF_SCENES, CaseInputError, RECORD_SCENES, SCENES, SCENE_LABELS, parseBrief, parseScene, renderBrief } from "../src/casemode.ts";
import { handle, type AppDeps } from "../src/handler.ts";
import { BRIEF_RULES, CASE_RULES, MODE_HEADINGS, SCENE_READERS, SCENE_SECTIONS, caseSystem } from "../src/prompt.ts";
import { buildFixtureDb, openDb, REPO } from "./nodeDb.ts";

const web: any = await import(join(REPO, "web", "draft-scenes.js"));
const assemble: any = await import(join(REPO, "web", "note-assemble.js"));

let db: Db;
before(() => {
  db = openDb(buildFixtureDb());
});
const TOKEN = "test-token-0123456789abcdef";
const app = (extra: Partial<AppDeps> = {}): AppDeps => ({ db, apiKey: "k", appToken: TOKEN, model: "m", ...extra });
const post = (body: unknown) => new Request("http://x/api/ask", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });

type Ev = [string, any];
/** A scripted fake of POST /v1/messages: a search first, then a plain answer.  Records every request body. */
function fakeModel(answer = "整理です。 [推論]") {
  const calls: any[] = [];
  const sse = (evs: Ev[]) => new Response(evs.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  const fetchImpl = (async (_url: any, init: any) => {
    calls.push(JSON.parse(init.body));
    if (calls.length % 2 === 1) {
      return sse([
        ["message_start", { type: "message_start", message: { usage: { input_tokens: 10 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "search_books", input: {} } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ queries: ["ゼルニア値 基準"] }) } }],
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
const events = async (res: Response): Promise<any[]> => (await res.text()).split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));

const CASE = { age: "70代", sex: "男性", setting: "病棟", complaint: "3日前から発熱と咳。昨日から尿量が減った。", vitals: "BP 92/54, HR 108", findings: "Cr 2.4 mg/dL, K 5.8 mEq/L", history: "高血圧" };
const BRIEF = "入院2日目の時点の記録（確度・計画の状態・推移・課題の完了は、その日までに先生が記録したもの。問題名・評価と計画の文・問題の順序は、いまの記録のまま）\n問題（優先順位順）:\n1. 腎前性AKI — 確度: 可能性が高い\n  計画: ・予定・検討: 細胞外液の輸液を検討";

// ---------------------------------------------------------------------------------- the screen's lists equal the Worker's
test("the scenes, their labels and the record scenes are the same on the screen and in the Worker", () => {
  assert.deepEqual(web.SCENES, [...SCENES]);
  assert.deepEqual(web.SCENE_LABELS, SCENE_LABELS);
  assert.deepEqual(web.RECORD_SCENES, [...RECORD_SCENES]);
  assert.deepEqual(web.BRIEF_SCENES, [...BRIEF_SCENES]);
  assert.equal(web.BRIEF_LIMIT, BRIEF_LIMIT);
  // a record scene takes the summary, and every scene that takes one is one that follows a record
  for (const s of RECORD_SCENES) assert.ok(BRIEF_SCENES.includes(s), s);
  assert.deepEqual(SCENES.map((s) => web.briefNeed(s)), ["none", "none", "optional", "record", "record", "record"]);
});

test("each scene's headings are the same on the screen and in the prompt, in the same order, ending with the two sections about the draft itself", () => {
  for (const scene of SCENES) {
    const prompt = SCENE_SECTIONS[scene].map((s) => s.h);
    assert.deepEqual(web.SCENE_HEADINGS[scene].map((x: any) => x.h), prompt, scene);
    assert.deepEqual(prompt.slice(-2), [MODE_HEADINGS.assess[4], MODE_HEADINGS.assess[5]], scene);
    assert.ok(SCENE_READERS[scene].length > 10, scene);
    assert.ok(SCENE_SECTIONS[scene].every((s) => s.body.startsWith("- ")), `${scene}: every heading says what to write under it`);
  }
  assert.deepEqual(Object.keys(SCENE_SECTIONS), [...SCENES]);
});

// ---------------------------------------------------------------------------------- what each heading is when an item is adopted
test("each heading is a part of the chart the doctor can adopt, or nothing: the roles are pinned", () => {
  const roles = (scene: string) => web.SCENE_HEADINGS[scene].map((x: any) => x.role);
  assert.deepEqual(roles("ed"), ["problems", "plan", "assessment", "plan", "contingency", null, null]);
  assert.deepEqual(roles("op_first"), ["problems", "assessment", "plan", "contingency", null, null]);
  assert.deepEqual(roles("adm"), ["problems", "assessment", "plan", "contingency", "contingency", null, null]);
  assert.deepEqual(roles("prog"), [null, "assessment", "plan", "problems", "contingency", null, null]);
  assert.deepEqual(roles("interim"), [null, "assessment", "plan", "contingency", null, null]);
  assert.deepEqual(roles("dc"), [null, "assessment", "plan", null, null]);
  // the note screen reads a heading the same way (a heading's role does not depend on the scene)
  for (const scene of SCENES) {
    for (const x of web.SCENE_HEADINGS[scene]) assert.equal(assemble.headingRole(x.h), x.role, `${scene}: ${x.h}`);
  }
  // a base heading has one role wherever it appears, and the common draft's headings keep theirs
  const seen = new Map<string, string | null>();
  for (const scene of SCENES) for (const x of web.SCENE_HEADINGS[scene]) {
    const b = web.baseHeading(x.h);
    if (seen.has(b)) assert.equal(seen.get(b), x.role, b);
    seen.set(b, x.role);
  }
  assert.deepEqual(MODE_HEADINGS.assess.map((h: string) => assemble.headingRole(h)), ["problems", "assessment", "plan", "contingency", null, null]);
  // the sections that are about the draft itself are never adoptable, in any scene
  for (const h of [...assemble.NOT_ADOPTABLE, "先生の案との差", "確認すべき数値（原本の頁で確認）", "書籍に見つからなかった点"]) assert.equal(assemble.headingRole(h), null, h);
  // every scene has something to adopt
  for (const scene of SCENES) assert.ok(roles(scene).some((r: string | null) => r), scene);
  // the record scenes read the record first, and that section is not carried over by a tick
  for (const scene of ["prog", "interim", "dc"]) assert.equal(roles(scene)[0], null);
});

// ---------------------------------------------------------------------------------- the prompt
test("caseSystem: a scene puts its own headings in order; no scene is the common draft; the record's rules come only with a summary", () => {
  for (const scene of SCENES) {
    const sys = caseSystem("assess", false, scene);
    const heads = [...sys.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(heads, ["症例が添えられているとき（症例モード）", "この依頼の型: アセスメントとプラン（草案）", ...SCENE_SECTIONS[scene].map((s) => s.h)], scene);
    assert.match(sys, new RegExp(`場面: ${SCENE_LABELS[scene]}。読み手: `), scene);
    assert.ok(sys.startsWith(CASE_RULES), scene);
    assert.ok(!sys.includes("症例の記録が添えられているとき"), `${scene}: no summary, no record rules`);
  }
  const common = caseSystem("assess", false);
  assert.deepEqual([...common.matchAll(/^## (.+)$/gm)].map((m) => m[1]).slice(2), MODE_HEADINGS.assess);
  assert.ok(!common.includes("場面:"));
  const withBrief = caseSystem("assess", false, "prog", true);
  assert.ok(withBrief.includes(BRIEF_RULES) && withBrief.indexOf(BRIEF_RULES) > withBrief.indexOf(CASE_RULES));
  // the doctor's own assessment still adds its section after a scene's headings
  const own = caseSystem("assess", true, "adm");
  assert.ok(own.trimEnd().split("\n## ").at(-1)!.startsWith("先生の案との差"));
  // a scene changes the assessment/plan draft only
  for (const m of ["ddx", "miss", "consult", "ask"] as const) assert.equal(caseSystem(m, false, "ed"), caseSystem(m, false), m);
});

test("the rules say what a summary is and is not: no later fact, no draft as evidence, no action done unless the doctor recorded it", () => {
  assert.match(BRIEF_RULES, /その日までに先生が記録したもので、後日の判断は含まれません/);
  assert.match(BRIEF_RULES, /問題名・評価と計画の文・問題の順序は、いまの記録のままです/);
  assert.match(BRIEF_RULES, /未記入のまま|未記入として扱い/);
  assert.match(BRIEF_RULES, /AI草案を採用したもの/);
  assert.match(BRIEF_RULES, /新しい事実の根拠にしたり、書籍の記述として引用したりしません/);
  assert.match(BRIEF_RULES, /「実施」「変更」「中止」は、先生が記録したものだけ/);
  assert.match(BRIEF_RULES, /実施済みとして書きません/);
  // a scene adds no fact and decides nothing the doctor chooses
  for (const s of ["prog", "interim", "dc"] as const) {
    const text = SCENE_SECTIONS[s].map((x) => x.body).join("\n");
    assert.match(text, /記録にない/, s);
  }
  assert.match(SCENE_SECTIONS.prog.map((x) => x.body).join("\n"), /推移（改善・不変・悪化）は決めません。選ぶのは先生です/);
  assert.match(SCENE_SECTIONS.interim.map((x) => x.body).join("\n"), /診断の確度は、先生が選んだものを変えません/);
  assert.match(SCENE_SECTIONS.dc.map((x) => x.body).join("\n"), /担当と期限は書きません/);
  assert.match(SCENE_SECTIONS.ed.map((x) => x.body).join("\n"), /重症度の等級や点数は決めません/);
  assert.match(SCENE_SECTIONS.ed.map((x) => x.body).join("\n"), /実施したとは書きません/);
  // the scene's text carries no dose or threshold of its own
  const all = Object.values(SCENE_SECTIONS).flatMap((l) => l.map((x) => x.body)).join("\n");
  assert.doesNotMatch(all, /\d+\s*(mg|mL|mEq|mmol|単位|μg|µg|mmHg|%)/i);
});

// ---------------------------------------------------------------------------------- parsing
test("parseScene / parseBrief: the six scenes; absent is empty; anything else is refused", () => {
  assert.deepEqual([...SCENES], ["ed", "op_first", "adm", "prog", "interim", "dc"]);
  for (const s of SCENES) assert.equal(parseScene(s), s);
  for (const v of [undefined, null, ""]) assert.equal(parseScene(v), undefined);
  assert.throws(() => parseScene("icu"), (e: any) => e instanceof CaseInputError && e.code === "bad_scene");
  assert.throws(() => parseScene(3), CaseInputError);
  assert.equal(parseBrief(undefined), "");
  assert.equal(parseBrief("  \r\n問題\r\n"), "問題");
  assert.equal(parseBrief("あ".repeat(BRIEF_LIMIT)).length, BRIEF_LIMIT);
  assert.throws(() => parseBrief("あ".repeat(BRIEF_LIMIT + 1)), (e: any) => e instanceof CaseInputError && e.code === "bad_brief");
  assert.throws(() => parseBrief({ a: 1 }), CaseInputError);
  assert.match(renderBrief("本文"), /^【症例の記録（先生が記録したもの）】.*その日までに先生が記録したものです。問題名・評価と計画の文・問題の順序は、いまの記録のままです.*\n本文$/s);
});

// ---------------------------------------------------------------------------------- what the model is sent
test("HTTP: a scene's draft sends its headings; the question names the scene; no summary is sent for a scene that does not follow a record", async () => {
  const api = fakeModel();
  const res = await handle(post({ question: "", mode: "assess", scene: "ed", case: { ...CASE, setting: "救急" } }), app({ fetchImpl: api.fetchImpl }));
  assert.equal(res.status, 200);
  assert.equal((await events(res)).at(-1).t, "final");
  const r1 = api.calls[0];
  assert.equal(r1.system.length, 2);
  const heads = [...r1.system[1].text.matchAll(/^## (.+)$/gm)].map((m: any) => m[1]);
  assert.deepEqual(heads.slice(2), SCENE_SECTIONS.ed.map((s) => s.h));
  const last = r1.messages.at(-1).content;
  assert.match(last, /【依頼】アセスメントとプラン（草案）（救急外来）$/);
  assert.ok(!last.includes("【症例の記録"));
  assert.ok(!r1.system[1].text.includes("症例の記録が添えられているとき"));
});

test("HTTP: a record scene sends the summary after the case and before the request, with the record's rules, and the history stays free of it", async () => {
  const api = fakeModel();
  const res = await handle(
    post({ question: "", mode: "assess", scene: "prog", case: CASE, record_brief: BRIEF, history: [{ role: "user", text: "前の質問" }, { role: "assistant", text: "前の回答" }] }),
    app({ fetchImpl: api.fetchImpl }),
  );
  assert.equal(res.status, 200);
  assert.equal((await events(res)).at(-1).t, "final");
  const r1 = api.calls[0];
  const last = r1.messages.at(-1).content;
  assert.ok(last.indexOf("【症例（入力）】") < last.indexOf("【症例の記録（先生が記録したもの）】") && last.indexOf("【症例の記録（先生が記録したもの）】") < last.indexOf("【依頼】"), "case, then the summary, then the request");
  assert.ok(last.includes("入院2日目の時点の記録"));
  assert.ok(r1.system[1].text.includes(BRIEF_RULES));
  assert.deepEqual([...r1.system[1].text.matchAll(/^## (.+)$/gm)].map((m: any) => m[1]).slice(3), SCENE_SECTIONS.prog.map((s) => s.h));
  for (const m of r1.messages.slice(0, -1)) assert.ok(!String(m.content).includes("入院2日目の時点の記録"), "the summary is not in the history");
  // the system prompt that is cached for every request is untouched
  assert.ok(!JSON.stringify(r1.system[0]).includes("症例の記録"));
});

test("HTTP: the admission scene takes a summary when there is one and works without", async () => {
  const withBrief = fakeModel();
  assert.equal((await handle(post({ question: "", mode: "assess", scene: "adm", case: CASE, record_brief: BRIEF }), app({ fetchImpl: withBrief.fetchImpl }))).status, 200);
  assert.ok(withBrief.calls[0].messages.at(-1).content.includes("【症例の記録"));
  const without = fakeModel();
  const res = await handle(post({ question: "", mode: "assess", scene: "adm", case: CASE }), app({ fetchImpl: without.fetchImpl }));
  assert.equal(res.status, 200);
  assert.ok(!without.calls[0].messages.at(-1).content.includes("【症例の記録"));
});

// ---------------------------------------------------------------------------------- the refusals
test("HTTP: refusals reach the model never (a scene outside the draft, an unknown scene, a record scene without its record, a summary without a scene that follows a record)", async () => {
  const api = fakeModel();
  const refuse = async (body: unknown, status: number, code: string) => {
    const res = await handle(post(body), app({ fetchImpl: api.fetchImpl }));
    assert.equal(res.status, status, code);
    assert.equal(((await res.json()) as any).code, code);
  };
  await refuse({ question: "", mode: "ddx", scene: "ed", case: CASE }, 400, "scene_needs_assess");
  await refuse({ question: "病態は？", scene: "ed", case: CASE }, 400, "scene_needs_assess"); // a typed question about the case is mode "ask"
  await refuse({ question: "", mode: "assess", scene: "icu", case: CASE }, 400, "bad_scene");
  for (const scene of RECORD_SCENES) await refuse({ question: "", mode: "assess", scene, case: CASE }, 400, "record_required");
  await refuse({ question: "", mode: "assess", scene: "ed", case: CASE, record_brief: BRIEF }, 400, "brief_needs_scene");
  await refuse({ question: "", mode: "assess", scene: "op_first", case: CASE, record_brief: BRIEF }, 400, "brief_needs_scene");
  await refuse({ question: "", mode: "assess", case: CASE, record_brief: BRIEF }, 400, "brief_needs_scene");
  await refuse({ question: "", mode: "ddx", case: CASE, record_brief: BRIEF }, 400, "brief_needs_scene");
  await refuse({ question: "", mode: "assess", scene: "prog", case: CASE, record_brief: "あ".repeat(BRIEF_LIMIT + 1) }, 400, "bad_brief");
  await refuse({ question: "", mode: "assess", scene: "prog", case: CASE, record_brief: 5 }, 400, "bad_brief");
  assert.equal(api.calls.length, 0, "none of them reached the model");
});

test("HTTP: the summary gets the same identifier check as the case: refused without the doctor's confirmation, kinds only; sent with it", async () => {
  const api = fakeModel();
  const idnum = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].join(""); // built at run time: a 9-digit number is what the guard looks for
  const dirty = `${BRIEF}\n  評価: ・カルテ番号 ${idnum} の方`;
  const res = await handle(post({ question: "", mode: "assess", scene: "prog", case: CASE, record_brief: dirty }), app({ fetchImpl: api.fetchImpl }));
  assert.equal(res.status, 400);
  const j: any = await res.json();
  assert.equal(j.code, "possible_identifier");
  assert.ok(Array.isArray(j.labels) && j.labels.length > 0);
  assert.ok(!JSON.stringify(j).includes(idnum), "the matched text is never returned");
  assert.equal(api.calls.length, 0);
  const ok = await handle(post({ question: "", mode: "assess", scene: "prog", case: CASE, record_brief: dirty, ack_identifier: true }), app({ fetchImpl: api.fetchImpl }));
  assert.equal(ok.status, 200);
});

// ---------------------------------------------------------------------------------- nothing is stored
test("pins: the scene and the summary add no endpoint and no write; the summary is not part of the case that is saved with a conversation", () => {
  const handler = readFileSync(join(REPO, "worker", "src", "handler.ts"), "utf-8");
  assert.doesNotMatch(handler, /\/api\/(scene|brief)/);
  const mod = readFileSync(join(REPO, "worker", "src", "casemode.ts"), "utf-8");
  assert.doesNotMatch(mod.replace(/\/\/[^\n]*/g, ""), /INSERT|UPDATE |DELETE |\.run\(|\.exec\(/);
  // parseCase drops a `record_brief` smuggled inside the case (unknown keys are dropped), so it cannot reach a saved payload through the case
  const caseModel = readFileSync(join(REPO, "web", "case-model.js"), "utf-8");
  assert.doesNotMatch(caseModel, /record_brief|brief/);
});

test("pins: every module of the screen is in the service worker's shell list (a module left out is not there when the screen opens offline, or is stale)", () => {
  const sw = readFileSync(join(REPO, "web", "sw.js"), "utf-8");
  const shell = sw.slice(sw.indexOf("const SHELL = ["), sw.indexOf("];", sw.indexOf("const SHELL = [")));
  for (const f of readdirSync(join(REPO, "web")).filter((x) => x.endsWith(".js") && x !== "sw.js")) assert.ok(shell.includes(`"${f}"`), `${f} is not in the shell list of web/sw.js`);
  assert.match(sw, /const V = "medbook-shell-v\d+"/);
});

// ---------------------------------------------------------------------------------- review follow-ups (PR #17)
test("a number in a line the AI drafted is not the doctor's input: the number check still looks at it; the doctor's own lines are skipped as before", async () => {
  const ai = "計画: ・予定・検討: ノルアドレナリン 0.5 μg/kg/min で開始（AI草案を採用したもの）";
  const own = "計画: ・予定・検討: 補液量は 500 mL を検討";
  const brief = `入院2日目の時点の記録\n1. 腎前性AKI — 確度: 疑い\n  ${ai}\n  ${own}`;
  const answer = "昇圧薬は 0.5 μg/kg/min から始める。補液は 500 mL を検討する。";
  const run = async (b: string) => {
    const api = fakeModel(answer);
    const res = await handle(post({ question: "", mode: "assess", scene: "prog", case: CASE, record_brief: b }), app({ fetchImpl: api.fetchImpl }));
    assert.equal(res.status, 200);
    return (await events(res)).at(-1).numbers as { text: string; status: string }[];
  };
  const withAi = await run(brief);
  assert.deepEqual(withAi.map((n) => n.text), ["0.5 μg/kg/min"], "the AI's number is looked at (and is not in a book here), the doctor's 500 mL is not");
  assert.equal(withAi[0].status, "not_found");
  // without the mark the same line is the doctor's: nothing is flagged
  assert.deepEqual(await run(brief.replace("（AI草案を採用したもの）", "")), []);
});

test("the mark of an AI-drafted line is the same text on the screen and in the Worker", async () => {
  const rb: any = await import(join(REPO, "web", "record-brief.js"));
  assert.equal(rb.AI_NOTE, AI_NOTE);
});

test("headingRole answers null for a name an object has (constructor, toString, __proto__), and a scene in a saved conversation must be one of the scenes", async () => {
  for (const h of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    assert.equal(web.sceneHeadingRole(h), null, h);
    assert.equal(assemble.headingRole(h), null, h);
  }
  const { convStore, ConvInputError } = await import("../src/convstore.ts");
  const { openRw } = await import("./nodeDb.ts");
  const store = convStore(openRw(), { retentionDays: 30 });
  const id = "conv-scene-0001";
  const turn = (scene: unknown) => ({ question: "q", answer: "a", payload: { kind: "final", mode: "assess", case: { complaint: "x" }, ...(scene === undefined ? {} : { scene }) } });
  await store.append(id, turn("prog"), "2026-10-24T00:00:00Z");
  await store.append(id, turn(undefined), "2026-10-24T00:00:00Z");
  for (const bad of ["icu", 3, { a: 1 }, "患者ID 12345678"]) await assert.rejects(store.append(id, turn(bad), "2026-10-24T00:00:00Z"), (e: any) => e instanceof ConvInputError, String(bad));
});

test("a line that only says there is nothing to write (該当なし) gets no tick to adopt", () => {
  for (const t of ["該当なし", "該当なし。", "該当なし（記録に新しい問題はない）", "・該当なし", "  該当なし：理由"]) assert.equal(assemble.isNoneLine(t), true, t);
  for (const t of ["該当なしと言い切れない所見がある", "腎前性AKI", "", "新しい問題は該当なし以外にもある"]) assert.equal(assemble.isNoneLine(t), false, t);
});
