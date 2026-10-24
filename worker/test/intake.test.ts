// Structured intake from clinical-modules' flow questions (docs/clinical-use.md 1e): web/intake.js, web/date-relative.js and the imported
// web/flow-schema.js.  The properties pinned here are the ones the doctor's decisions rest on: a blank is never an answer and never a
// negative; a date never survives as a calendar date; only the question structure is imported (no rule, no differential).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO } from "./nodeDb.ts";

const web = (f: string) => join(REPO, "web", f);
const R: any = await import(web("date-relative.js"));
const I: any = await import(web("intake.js"));
const S: any = await import(web("flow-schema.js"));

// Japan time 2026-10-24 12:00 (the day the decisions were made)
const NOW = new Date("2026-10-24T03:00:00Z");
const rel = (text: string, now = NOW) => R.relativizeDates(text, { now }).text;

// ---------------------------------------------------------------------------------- dates become relative
test("dates: with an admission date, dates become 'N日前' / '入院N日目'; the admission day is day 1; ratios and blood pressures are not dates", () => {
  assert.equal(rel("10/20に入院、10/22に発熱。血圧 120/80、2/3が狭窄"), "4日前に入院、入院3日目に発熱。血圧 120/80、2/3が狭窄");
  assert.equal(rel("2026年10月20日入院。2026/10/22 22:10 に胸痛"), "4日前に入院。入院3日目 22:10 に胸痛");
  assert.equal(rel("入院日: 10/20。10/24 朝から嘔気"), "入院日: 4日前。入院5日目 朝から嘔気");
  assert.equal(rel("10/20入院。10/18から咳"), "4日前に入院。入院の2日前から咳");
  assert.equal(rel("令和8年10月20日に入院"), "4日前に入院");
});

test("dates: without an admission date they count back from today; a planned date counts forward; a far-future one without a year is last year's", () => {
  assert.equal(rel("10/22に発熱"), "2日前に発熱");
  assert.equal(rel("10月22日から咳"), "2日前から咳");
  assert.equal(rel("10/24に受診"), "今日に受診");
  assert.equal(rel("11/2に手術予定"), "9日後に手術予定");
  assert.equal(rel("12/25に発熱"), "約10か月前に発熱"); // Dec 25 of last year: it is 10/24 now
  assert.equal(rel("2024/10/24 に診断"), "約2年前 に診断");
  assert.equal(rel("2025年10月24日に診断"), "約12か月前に診断");
});

test("dates: the day is counted in Japan time", () => {
  assert.equal(rel("10/23に発熱", new Date("2026-10-23T16:00:00Z")), "1日前に発熱"); // 10/24 01:00 in Japan
  assert.equal(rel("10/23に発熱", new Date("2026-10-24T14:59:00Z")), "1日前に発熱"); // 10/24 23:59
  assert.equal(rel("10/23に発熱", new Date("2026-10-24T15:00:00Z")), "2日前に発熱"); // 10/25 00:00
});

test("dates: what is not a calendar date with a day is left as it is", () => {
  for (const t of [
    "KDIGO 2012 と 2021年10月改訂",
    "血圧 120/80、脈 72",
    "2/3が狭窄、1/2に減量",
    "3/4から1/2に低下",
    "22:10 に胸痛、BT 38.4℃",
    "2月30日に発熱", // not a real date
    "13月5日に発熱",
    "Cr 2.4 mg/dL（ふだんは 0.9）",
    "1.5 L の輸液",
  ]) assert.equal(rel(t), t, t);
  assert.deepEqual(R.relativizeDates("", { now: NOW }), { text: "", changes: [] });
  assert.deepEqual(R.relativizeDates(undefined, { now: NOW }), { text: "", changes: [] });
});

test("dates: the result keeps no calendar date, and converting it again changes nothing", () => {
  const samples = ["10/20に入院、10/22に発熱。血圧 120/80", "2026年10月20日入院。2026/10/22 22:10 に胸痛", "令和8年10月20日に入院、10月24日に退院予定", "入院日: 10/20。10/21 から腹痛、10/24 朝に受診"];
  for (const t of samples) {
    const once = R.relativizeDates(t, { now: NOW });
    assert.ok(!/\d{1,2}\/\d{1,2}(?!\d)|\d{4}[年/]|\d{1,2}月\d{1,2}日|令和|平成/.test(once.text.replace(/120\/80/, "")), once.text);
    assert.equal(rel(once.text), once.text, "idempotent");
    assert.ok(once.changes.length > 0 && once.changes.every((c: any) => c.from && c.to));
  }
});

// ---------------------------------------------------------------------------------- conditions
test("conditions: q=a,b  q?  !  &  |  ( )  always  $name — an unknown name or a broken condition is false, never a throw", () => {
  const ctx = { a: "x", m: ["p", "q"], n: 5, e: "", z: [] };
  const defs = { d1: "a=x & m=q", d2: "$d1 | a=y", loop: "$loop" };
  const t = (src: string) => I.compileWhen(src)(ctx, defs);
  assert.equal(t("a=x"), true);
  assert.equal(t("a=y,x"), true);
  assert.equal(t("a=y"), false);
  assert.equal(t("m=q"), true); // a multi answer matches when any selected option does
  assert.equal(t("m=r"), false);
  assert.equal(t("a?"), true);
  assert.equal(t("n?"), true);
  assert.equal(t("e?"), false); // an empty text is no answer
  assert.equal(t("z?"), false);
  assert.equal(t("missing?"), false);
  assert.equal(t("!a=y"), true);
  assert.equal(t("a=x & !m=r"), true);
  assert.equal(t("a=y | m=p"), true);
  assert.equal(t("(a=y | m=p) & n?"), true);
  assert.equal(t("a=y | m=r & n?"), false); // & binds tighter than |
  assert.equal(t("always"), true);
  assert.equal(t("$d1"), true);
  assert.equal(t("$d2"), true);
  assert.equal(t("$nowhere"), false);
  assert.equal(t(""), false);
  assert.equal(t("a=x &"), false);
  assert.equal(t("((("), false);
  assert.equal(I.compileWhen(undefined)(ctx, defs), false);
  // a number is compared as an answer only by `?`, never as an option
  assert.equal(t("n=5"), false);
});

test("isAnswered: only a real answer counts; empty, blank and NaN do not", () => {
  for (const v of ["x", 0, 36.5, ["a"]]) assert.equal(I.isAnswered(v), true, String(v));
  for (const v of [undefined, null, "", "  ", [], Number.NaN, {}]) assert.equal(I.isAnswered(v), false, String(v));
});

// ---------------------------------------------------------------------------------- a small synthetic flow
const FLOW: any = {
  id: "demo.demo",
  title: "架空の場面 × 架空の症候",
  phases: [
    { id: "p1", name: "受け入れ", short: "受け入れ", slots: [1] },
    { id: "p2", name: "病歴", short: "病歴", slots: [2] },
  ],
  defs: { any_unable: "onset=unable | site=unable" },
  questions: [
    { id: "age", slot: 1, label: "年齢", type: "number", core: true },
    { id: "sex", slot: 1, label: "性別", type: "choice", options: [{ id: "m", label: "男性" }, { id: "f", label: "女性" }] },
    { id: "first", slot: 1, label: "第一印象", type: "choice", core: true, options: [{ id: "ok", label: "安定" }, { id: "bad", label: "不安定", short: "不安定" }] },
    { id: "onset", slot: 2, label: "★1 発症様式（わかる範囲）", type: "choice", core: true, line: "発症様式：{value}", options: [{ id: "sudden", label: "突然", short: "突然発症" }, { id: "gradual", label: "徐々に" }, { id: "unable", label: "評価不能" }] },
    { id: "site", slot: 2, label: "部位", type: "choice", options: [{ id: "a", label: "上" }, { id: "unable", label: "評価不能" }] },
    { id: "assoc", slot: 2, label: "随伴症状", type: "multi", exclusive: ["none"], options: [{ id: "fever", label: "発熱" }, { id: "nausea", label: "嘔気" }, { id: "none", label: "なし" }] },
    { id: "preg", slot: 2, label: "妊娠の可能性（女性）", type: "choice", core: true, when: "sex=f", options: [{ id: "yes", label: "あり" }, { id: "no", label: "なし" }] },
    { id: "why", slot: 2, label: "評価できない理由", type: "text", core: true, when: "$any_unable" },
    { id: "t_onset", slot: 2, label: "発症時刻", type: "time" },
    { id: "temp", slot: 2, label: "体温", type: "number", unit: "℃" },
    { id: "memo", slot: 2, label: "経過メモ", type: "text" },
  ],
};

test("core questions: the visible, unanswered ones are listed in the flow's order; age and sex are the case's own and never asked", () => {
  const miss = (a: object, k: object = {}) => I.coreMissing(FLOW, a, k).map((m: any) => m.id);
  assert.deepEqual(miss({}), ["first", "onset"]); // `age` is the case's age band; `preg` needs sex=f; `why` needs an unable
  assert.deepEqual(miss({ first: "ok" }), ["onset"]);
  assert.deepEqual(miss({}, { sex: "女性" }), ["first", "onset", "preg"]); // the sex comes from the case's own select
  assert.deepEqual(miss({}, { sex: "男性" }), ["first", "onset"]);
  assert.deepEqual(miss({ first: "ok", onset: "unable" }), ["why"]); // an unable answer makes its reason a core question
  assert.deepEqual(miss({ first: "ok", onset: "sudden" }), []);
  assert.deepEqual(I.coreCount(FLOW, { first: "ok" }, { sex: "女性" }), { all: 3, done: 1 });
  const m = I.coreMissing(FLOW, {}, {});
  assert.deepEqual(m[1], { id: "onset", label: "発症様式（わかる範囲）", phase: "病歴" }); // the ★n marker is not shown
});

test("a blank is never an answer: an unanswered question never reads as 'none', 'normal' or 'negative' in the text", () => {
  const a = I.setAnswer(FLOW, {}, "assoc", ["none"]); // "none" was chosen: that one is an answer
  const text = I.renderStructured(FLOW, a, {}, { now: NOW });
  assert.match(text, /随伴症状：なし/);
  // nothing chosen in the same question: it does not appear at all, and it is listed as unanswered only if it is core
  const only = I.renderStructured(FLOW, { first: "ok" }, {}, { now: NOW });
  assert.ok(!only.includes("随伴症状"));
  assert.ok(!/(異常なし|陰性|正常|なし)/.test(only.split("\n").filter((l: string) => !l.startsWith("場面・症候:") && !l.startsWith("未入力の中核項目")).join("\n")));
  assert.equal(I.renderStructured(FLOW, {}, {}, { now: NOW }), ""); // nothing answered, nothing sent
  assert.equal(I.renderStructured(FLOW, { memo: "   " }, {}, { now: NOW }), "");
});

test("render: the flow, then answers by phase in the flow's own words, then the core questions still open (as 未確認, not negative)", () => {
  const a = { first: "bad", onset: "sudden", assoc: ["fever", "nausea"], temp: 38.4, t_onset: "22:10", memo: "10/22 から咳" };
  const text = I.renderStructured(FLOW, a, {}, { now: NOW });
  assert.equal(
    text,
    [
      "場面・症候: 架空の場面 × 架空の症候（clinical-modules のフローの質問への答え。未入力の項目は未確認で、陰性ではありません）",
      "［受け入れ］",
      "第一印象：不安定",
      "［病歴］",
      "発症様式：突然発症", // `line` with the option's short form
      "随伴症状：発熱、嘔気",
      "発症時刻：22:10",
      "体温：38.4 ℃", // recorded, never judged
      "経過メモ：2日前 から咳", // a date in a text answer is made relative
    ].join("\n"),
  );
  const open = I.renderStructured(FLOW, { first: "ok" }, { sex: "女性" }, { now: NOW });
  assert.match(open, /未入力の中核項目（2件。未確認）: 発症様式、妊娠の可能性/); // the bracketed explanation is cut in the list
  assert.ok(!open.includes("評価できない理由")); // not visible, so not asked
});

test("render: an answer to a question that is no longer visible is not shown (the answer is kept, the condition decides)", () => {
  const a = { first: "ok", sex: "f", preg: "yes" };
  assert.match(I.renderStructured(FLOW, a, { sex: "女性" }, { now: NOW }), /妊娠の可能性（女性）：あり/);
  assert.ok(!I.renderStructured(FLOW, a, { sex: "男性" }, { now: NOW }).includes("妊娠の可能性")); // the case's sex says male: sex=f is false
});

test("render: an over-long text is cut at the limit", () => {
  const text = I.renderStructured(FLOW, { memo: "あ".repeat(10000) }, {}, { now: NOW });
  assert.equal(text.length, I.STRUCTURED_LIMIT);
  assert.ok(text.endsWith("…"));
});

test("setAnswer: 'none' in a multi question clears the others and the others clear 'none'; an empty value removes the answer; the input is not changed", () => {
  const base = Object.freeze({ first: "ok" });
  let a = I.setAnswer(FLOW, base, "assoc", ["fever", "nausea"]);
  assert.deepEqual(a.assoc, ["fever", "nausea"]);
  a = I.setAnswer(FLOW, a, "assoc", ["fever", "nausea", "none"]);
  assert.deepEqual(a.assoc, ["none"]);
  a = I.setAnswer(FLOW, a, "assoc", ["none", "fever"]);
  assert.deepEqual(a.assoc, ["fever"]);
  a = I.setAnswer(FLOW, a, "assoc", ["bogus"]); // an option the question does not have
  assert.ok(!("assoc" in a));
  a = I.setAnswer(FLOW, a, "temp", 37.2);
  assert.equal(a.temp, 37.2);
  a = I.setAnswer(FLOW, a, "temp", "");
  assert.ok(!("temp" in a));
  assert.deepEqual(base, { first: "ok" });
  assert.deepEqual(I.setAnswer(FLOW, { x: 1 }, "nowhere", "y"), { x: 1 }); // an unknown question is not added
});

test("cleanAnswers: only the flow's own questions with values they accept; the rest is counted as dropped", () => {
  const raw = { first: "ok", onset: "nonsense", assoc: ["fever", "zzz", "none"], temp: 38.5, t_onset: "22:10", memo: "  メモ  ", age: 70, sex: "f", nowhere: "x", site: 3, preg: ["yes"], why: "あ".repeat(900) };
  const { answers, dropped } = I.cleanAnswers(FLOW, raw);
  assert.deepEqual(Object.keys(answers).sort(), ["assoc", "first", "memo", "temp", "t_onset", "why"].sort());
  assert.deepEqual(answers.assoc, ["none"]); // the exclusive option wins as it does on the screen
  assert.equal(answers.memo, "メモ");
  assert.equal(answers.why.length, 600);
  assert.equal(dropped, 6); // onset, age, sex, nowhere, site, preg
  for (const bad of [null, undefined, "x", 5, [], [1]]) assert.deepEqual(I.cleanAnswers(FLOW, bad), { answers: {}, dropped: 0 });
  assert.deepEqual(I.cleanAnswers(FLOW, { t_onset: "9:5" }), { answers: {}, dropped: 1 });
});

test("flowChoices: the flows grouped by scene", () => {
  const g = I.flowChoices({ a: { id: "a", title: "救急外来 × 胸痛" }, b: { id: "b", title: "救急外来 × 腹痛" }, c: { id: "c", title: "外来初診 × 発熱" } });
  assert.deepEqual(g, [
    { scene: "救急外来", flows: [{ id: "a", title: "救急外来 × 胸痛" }, { id: "b", title: "救急外来 × 腹痛" }] },
    { scene: "外来初診", flows: [{ id: "c", title: "外来初診 × 発熱" }] },
  ]);
});

// ---------------------------------------------------------------------------------- the imported schema itself
test("flow-schema.js: 13 flows; every question and condition is self-consistent; only the question structure is imported", () => {
  const flows = Object.values<any>(S.FLOWS);
  assert.ok(flows.length >= 13);
  assert.equal(S.FLOW_SCHEMA_SOURCE.repository, "clinical-modules");
  assert.match(S.FLOW_SCHEMA_SOURCE.commit, /^[0-9a-f]{7,40}$/);
  assert.equal(S.FLOW_SCHEMA_SOURCE.flows, flows.length);
  for (const f of flows) {
    const ids = new Set<string>(f.questions.map((q: any) => q.id));
    assert.equal(ids.size, f.questions.length, `${f.id}: duplicate ids`);
    const slots = new Set(f.phases.flatMap((p: any) => p.slots));
    const names = (expr: string) => [...String(expr).matchAll(/(\$)?([A-Za-z0-9_]+)(\?|=[A-Za-z0-9_,]+)?/g)].filter((m) => m[2] !== "always");
    for (const q of f.questions) {
      assert.ok(slots.has(q.slot), `${f.id}.${q.id}: its frame is in no phase`);
      if (q.type === "choice" || q.type === "multi") {
        assert.ok(q.options?.length, `${f.id}.${q.id}: no options`);
        assert.equal(new Set(q.options.map((o: any) => o.id)).size, q.options.length, `${f.id}.${q.id}: duplicate option ids`);
      }
      for (const x of q.exclusive ?? []) assert.ok(q.options.some((o: any) => o.id === x), `${f.id}.${q.id}: exclusive ${x} is not an option`);
      if (q.when) for (const [, dollar, name] of names(q.when)) assert.ok(dollar ? name in (f.defs ?? {}) : ids.has(name), `${f.id}.${q.id}: when uses ${name}`);
      assert.doesNotThrow(() => I.compileWhen(q.when ?? "always")({}, f.defs));
    }
    for (const [name, expr] of Object.entries<string>(f.defs ?? {})) for (const [, dollar, n] of names(expr)) assert.ok(dollar ? n in f.defs : ids.has(n), `${f.id}.$${name} uses ${n}`);
  }
  // no judgement came across: the file holds no rule, differential, axis or help text
  const text = readFileSync(web("flow-schema.js"), "utf-8");
  for (const banned of ["[[rule]]", "[[ddx]]", "[[axis]]", "ddx_slot", '"help"', '"hint"', '"strength"', '"critical"']) assert.ok(!text.includes(banned), banned);
});

test("flow-schema.js: an empty intake of every flow lists its core questions; answering all of them leaves none; the case's sex gates the sex-specific ones", () => {
  for (const f of Object.values<any>(S.FLOWS)) {
    const { all } = I.coreCount(f, {}, {});
    assert.ok(all >= 20, `${f.id}: ${all} core questions`);
    assert.equal(I.coreMissing(f, {}, {}).length, all);
    // answer every visible core question (the first option / a number / a text) until nothing is left open
    let a: Record<string, unknown> = {};
    for (let round = 0; round < 6 && I.coreMissing(f, a, {}).length; round++) {
      for (const m of I.coreMissing(f, a, {})) {
        const q = f.questions.find((x: any) => x.id === m.id);
        const v = q.type === "choice" ? q.options[0].id : q.type === "multi" ? [q.options[0].id] : q.type === "number" ? 1 : q.type === "time" ? "10:00" : "メモ";
        a = I.setAnswer(f, a, q.id, v);
      }
    }
    assert.deepEqual(I.coreMissing(f, a, {}), [], f.id);
    const text = I.renderStructured(f, a, {}, { now: NOW });
    assert.ok(text.startsWith(`場面・症候: ${f.title}`) && !text.includes("未入力の中核項目"), f.id);
    assert.ok(text.length <= I.STRUCTURED_LIMIT);
  }
  const ap = S.FLOWS["emergency-department.abdominal-pain"];
  const sexGated = I.coreCount(ap, {}, { sex: "女性" }).all - I.coreCount(ap, {}, { sex: "男性" }).all;
  assert.ok(sexGated >= 1, "a question that is only for women is asked only when the case says female");
});
