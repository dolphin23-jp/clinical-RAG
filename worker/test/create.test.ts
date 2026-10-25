// Creating a fictional case from the books (docs/enhancement-plan.md 7.4): the request, what the model is told, the copied-text check,
// the identifier check, saving with a conversation, and the screen's reading of the created case (web/case-create.js).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import type { Db } from "../src/db.ts";
import { runAsk, type StreamEvent } from "../src/anthropic.ts";
import { COURSE_DAYS, CREATE_LIMITS, CaseInputError, LEVELS, MODE_LABELS, SETTINGS, createTexts, parseCreate, renderCreate } from "../src/casemode.ts";
import { ConvInputError, convStore } from "../src/convstore.ts";
import { handle, type AppDeps } from "../src/handler.ts";
import { MIN_OVERLAP, findOverlaps } from "../src/overlap.ts";
import { COURSE_HEADING, COURSE_LAST_PART, COURSE_PARTS, COURSE_RULES, CREATE_HEADINGS, CREATE_INPUT_LABELS, CREATE_RULES, createSystem } from "../src/prompt.ts";
import { searchParents } from "../src/search.ts";
import { buildFixtureDb, openDb, openRw, REPO } from "./nodeDb.ts";

const web = (f: string) => join(REPO, "web", f);
const C: any = await import(web("case-create.js"));
const M: any = await import(web("case-model.js"));

let db: Db;
before(() => {
  db = openDb(buildFixtureDb());
});
const TOKEN = "test-token-0123456789abcdef";
const app = (extra: Partial<AppDeps> = {}): AppDeps => ({ db, apiKey: "k", appToken: TOKEN, model: "m", ...extra });
const post = (body: unknown) => new Request("http://x/api/ask", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });

type Ev = [string, any];
/** A scripted fake of POST /v1/messages: a search, then `answer` (no citations). Records every request body. */
function fakeModel(answer: string) {
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
const REQ = { theme: "腎前性AKI", setting: "救急", level: "紛らわしい鑑別あり", goal: "NSAIDsの関与を見落とさない", pitfall: true, days: 0 };

// ---------------------------------------------------------------------------------- the request
test("parseCreate: a theme is required; choices, limits and the pitfall switch are checked; defaults are filled", () => {
  assert.deepEqual(parseCreate({ theme: "  高K血症 " }), { theme: "高K血症", setting: "", level: "標準", goal: "", pitfall: true, days: 0 });
  assert.deepEqual(parseCreate(REQ), REQ);
  const code = (raw: unknown) => {
    try {
      parseCreate(raw);
      return "";
    } catch (e) {
      assert.ok(e instanceof CaseInputError);
      return (e as CaseInputError).code;
    }
  };
  assert.equal(code(null), "bad_create");
  assert.equal(code({}), "bad_create");
  assert.equal(code({ theme: "   " }), "bad_create");
  assert.equal(code({ theme: 5 }), "bad_create");
  assert.equal(code({ theme: "x".repeat(CREATE_LIMITS.theme + 1) }), "bad_create");
  assert.equal(code({ theme: "x".repeat(CREATE_LIMITS.theme) }), "");
  assert.equal(code({ theme: "a", goal: "x".repeat(CREATE_LIMITS.goal + 1) }), "bad_create");
  assert.equal(code({ theme: "a", level: "超難問" }), "bad_create");
  assert.equal(code({ theme: "a", setting: "ICU" }), "bad_create");
  assert.equal(code({ theme: "a", pitfall: "yes" }), "bad_create");
  // the days of the course after the admission: one of the listed counts; absent or null = none; anything else is refused
  assert.equal(parseCreate({ theme: "a", days: 7 }).days, 7);
  assert.equal(parseCreate({ theme: "a", days: null }).days, 0);
  for (const bad of [4, 15, -1, 7.5, "7", true, [7]]) assert.equal(code({ theme: "a", days: bad }), "bad_create", JSON.stringify(bad));
  assert.deepEqual([...COURSE_DAYS], [0, 3, 5, 7, 10, 14]);
  assert.deepEqual(createTexts(parseCreate(REQ)), ["腎前性AKI", "NSAIDsの関与を見落とさない"]);
  assert.match(renderCreate(parseCreate({ theme: "a", pitfall: false })), /- 場面: （指定なし）\n- 難しさ: 標準\n- 学ばせたいこと: （指定なし）\n- 落とし穴: 入れない$/);
  // the request says nothing of a course unless one is asked for (the request the model saw before is the one it sees now)
  assert.ok(!renderCreate(parseCreate({ theme: "a" })).includes("入院後の経過"));
  assert.match(renderCreate(parseCreate({ theme: "a", days: 5 })), /- 落とし穴: 入れる\n- 入院後の経過: 入院5日目まで、日ごとに作る$/);
});

test("what the model is told: new case, not a book's case; no thresholds or doses; no identifying detail; the diagnosis only under 見立て", () => {
  for (const must of [/新しい\*\*?架空症例|\*\*新しい架空症例\*\*/, /写したり、言い換えて焼き直したりしません/, /30字以上続けて一致すると/, /診断基準の閾値、薬の用量・投与速度は書きません/, /地名・施設名・職業の特定・年月日・氏名・ID/, /経過日数で書きます/, /診断名や見立てを書きません/, /\[推論\]/, /頁を自分で書かない/, /search_books/]) {
    assert.match(CREATE_RULES, must);
  }
  assert.ok(CREATE_RULES.includes(`${MIN_OVERLAP}字`));
  const sys = createSystem(parseCreate(REQ));
  let from = sys.indexOf("この依頼の型: 架空症例の作成");
  assert.ok(from > 0);
  for (const h of CREATE_HEADINGS) {
    const at = sys.indexOf(`## ${h}`, from);
    assert.ok(at >= from, h);
    from = at;
  }
  for (const l of CREATE_INPUT_LABELS) assert.ok(sys.includes(`- ${l}: `), l);
  assert.match(sys, /難しさ「紛らわしい鑑別あり」: 似た所見を示す鑑別が1つあり/);
  assert.match(createSystem(parseCreate({ theme: "a" })), /難しさ「標準」: 典型的な経過/);
  assert.match(createSystem(parseCreate({ theme: "a", level: "複合問題" })), /2つ以上の問題が同時にある/);
  assert.match(sys, /## 落とし穴\n- 見逃しやすい点・思い込みやすい点を1〜2つ/);
  assert.match(createSystem(parseCreate({ theme: "a", pitfall: false })), /## 落とし穴\n- 「なし」と書く/);
  assert.deepEqual(LEVELS.length, 3);
  // the headings the screen reads the case by are the ones the model is told to write
  assert.deepEqual(C.CREATE_HEADINGS, CREATE_HEADINGS);
  assert.deepEqual(C.INPUT_LABELS, CREATE_INPUT_LABELS);
});

test("HTTP: creating a case sends the request (no case) before 【依頼】 and the rules as a second system block; the pinned case is never attached", async () => {
  const api = fakeModel("## 導入文\n\n夕方に受診した。\n");
  const res = await handle(post({ mode: "create", create: REQ, history: [{ role: "user", text: "前の質問" }, { role: "assistant", text: "前の回答" }] }), app({ fetchImpl: api.fetchImpl }));
  assert.equal(res.status, 200);
  const evs = await events(res);
  assert.equal(evs.at(-1).t, "final");
  const r1 = api.calls[0];
  assert.equal(r1.system.length, 2);
  assert.equal(r1.system[0].cache_control.type, "ephemeral");
  assert.ok(!r1.system[0].text.includes("架空症例を作るとき"));
  assert.equal(r1.system[1].text, createSystem(parseCreate(REQ)));
  const last = r1.messages.at(-1).content;
  assert.ok(last.startsWith("【症例作成の依頼】"));
  assert.ok(last.includes("- テーマ: 腎前性AKI") && last.includes("- 難しさ: 紛らわしい鑑別あり"));
  assert.ok(last.endsWith(`【依頼】${MODE_LABELS.create}（腎前性AKI）`));
  assert.ok(!last.includes("【症例（入力）】"));
  assert.deepEqual(r1.messages.slice(0, -1).map((m: any) => m.content), ["前の質問", "前の回答"]);
});

test("HTTP: a creation request that is wrong is refused before the model is called", async () => {
  const api = fakeModel("x");
  const code = async (body: unknown) => ((await (await handle(post(body), app({ fetchImpl: api.fetchImpl }))).json()) as any).code;
  assert.equal(await code({ mode: "create" }), "bad_create");
  assert.equal(await code({ mode: "create", create: { theme: "a", level: "x" } }), "bad_create");
  assert.equal(await code({ mode: "create", create: REQ, case: { complaint: "発熱" } }), "bad_create"); // a creation request takes no case
  assert.equal(api.calls.length, 0); // none of those reached the model
  // without the mode, `create` is just ignored: a plain question
  const plain = await handle(post({ create: REQ, question: "q" }), app({ fetchImpl: api.fetchImpl }));
  assert.equal(plain.status, 200);
  await plain.text();
  assert.equal(api.calls[0].system.length, 1);
});

test("HTTP guard: an identifier-like text in the theme or the wishes is refused (kinds only); an acknowledged one goes through; the cap counts it", async () => {
  for (const field of ["theme", "goal"] as const) {
    const api = fakeModel("x");
    const res = await handle(post({ mode: "create", create: { ...REQ, [field]: "カルテ番号 12345678 の件" } }), app({ fetchImpl: api.fetchImpl }));
    assert.equal(res.status, 400, field);
    const j: any = await res.json();
    assert.equal(j.code, "possible_identifier");
    assert.ok(j.labels.includes("「カルテ番号」の語") && !JSON.stringify(j).includes("12345678"));
    assert.equal(api.calls.length, 0);
  }
  const ok = fakeModel("## 導入文\n\nx\n");
  assert.equal((await handle(post({ mode: "create", ack_identifier: true, create: { ...REQ, goal: "カルテ番号 12345678" } }), app({ fetchImpl: ok.fetchImpl }))).status, 200);
  let n = 0;
  const counter = { increment: async () => ++n };
  const api = fakeModel("## 導入文\n\nx\n");
  await (await handle(post({ mode: "create", create: REQ }), app({ fetchImpl: api.fetchImpl, dailyAskLimit: 5, counter }))).text();
  await handle(post({ mode: "create", create: { theme: "" } }), app({ fetchImpl: api.fetchImpl, dailyAskLimit: 5, counter }));
  assert.equal(n, 1); // a refused request is not counted
});

// ---------------------------------------------------------------------------------- copied text
test("overlap: a run of MIN_OVERLAP letters/digits shared with a source is found, whatever the spacing, brackets or width; shorter overlaps are not", () => {
  const src = [{ text: "架空症候群とは，ゼルニア値が基準の半分以下に低下した状態をいう<sup>1)</sup>．まず経過を聞く．", page_label: "p.10" }, { text: "別の節。急性腎障害では尿量の変化に注意する必要がある。", page_label: "p.30" }];
  // copied with other punctuation, a full-width digit and a line break in the middle
  const copied = "夜に来院した。架空症候群とは、ゼルニア値が基準の半分以下に\n低下した状態を いう（１）。そのあとで別の話をする。";
  const hits = findOverlaps(copied, src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].page, "p.10");
  assert.ok(hits[0].length >= MIN_OVERLAP);
  assert.ok(hits[0].text.startsWith("架空症候群とは") && hits[0].text.includes("低下した状態"), hits[0].text); // the answer's own text, to show where
  // a rewritten sentence sharing only short phrases is not flagged
  assert.deepEqual(findOverlaps("ゼルニア値が低い状態が続き、基準の半分以下になった場合を、この症例では架空症候群と呼ぶことにした。", src), []);
  // exactly one letter short of the minimum
  const short = "架空症候群とはゼルニア値が基準の半分以下に低下した状態をいう".replace(/\s/g, "");
  assert.equal(findOverlaps(short.slice(0, MIN_OVERLAP - 1), src).length, 0);
  assert.equal(findOverlaps(short.slice(0, MIN_OVERLAP), src).length, 1);
  assert.deepEqual(findOverlaps("", src), []);
  assert.deepEqual(findOverlaps(copied, []), []);
});

test("overlap: two separate copied runs are both reported, longest first, and the report is capped", () => {
  const a = "ゼルニア値が基準の半分以下に低下した状態を架空症候群といい、その経過は数日で変わることがある";
  const b = "急性腎障害では尿量の変化に注意する必要があるとされており、造影剤や薬剤の影響も確かめる";
  const hits = findOverlaps(`${b.slice(0, 45)}。まったく別の新しい文を挟む。${a}。`, [{ text: a, page_label: "p.1" }, { text: b, page_label: "p.2" }]);
  assert.equal(hits.length, 2);
  assert.ok(hits[0].length >= hits[1].length);
  assert.deepEqual(hits.map((h) => h.page).sort(), ["p.1", "p.2"]);
  const many = Array.from({ length: 9 }, (_, i) => `固有の長い文章その${i}として書かれた内容は十分に長くなければなりません。`);
  assert.equal(findOverlaps(many.join("別。"), many.map((t, i) => ({ text: t, page_label: `p.${i}` })), { max: 3 }).length, 3);
});

test("a created case: the Worker checks it against the sections it drew on; an original case gets [], a copied sentence is reported; other answers carry no such field", async () => {
  const [p] = await searchParents(db, ["ゼルニア値 基準"]);
  const copied = p.text.replace(/\s+/g, "").slice(0, 90);
  const run = async (answer: string, input: any) => {
    const evs: StreamEvent[] = [];
    await runAsk({ db, apiKey: "k", model: "m", fetchImpl: fakeModel(answer).fetchImpl }, input, (e) => evs.push(e));
    return evs.at(-1) as Extract<StreamEvent, { t: "final" }>;
  };
  const base = { question: "架空症例を作る（x）", caseBlock: renderCreate(parseCreate(REQ)), modeSystem: createSystem(parseCreate(REQ)), checkOverlap: true };
  const original = await run("## 導入文\n\n夕方に来院した七十代の男性。三日前から発熱があり、Cr 2.4 mg/dL と高めだった。\n", base);
  assert.deepEqual(original.overlap, []);
  assert.deepEqual(original.numbers, []); // the example numbers of a fictional case are not claims from a book
  const copiedRun = await run(`## 導入文\n\n${copied}。そのあとで新しい話になった。\n`, base);
  assert.equal(copiedRun.overlap!.length, 1);
  assert.ok(copiedRun.overlap![0].length >= MIN_OVERLAP);
  assert.match(copiedRun.overlap![0].page, /^p\./);
  // a plain question is not checked: no field at all
  const plain = await run(`${copied}`, { question: "架空症候群の定義は？" });
  assert.ok(!("overlap" in plain));
  assert.ok(plain.numbers !== undefined);
});

// ---------------------------------------------------------------------------------- saved with the conversation
test("conversation: the creation request and the overlap result are saved with the turn; identifier-like text in the request is refused", async () => {
  const s = convStore(openRw(), { retentionDays: 30 });
  const id = "conv-create-0001";
  const payload = { kind: "final", blocks: [{ text: "症例", citations: [] }], mode: "create", create: REQ, overlap: [] };
  assert.equal(await s.append(id, { question: `${MODE_LABELS.create}（腎前性AKI）`, answer: "症例", payload }, "2026-10-24T00:00:00Z"), 1);
  const got: any = await s.get(id);
  assert.deepEqual(got.turns[0].payload.create, REQ);
  assert.deepEqual(got.turns[0].payload.overlap, []);
  const s2 = convStore(openRw(), { retentionDays: 30 });
  await assert.rejects(
    s2.append(id, { question: "架空症例を作る", answer: "a", payload: { ...payload, create: { ...REQ, goal: "患者ID 12345" } } }, "2026-10-24T00:00:00Z"),
    (e: any) => e instanceof ConvInputError && e.code === "possible_identifier" && !e.message.includes("12345"),
  );
  assert.deepEqual(await s2.list("2026-10-24T00:00:00Z"), []);
});

// ---------------------------------------------------------------------------------- the screen's reading of a created case
const CREATED = `## 導入文

夕方、救急外来を受診した七十代の男性。三日前から発熱と咳が続いている。 [推論]

## 症例の入力用

- 年齢: 72
- 性別: 男性
- 場面: 救急
- 主訴と経過: 3日前から発熱と咳。
  昨日から尿量が減った。
- バイタル: BP 92/54, HR 108
- 所見・検査: Cr 2.4 mg/dL, K 5.8 mEq/L
- 既往・内服: 高血圧。アムロジピン内服。

## 所見の表（値は例示）

| 項目 | 値 | 根拠 |
|---|---|---|
| Cr | 2.4 mg/dL | 典型的に上昇する | ［書籍 p.10-12］
| K | 5.8 mEq/L | [推論] |

## 見立て（最初は畳む）

- 想定する診断は腎前性AKI。
- 鑑別は急性尿細管壊死。

## 落とし穴

- NSAIDsの内服を聞かないと見誤る。 ［書籍 p.11］

## 教訓

- 内服薬の確認を省かない。

## 書籍に見つからなかった点

- 該当なし
`;

test("reading a created case: the parts by heading, the seven input lines (with a continued line), the table rows, the narrative without marks", () => {
  const p = C.parseCreated(CREATED);
  assert.deepEqual(p.absent, []);
  assert.equal(p.intro, "夕方、救急外来を受診した七十代の男性。三日前から発熱と咳が続いている。");
  assert.deepEqual(p.input, { 年齢: "72", 性別: "男性", 場面: "救急", 主訴と経過: "3日前から発熱と咳。\n昨日から尿量が減った。", バイタル: "BP 92/54, HR 108", "所見・検査": "Cr 2.4 mg/dL, K 5.8 mEq/L", "既往・内服": "高血圧。アムロジピン内服。" });
  assert.deepEqual(p.table.map((r: any) => [r.item, r.value]), [["Cr", "2.4 mg/dL"], ["K", "5.8 mEq/L"]]);
  assert.match(p.table[0].basis, /［書籍 p\.10-12］/); // the page that came from the citation metadata is kept in the basis column
  assert.equal(p.pitfall, "NSAIDsの内服を聞かないと見誤る。");
  assert.equal(p.lesson, "内服薬の確認を省かない。");
  assert.match(p.diagnosis, /想定する診断は腎前性AKI/);
  // a heading that is missing is reported; a heading with numbering or another bracket still matches
  assert.deepEqual(C.parseCreated("## 1. 導入文(短く)\n\nx\n").absent.slice(0, 2), ["症例の入力用", "所見の表"]);
  assert.equal(C.parseCreated("## 1. 導入文(短く)\n\nはじまり\n").intro, "はじまり");
});

test("into case mode: the fields come from the seven lines only; a choice that is not an option is blanked and said; the assessment never goes in", () => {
  const ok = C.toCase(C.parseCreated(CREATED));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.notes, []);
  assert.deepEqual(ok.kase, { age: "72", sex: "男性", setting: "救急", complaint: "3日前から発熱と咳。\n昨日から尿量が減った。", vitals: "BP 92/54, HR 108", findings: "Cr 2.4 mg/dL, K 5.8 mEq/L", history: "高血圧。アムロジピン内服。", own: "", structured: "", intake: null });
  assert.ok(!JSON.stringify(ok.kase).includes("腎前性AKI")); // the assessment (and every other section) stays out
  const odd = C.toCase(C.parseCreated(CREATED.replace("- 年齢: 72", "- 年齢: 70歳代").replace("- 性別: 男性", "- 性別: 不明")));
  assert.equal(odd.kase.age, "");
  assert.equal(odd.kase.sex, "その他・不明");
  assert.deepEqual(odd.notes, ["「年齢」の「70歳代」は 0〜130 の整数ではないため、空欄にしました"]);
  // "72歳" and full-width digits are read as 72; out of range is blanked and said; the age line missing is said
  assert.equal(C.toCase(C.parseCreated(CREATED.replace("- 年齢: 72", "- 年齢: ７２歳"))).kase.age, "72");
  assert.equal(C.toCase(C.parseCreated(CREATED.replace("- 年齢: 72", "- 年齢: 0"))).kase.age, "0");
  assert.equal(C.toCase(C.parseCreated(CREATED.replace("- 年齢: 72", "- 年齢: 131"))).kase.age, "");
  assert.deepEqual(C.toCase(C.parseCreated(CREATED.replace("- 年齢: 72\n", ""))).notes, ["「年齢」がありません"]);
  // a case created before the age became whole years still opens: the old line is read as the age, and the band is kept as it was
  const old = C.toCase(C.parseCreated(CREATED.replace("- 年齢: 72", "- 年代: 70代")));
  assert.equal(old.kase.age, "70代");
  assert.deepEqual(old.notes, []);
  const none = C.toCase(C.parseCreated("## 導入文\n\nだけ\n"));
  assert.equal(none.ok, false);
  assert.ok(none.notes.some((n: string) => /どれもありません/.test(n)));
  // the dialog's own choices and limits still apply
  assert.equal(M.isAgeYears(ok.kase.age), true);
});

test("the Modules draft: valid TOML with the fields of a drill case; [case.answers] is not made; what the doctor must fix is marked; no assessment as a value", () => {
  const parsed = C.parseCreated(CREATED);
  const text = C.toModulesDraft(parsed, { theme: "腎前性AKI", level: "標準", sources: [{ book_id: "bk1", page: "p.10-12" }, { book_id: "bk1", page: "p.10-12" }, { book_id: "bk2", page: "" }] });
  assert.ok(!/^\[case\.(answers|expect)/m.test(text), "no [case.answers] / [case.expect] table");
  assert.match(text, /^\[\[case\]\]$/m);
  assert.match(text, /\[要変更\]/);
  assert.match(text, /\[要変換\]/);
  assert.match(text, /\[要照合: 台帳IDへの置き換えは clinical-modules 側\]/);
  const j = JSON.parse(execFileSync("python3", ["-c", "import tomllib,sys,json; print(json.dumps(tomllib.loads(sys.stdin.read())))"], { input: text, encoding: "utf-8" }));
  const c = j.case[0];
  assert.deepEqual(Object.keys(c).sort(), ["id", "intro", "key", "lesson", "pitfall", "source", "tags", "title"]);
  assert.equal(c.id, "xx-draft");
  assert.match(c.id, /^[a-z]{2,}-[a-z0-9]+(-[a-z0-9]+)*$/); // clinical-modules' id rule
  assert.equal(c.title, "腎前性AKI（標準）");
  assert.deepEqual(c.tags, ["draft"]);
  assert.deepEqual(c.key, []);
  assert.equal(c.intro, "夕方、救急外来を受診した七十代の男性。三日前から発熱と咳が続いている。");
  assert.equal(c.pitfall, "NSAIDsの内服を聞かないと見誤る。"); // the cited-page mark is not carried into the narrative
  assert.match(c.source, /書籍ID: bk1 p\.10-12、bk2\[要照合/);
  // the table and the assessment are comments only, for the doctor to convert
  assert.match(text, /^#   Cr \| 2\.4 mg\/dL \| 典型的に上昇する \| ［書籍 p\.10-12］$/m);
  assert.match(text, /^#   - 想定する診断は腎前性AKI。$/m);
  assert.ok(!c.intro.includes("腎前性")); // the diagnosis is not in the case text
  // quotes, backslashes and a long field survive / are flagged
  const tricky = C.toModulesDraft({ ...parsed, intro: `彼は「痛い」と言った。\\path ${"あ".repeat(601)}` }, { theme: 'a"b', level: "標準", sources: [] });
  const tj = JSON.parse(execFileSync("python3", ["-c", "import tomllib,sys,json; print(json.dumps(tomllib.loads(sys.stdin.read())))"], { input: tricky, encoding: "utf-8" }));
  assert.ok(tj.case[0].intro.startsWith("彼は「痛い」と言った。\\path"));
  assert.equal(tj.case[0].title, 'a"b（標準）');
  assert.match(tricky, /\[要短縮\] intro が \d+ 字です/);
  assert.match(tricky, /書籍ID: （引用なし）/);
});

test("what a fictional case must not contain: doses, thresholds, calendar dates and identifier-like text are found; example lab values are not", () => {
  const fine = C.scanCreated("Cr 2.4 mg/dL, K 5.8 mEq/L, Na 128 mmol/L, Hb 8.5 g/dL, BP 92/54, 体重 60 kg。3日前から発熱。");
  assert.deepEqual(fine, { doses: [], thresholds: [], dates: [], ids: [] });
  const bad = C.scanCreated("ヘパリン 5000 単位 を投与し、10 mg/日 で維持。Cr 2.0 以上で減量。K > 6.0 なら治療。2026年10月24日に受診、10月3日から。令和8年。カルテ番号 12345678。");
  assert.ok(bad.doses.some((d: string) => d.includes("5000")) && bad.doses.some((d: string) => d.includes("10 mg")), JSON.stringify(bad.doses));
  assert.ok(bad.thresholds.some((d: string) => d.includes("2.0 以上")) && bad.thresholds.some((d: string) => d.includes("> 6.0")), JSON.stringify(bad.thresholds));
  assert.ok(bad.dates.length >= 3, JSON.stringify(bad.dates));
  assert.ok(bad.ids.includes("「カルテ番号」の語") && bad.ids.includes("8桁以上の数字の並び"));
  // full-width digits are read as digits; markup left in the text is not a comparison
  assert.ok(C.scanCreated("ヘパリン ５０００ 単位").doses.length === 1);
  assert.deepEqual(C.scanCreated("状態をいう<sup>1)</sup>．重症とする<sup>注1)</sup>．").thresholds, []);
});

// ---------------------------------------------------------------------------------- the course after the admission (docs/enhancement-plan.md 8.20)
test("course: the model is told to write it only when asked, as facts of each day, from the books' typical course, without doses or thresholds, never a later day's fact in an earlier day", () => {
  const none = createSystem(parseCreate({ theme: "腎前性AKI" }));
  assert.ok(!none.includes(COURSE_HEADING) && !none.includes("入院後の経過を作るとき") && !none.includes("### 入院"), "no course asked: the instruction is what it was");
  const sys = createSystem(parseCreate({ theme: "腎前性AKI", days: 3 }));
  assert.ok(sys.includes(COURSE_RULES));
  for (const must of [/実在の患者の経過ではありません/, /典型的な経過/, /search_books で、その病態の経過を確かめます/, /焼き直したりしません/, /年月日は書きません/, /後の日に分かることを、前の日に書きません/, /用量・投与速度・診断基準の閾値は書きません/, /一般名で、「開始した」「中止した」「変更した」までにとどめます/, /「正しい対応」「見立て」「評価」は書きません/, /事実/]) {
    assert.match(COURSE_RULES, must);
  }
  // the heading is between 教訓 and the last one, and each of the days asked for (and no other) is in the form, in order, with the parts
  const at = (t: string, from = 0) => {
    const i = sys.indexOf(t, from);
    assert.ok(i >= from, t);
    return i;
  };
  let from = at("この依頼の型: 架空症例の作成");
  for (const h of ["教訓", COURSE_HEADING]) from = at(`## ${h}`, from);
  for (let n = 1; n <= 3; n++) from = at(`### 入院${n}日目`, from);
  from = at("## 書籍に見つからなかった点", from);
  assert.ok(!sys.includes("### 入院4日目"));
  for (const p of COURSE_PARTS) assert.ok(sys.split(`- ${p}: …`).length === 4, p); // once a day
  assert.equal(sys.split(`- ${COURSE_LAST_PART}: `).length, 2, "the outcome only on the last day");
  assert.ok(at(`- ${COURSE_LAST_PART}: `) > at("### 入院3日目") && at(`- ${COURSE_LAST_PART}: `) < at("## 書籍に見つからなかった点"));
  // the rules about the case itself still hold beside the course (no doses, no dates, the diagnosis only under 見立て)
  assert.match(sys, /診断基準の閾値、薬の用量・投与速度は書きません/);
  // the screen reads the course by the same words
  assert.equal(C.COURSE_HEADING, COURSE_HEADING);
  assert.deepEqual(C.COURSE_PARTS, COURSE_PARTS);
  assert.equal(C.COURSE_LAST_PART, COURSE_LAST_PART);
});

test("course: the request goes through /api/ask like a case request; a count that is not offered is refused; the question is labelled with the days; the answer is checked for copied book text", async () => {
  const ok = fakeModel("## 導入文\n\nx\n");
  const res = await handle(post({ mode: "create", create: { ...REQ, days: 5 } }), app({ fetchImpl: ok.fetchImpl }));
  assert.equal(res.status, 200);
  const evs = await events(res);
  assert.ok(evs.some((e) => e.t === "final" && Array.isArray(e.overlap)), "the copied-text check is made on a course request too");
  const sys2: string = ok.calls[0].system[1].text;
  assert.match(sys2, /## 入院後の経過/);
  assert.match(JSON.stringify(ok.calls[0].messages), /入院後の経過: 入院5日目まで、日ごとに作る/);
  const bad = await handle(post({ mode: "create", create: { ...REQ, days: 4 } }), app({ fetchImpl: ok.fetchImpl }));
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as any).code, "bad_create");
  // the question text (what the saved conversation is titled by) names the days
  const rw = openRw();
  const q = fakeModel("## 導入文\n\nx\n");
  const r2 = await handle(post({ mode: "create", create: { ...REQ, days: 7 } }), app({ fetchImpl: q.fetchImpl, rw: rw as any }));
  await r2.text();
  assert.ok(JSON.stringify(q.calls[0].messages).includes(`${MODE_LABELS.create}（腎前性AKI・入院後7日の経過）`));
  // an identifier in the request is refused before the model, as for a case without a course
  const id = await handle(post({ mode: "create", create: { ...REQ, days: 7, goal: "患者ID 123456" } }), app({ fetchImpl: q.fetchImpl }));
  assert.equal(id.status, 400);
});

test("course: the screen reads the days it was told to expect; a missing day, a missing heading and a stray sub-heading are said, not guessed", () => {
  const body = "## 導入文\n\nx\n\n## 教訓\n\n- y\n\n## 入院後の経過\n\n### 入院1日目\n- できごと: 入院し、補液を始めた\n- 症状: 発熱\n  咳も続く\n- 所見・検査（数値は例示）: Cr 2.4 mg/dL\n- 治療・処置（用量は書かない）: 補液\n### 入院2日目\n- できごと: 改善傾向\n- 転帰: 入院継続\n\n## 書籍に見つからなかった点\n\n- 該当なし\n";
  const p = C.parseCreated(body, { days: 2 });
  assert.deepEqual(p.course.map((d: any) => [d.day, d.heading, d.parts.length]), [[1, "入院1日目", 4], [2, "入院2日目", 2]]);
  assert.equal(p.course[0].parts[1].text, "発熱\n咳も続く", "a following line continues the part");
  assert.equal(p.course[1].parts[1].label, "転帰");
  assert.deepEqual(p.missingDays, []);
  assert.ok(!p.absent.includes(COURSE_HEADING));
  // asking for 3 days and getting 2 says so; asking for none reads no course (the section is still the answer's)
  assert.deepEqual(C.parseCreated(body, { days: 3 }).missingDays, [3]);
  assert.deepEqual(C.parseCreated(body).course, []);
  assert.deepEqual(C.parseCreated(body).absent.includes(COURSE_HEADING), false);
  // no course heading when days were asked for: it is absent
  assert.ok(C.parseCreated("## 導入文\n\nx", { days: 3 }).absent.includes(COURSE_HEADING));
  // a `###` line stays in the section it is in: the day headings do not end the course, and do not start a section
  const sec = C.splitSections(body);
  assert.ok(sec[COURSE_HEADING].includes("### 入院2日目"));
  assert.ok(!("入院1日目" in sec));
  // a day heading with a different shape is not a day
  assert.deepEqual(C.readCourse("### 第1病日\n- できごと: x\n### 入院 3 日目\n- 症状: y"), [{ day: 3, heading: "入院3日目", parts: [{ label: "症状", text: "y" }] }]);
  // what a fictional case must not hold is found in the course too: a dose, a threshold, a date, an identifier-like number
  const found = C.scanCreated(`${body}\n### 入院3日目\n- 治療・処置: ヘパリンを 5000 単位 で開始し、Cr 2.0 以上で減量。2026年10月3日。検体番号 12345678`);
  assert.ok(found.doses.length && found.thresholds.length && found.dates.length && found.ids.length);
});

// ---------------------------------------------------------------------------------- the lists are the Worker's; the screen code sends and keeps nothing
test("web twins: levels, limits, setting list, the copied-text minimum and the creation label equal the Worker's", () => {
  assert.deepEqual(M.LEVELS, [...LEVELS]);
  assert.deepEqual(M.CREATE_LIMITS, CREATE_LIMITS);
  assert.deepEqual(M.COURSE_DAYS, [...COURSE_DAYS]);
  assert.equal(C.MIN_OVERLAP, MIN_OVERLAP);
  assert.deepEqual(M.SETTINGS, [...SETTINGS]);
  assert.deepEqual(M.cleanCreate({ theme: "a", level: "x", setting: "ICU", goal: 5, pitfall: "no", extra: 1 }), M.emptyCreate().theme === "" ? { theme: "a", setting: "", level: "標準", goal: "", pitfall: true, days: 0 } : null);
  assert.deepEqual(M.createRows(parseCreate(REQ)).map((r: string[]) => r[0]), ["テーマ", "場面", "難しさ", "学ばせたいこと", "落とし穴"]);
  // the days are read back from a saved conversation only if they are one of the offered counts
  assert.equal(M.cleanCreate({ theme: "a", days: 7 }).days, 7);
  for (const bad of [4, "7", null, -1, 99, true]) assert.equal(M.cleanCreate({ theme: "a", days: bad }).days, 0, JSON.stringify(bad));
  assert.deepEqual(M.createRows(parseCreate({ ...REQ, days: 7 })).at(-1), ["入院後の経過", "入院7日目まで、日ごとに作る"]);
});

test("pins: the reading of a created case and its screen never send, save, export, print or share; the copy goes through the app's helper", () => {
  const forbidden = /\bfetch\s*\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|indexedDB|\bprint\s*\(|navigator\.share|createObjectURL|new Blob|\bdownload\b|window\.open|navigator\.clipboard|innerHTML|\beval\s*\(|new Function/;
  for (const f of ["case-create.js", "create-ui.js"]) assert.doesNotMatch(readFileSync(web(f), "utf-8").replace(/\/\/.*$/gm, ""), forbidden, f);
  const imports = (f: string) => [...readFileSync(web(f), "utf-8").matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports("case-create.js"), ["./case-model.js", "./id-guard.js"]);
  assert.deepEqual(imports("create-ui.js"), ["./case-create.js", "./case-model.js"]);
  assert.match(readFileSync(web("app.js"), "utf-8"), /initCreate\(\{ el, \$, openDialog, copyText,/);
});
