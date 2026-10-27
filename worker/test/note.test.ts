// Chart-note draft (docs/enhancement-plan.md 7.3): the assembly rules (web/note-assemble.js), the imported types
// (web/note-types.js) and the pins that keep the screen's code from sending, saving, exporting or sharing anything.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MODE_HEADINGS, OWN_SECTION_ASSESS } from "../src/prompt.ts";
import { REPO } from "./nodeDb.ts";

const web = (f: string) => join(REPO, "web", f);
const A: any = await import(web("note-assemble.js"));
const T: any = await import(web("note-types.js"));

const KASE = { age: "72", sex: "男性", setting: "救急", complaint: "3日前から発熱と咳。", vitals: "BP 92/54, HR 108", findings: "Cr 2.4 mg/dL, K 5.8 mEq/L", history: "高血圧。アムロジピン内服。", own: "腎前性AKIを第一に考える。" };
const item = (role: string, text: string, cites: any[] = []) => ({ role, heading: "h", text, cites });
const BOOK = { kind: "book", title: "架空内科ハンドブック ［照合未完］", page: "p.10-12" };

// ---------------------------------------------------------------------------------- the imported types
test("types: the seven offered types are imported with their fields in order; only names and order came across", () => {
  assert.deepEqual(A.ENABLED, ["A04", "A01", "A05", "A06", "A08", "B02", "B06"]);
  for (const id of A.ENABLED) {
    const t = T.NOTE_TYPES[id];
    assert.ok(t, id);
    assert.ok(t.sections.length >= 4, id);
    for (const s of t.sections) {
      assert.deepEqual(Object.keys(s).filter((k) => !["key", "label", "requirement", "variant"].includes(k)), [], `${id}.${s.key}`);
      assert.ok(["required", "conditional"].includes(s.requirement));
    }
  }
  assert.deepEqual(T.NOTE_TYPES.A04.sections.map((s: any) => s.key), ["arrival", "hpi", "background", "initial", "exam", "tests", "assessment", "management", "reassessment", "disposition"]);
  assert.equal(T.NOTE_TYPES.A04.title, "救急外来初療");
  assert.equal(T.NOTE_TYPES_SOURCE.repository, "clinical-modules");
  assert.match(T.NOTE_TYPES_SOURCE.commit, /^[0-9a-f]{7,40}$/); // the version the types were read from is recorded
  assert.equal(T.NOTE_TYPES_SOURCE.count, Object.keys(T.NOTE_TYPES).length);
  assert.ok(!readFileSync(web("note-types.js"), "utf-8").includes('"sources"'), "the training renderer's `sources` are not imported");
});

test("fill map: every field it names exists in the imported type, and each draft role is written once per type", () => {
  const sources = new Set(["ctx", "complaint", "vitals", "findings", "structured", "history", "own", ...Object.keys(A.ROLES).map((r) => `d:${r}`), ...["route", "summary", "baseline", "general", "outlook", "list", "ap"].map((b) => `b:${b}`)]);
  for (const [id, fields] of Object.entries<any>(A.FILL)) {
    const keys = new Set(T.NOTE_TYPES[id].sections.map((s: any) => s.key));
    const seen = new Map<string, string>();
    for (const [field, parts] of Object.entries<string[]>(fields)) {
      assert.ok(keys.has(field), `${id}.${field} is not a field of the type`);
      for (const p of parts) {
        assert.ok(sources.has(p), `${id}.${field}: unknown source ${p}`);
        if (p.startsWith("d:")) {
          assert.ok(!seen.has(p), `${id}: ${p} is written in both ${seen.get(p)} and ${field}`); // an item never appears twice
          seen.set(p, field);
        }
      }
    }
  }
  for (const k of Object.keys(A.FIELD_NOTES)) {
    const [id, field] = k.split(".");
    assert.ok(T.NOTE_TYPES[id].sections.some((s: any) => s.key === field), k);
  }
});

test("a plan item is a proposal: it is labelled so, and no type puts a draft item in a field for what was already done", () => {
  assert.match(A.ROLES.plan.label, /実施の記録ではありません/);
  for (const id of A.ENABLED) {
    for (const [field, parts] of Object.entries<string[]>(A.FILL[id] ?? {})) {
      if (!parts.some((p) => p.startsWith("d:"))) continue;
      const s = T.NOTE_TYPES[id].sections.find((x: any) => x.key === field);
      assert.doesNotMatch(s.label, /実施済み|実施した|処置の結果/, `${id}.${field} (${s.label})`);
    }
  }
  // the consult request keeps its "実施済み評価・治療" field free of the draft's plan
  const note = A.assemble("B02", { kase: KASE, items: [item("plan", "輸液を検討する")] });
  assert.ok(!note.sections.some((s: any) => s.key === "management" && !s.empty));
  assert.equal(note.unplaced, 1);
});

// ---------------------------------------------------------------------------------- assembly
test("assemble: the case goes into its fields in the type's order; a required field with nothing says （未入力）, a conditional one is left out", () => {
  const note = A.assemble("A04", { kase: KASE });
  assert.deepEqual(note.sections.map((s: any) => s.key), ["arrival", "hpi", "background", "initial", "exam", "assessment", "disposition"]);
  assert.deepEqual(note.omitted, ["tests", "management", "reassessment"]);
  assert.deepEqual(note.unfilled, ["disposition"]);
  const text = A.toText(note);
  assert.match(text, /■来院情報\n72歳・男性・救急/);
  assert.match(text, /■現病歴\n3日前から発熱と咳。/);
  assert.match(text, /■初期評価・ABCDE\nBP 92\/54, HR 108/);
  assert.match(text, /■身体診察\n［身体所見・検査・画像・心電図］\nCr 2\.4 mg\/dL, K 5\.8 mEq\/L/);
  assert.match(text, /■帰宅・入院・転院と根拠\n（未入力）/);
  assert.ok(!text.includes("■検査所見") && !text.includes("■治療・処置・コンサルト"));
  // the order is the type's, whatever order the sources were given in
  const order = [...text.matchAll(/^■(.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(order, ["来院情報", "現病歴", "患者背景", "初期評価・ABCDE", "身体診察", "重症度・第一仮説・鑑別", "帰宅・入院・転院と根拠"]);
});

test("assemble: nothing typed -> only the required fields, all （未入力）; no prose is made up", () => {
  const note = A.assemble("A01", { kase: {} });
  const required = T.NOTE_TYPES.A01.sections.filter((s: any) => s.requirement === "required").map((s: any) => s.key);
  assert.deepEqual(note.sections.map((s: any) => s.key), required);
  assert.ok(note.sections.every((s: any) => s.empty));
  const lines = A.toText(note).split("\n").filter((l: string) => l && !l.startsWith("■"));
  assert.deepEqual(lines.filter((l: string) => l !== A.UNFILLED), [`【外来初診】下書き`, A.BLANK_HEADER]);
});

test("date, patient ID and name are blank placeholders; no digits or names are added by the assembly", () => {
  assert.equal(A.BLANK_HEADER, "［日付］　［患者ID］　［氏名］");
  const text = A.toText(A.assemble("A05", { kase: {} }));
  assert.ok(text.split("\n")[1] === A.BLANK_HEADER);
  assert.doesNotMatch(text, /[0-9０-９]/); // no digit anywhere: the assembly adds no date, ID or number of its own
});

// ---------------------------------------------------------------------------------- the flow's answers in A04 (docs/enhancement-plan.md 8.18)
// question -> its `cat` (clinical-modules' bridge declaration) -> ROUTES (clinical-modules' note_expanded.ROUTES) -> a field of the type.
const S: any = await import(web("flow-schema.js"));
const I: any = await import(web("intake.js"));
const R: any = await import(web("note-route.js"));
const FLOW = S.FLOWS["emergency-department.syncope"];
const ANSWERS = { first: "sick", t_arrival: "21:40", ems_state: "worse", spo2: 96, o2: "room", rr: 18, spo2_cat: "ok", resp: "normal", glu: 110, glu_cat: "ok", re_change: "worse", posture: "stand", pmh: ["htn"], dispo: "home", prep: ["monitor"] };
/** The typed case with the flow's answers as the screen keeps them: `structured` (what is sent) and `intake` (the answers). */
const withFlow = (base: any = KASE, answers: any = ANSWERS, flow: any = FLOW) => {
  const k: any = { ...base, intake: { flow: flow.id, answers } };
  k.structured = I.renderStructured(flow, answers, k);
  return k;
};
/** The answered, visible questions' lines in the flow's order, straight from the question list (not through the routing). */
const askedLines = (flow: any, answers: any, kase: any = {}) => {
  const ctx = I.contextOf(answers, kase);
  return I.byPhase(flow).flatMap(({ questions }: any) => questions.filter((q: any) => I.isVisible(flow, q, ctx) && I.isAnswered(answers[q.id])).map((q: any) => I.lineText(q, answers[q.id])));
};
/** Outpatient first visit (A01): the same idea, for its flow and its fields. */
const OP_FLOW = S.FLOWS["outpatient-first-visit.fever"];
const OP_ANSWERS = { cc_text: "発熱と咳", referral: "none", first: "sick", temp: 38.6, duration: "acute", pmh_text: "高血圧", allergy: "なし", meds: ["abx_recent"], host: ["dm"], living: "alone", exam_head: ["pharynx_red"], labs: ["neutropenia"], problem_line: "急性の発熱", antipyretic_tx: "acetaminophen", tests_done: ["cbc"] };
const textLines = (t: string) => t.split("\n").filter((l) => l.trim() && !/^【.*】$/.test(l) && !/^［.*］$/.test(l));
const sorted = (a: string[]) => [...a].sort();
const ROUTED_INITIAL = ["第一印象：sick", "呼吸数：18 回/分", "SpO2：96 %", "酸素条件：室内気", "SpO2の評価：SpO2は問題なし", "呼吸の評価：問題なし", "血糖：110 mg/dL", "血糖の評価：低血糖なし"];

test("A04: each answer goes to the field ROUTES gives its question's category; the findings and every other field stay as they were", () => {
  const note = A.assemble("A04", { kase: withFlow(), flow: FLOW });
  const field = (k: string) => note.sections.find((s: any) => s.key === k);
  assert.deepEqual(field("exam").blocks.map((b: any) => b.source), ["findings"]); // the physical-exam field is not where the answers go
  assert.deepEqual(field("initial").blocks.map((b: any) => b.source), ["vitals", "routed"]);
  assert.equal(field("initial").blocks[1].text, ROUTED_INITIAL.join("\n")); // the first impression is O: the initial assessment (doctor's decision 2026-10-25)
  assert.equal(field("reassessment").blocks[0].text, "経過：悪化"); // a conditional field with something in it appears
  // the pre-arrival information is S (history of the present illness); the history that is not about the complaint is the past history
  assert.deepEqual(field("hpi").blocks.map((b: any) => b.source), ["complaint", "routed"]);
  assert.equal(field("hpi").blocks[1].text, "救急隊の事前情報：バイタルは不安定・悪化\n発症時の体位：立位");
  assert.deepEqual(field("background").blocks.map((b: any) => b.source), ["history", "routed"]);
  assert.equal(field("background").blocks[1].text, "既往：高血圧");
  // all other fields are exactly as without the flow's answers, and what was typed in hpi / background comes first, unchanged
  const plain = A.assemble("A04", { kase: KASE });
  for (const k of ["arrival", "exam", "assessment"]) assert.deepEqual(field(k), plain.sections.find((s: any) => s.key === k), k);
  // the disposition is the doctor's decision (ent decision, cat disposition: clinical-modules 2026-10-26, D11 b): it goes to the disposition field
  assert.deepEqual(field("disposition").blocks.map((b: any) => [b.source, b.text]), [["routed", "Disposition：帰宅"]]);
  for (const k of ["hpi", "background"]) assert.deepEqual(field(k).blocks[0], plain.sections.find((s: any) => s.key === k).blocks[0], k);
  assert.deepEqual(note.sections.map((s: any) => s.key), ["arrival", "hpi", "background", "initial", "exam", "assessment", "reassessment", "disposition"]);
  const text = A.toText(note);
  assert.match(text, /■初期評価・ABCDE\n\［バイタル\］\nBP 92\/54, HR 108\n［場面・症候の入力（フローの質問への答え）］\n第一印象：sick\n呼吸数：18 回\/分\nSpO2：96 %\n酸素条件：室内気\nSpO2の評価：SpO2は問題なし/);
  assert.match(text, /■身体診察\n\［身体所見・検査・画像・心電図\］\nCr 2\.4 mg\/dL, K 5\.8 mEq\/L\n\n■重症度/);
  assert.match(text, /■再評価・治療反応\n\［場面・症候の入力（フローの質問への答え）\］\n経過：悪化\n/);
  const order = [...text.matchAll(/^■(.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(order, ["来院情報", "現病歴", "患者背景", "初期評価・ABCDE", "身体診察", "重症度・第一仮説・鑑別", "再評価・治療反応", "帰宅・入院・転院と根拠", "欄に結びつかなかった場面・症候の入力"]);
});

test("A04: the answers no field took are kept, after the fields, in the order the flow asked, and counted by why", () => {
  // a schema where the medicines and the family history are not classified yet (the state before 2026-10-25, when they were declared observations): the background field could not take them
  const flow = structuredClone(FLOW);
  for (const id of ["meds", "fhx"]) flow.questions.find((q: any) => q.id === id).br.cat = "pending";
  const answers = { ...ANSWERS, meds: ["antiht", "alcohol"], fhx: "pos" };
  const note = A.assemble("A04", { kase: withFlow(KASE, answers, flow), flow });
  assert.equal(note.extras.length, 1);
  assert.equal(note.extras[0].label, R.REST_LABEL);
  assert.match(
    A.toText(note),
    /■欄に結びつかなかった場面・症候の入力\n（フローの質問への答えのうち、記載の欄に振り分けられなかったものです。ここにない項目は未確認で、陰性・正常を意味しません）\n【救急外来 × 失神】\n［受け入れ］\n受け入れ準備：モニター・12誘導ECG・除細動器\n病着：21:40\n［病歴・診察］\n家族歴：家族歴あり\n内服：降圧薬・利尿薬・血管拡張薬、飲酒$/,
  );
  // pending (left unclassified with a reason): 2; not a chart item: 1 (the preparation; the disposition goes to its field since 2026-10-26); a time no question declares: 1 (the arrival time)
  assert.deepEqual(note.routing.reasons, { pending: 2, none: 1, aux: 1 });
  assert.equal(note.routing.answered, 17);
  assert.equal(note.routing.placed, 13);
  assert.equal(note.routing.rest.length, 4);
  const summary = R.routingSummary(note.routing);
  assert.match(summary, /17 件のうち、13 件を ROUTES の欄に振り分けました。4 件は欄に結びつかず（.*カテゴリ未分類 2.*）、末尾のブロックに残しています。/);
  assert.match(summary, /記載の項目にしない質問 1/);
  assert.match(summary, /どの質問にも付かない時刻・測定条件・理由 1/);
  // without those two answers nothing is left over but the preparation and the arrival time
  assert.deepEqual(A.assemble("A04", { kase: withFlow(), flow: FLOW }).routing.reasons, { none: 1, aux: 1 });
});

test("A04: the medicines and the family history are patient background (context, 2026-10-25): they go to the background field, in the order the flow asked, and none is left over for the structure", () => {
  const answers = { ...ANSWERS, meds: ["antiht", "alcohol"], fhx: "pos" };
  const q = (id: string) => FLOW.questions.find((x: any) => x.id === id).br;
  assert.deepEqual([q("meds"), q("fhx")].map((b: any) => [b.ent, b.cat]), [["context", "medication"], ["context", "history"]]);
  const note = A.assemble("A04", { kase: withFlow(KASE, answers), flow: FLOW });
  const bg = note.sections.find((s: any) => s.key === "background");
  assert.deepEqual(bg.blocks.map((b: any) => b.source), ["history", "routed"]);
  assert.equal(bg.blocks[1].text, "家族歴：家族歴あり\n既往：高血圧\n内服：降圧薬・利尿薬・血管拡張薬、飲酒");
  assert.deepEqual(note.routing.reasons, { none: 1, aux: 1 }); // the preparation and the arrival time only: nothing is "pending"
  assert.equal(note.routing.placed, 15);
  assert.equal(note.routing.rest.length, 2);
});

test("A04: a time or measurement condition follows the question that declares it, to the same place (the SpO2 and 'on room air' stay together)", () => {
  const route = (answers: any, flow: any = FLOW) => R.routeAnswers("A04", { flow, kase: withFlow(KASE, answers, flow) });
  // spo2 is routed: its condition is written right after it in the same field
  assert.deepEqual(route({ spo2: 94, o2: "oxygen" }).routed.initial, ["SpO2：94 %", "酸素条件：酸素投与下"]);
  // the ECG's time is declared by the ECG question: it follows that question
  assert.deepEqual(route({ ecg_find: ["normal"], t_ecg: "22:05" }).routed.initial, ["12誘導ECG：ECG異常なし", "12誘導ECG（22:05）"]);
  // two questions declare the same time: it is written once, after the first one the flow asks
  const both = route({ ecg_find: ["normal"], ecg_text: "洞調律", t_ecg: "22:05" }).routed.initial;
  assert.equal(both.filter((l: string) => l === "12誘導ECG（22:05）").length, 1);
  assert.equal(both.indexOf("12誘導ECG（22:05）"), 1);
  assert.equal(both.length, 3);
  // a performed treatment and its time go together to the management field
  assert.deepEqual(route({ tx: ["fluid"], t_tx: "21:50" }).routed.management, ["処置：輸液", "処置の実施（21:50）"]);
  // a question that is not classified takes its time with it, to the same block and for the same reason (a schema where the treatment is still pending)
  const stale = structuredClone(FLOW);
  stale.questions.find((q: any) => q.id === "tx").br.cat = "pending";
  const pend = route({ tx: ["fluid"], t_tx: "21:50" }, stale);
  assert.equal(pend.placed, 0);
  assert.deepEqual(pend.rest.map((r: any) => [r.line, r.why]), [["処置：輸液", "pending"], ["処置の実施（21:50）", "pending"]]);
  // an answered time / condition that no answered question declares is kept as one no question declares
  const orphan = route({ o2: "oxygen" });
  assert.deepEqual(orphan.rest.map((r: any) => r.why), ["aux"]);
  assert.equal(orphan.placed, 0);
  const arrival = route({ t_arrival: "21:40" });
  assert.deepEqual(arrival.reasons, { aux: 1 }); // the arrival time (the origin of the time axis) has no question that declares it
});

test("ROUTES decides: every question of every flow with categories lands where its category and the table say, recomputed here", () => {
  const ENT: any = { observation: "observation", context: "patient_context", assessment: "assessment", action: "action", decision: "decision" };
  const counts: Record<string, { placed: number; pending: number }> = {};
  for (const flow of Object.values<any>(S.FLOWS)) {
    if (!flow.cat) continue;
    const note = flow.cat.note;
    const index = new Map<string, string>();
    for (const [field, rules] of Object.entries<any>(T.NOTE_ROUTES[note])) for (const [entity, cats] of Object.entries<string[]>(rules)) for (const c of cats) if (c !== "*") index.set(`${entity}:${c}`, field);
    const n = (counts[note] ??= { placed: 0, pending: 0 });
    for (const q of flow.questions) {
      const want = ENT[q.br.ent] ? (q.br.cat === "pending" ? { why: "pending" } : index.has(`${ENT[q.br.ent]}:${q.br.cat}`) ? { field: index.get(`${ENT[q.br.ent]}:${q.br.cat}`) } : { why: "stale" }) : { why: q.br.ent === "none" ? "none" : "aux" };
      assert.deepEqual(R.placeOf(flow, q, note), want, `${flow.id}.${q.id}`);
      if ((want as any).field) n.placed++;
      if ((want as any).why === "pending") n.pending++;
      assert.notEqual((want as any).why, "stale", `${flow.id}.${q.id}: the category is not one ROUTES takes: re-import`);
    }
  }
  // the shipped declarations place most questions; what is left carries a reason in clinical-modules (docs/flow-cat-pending.md there)
  assert.deepEqual(Object.keys(counts).sort(), ["A01", "A04"]);
  assert.equal(counts.A04.placed + counts.A04.pending, 732); // 708 + the disposition and its basis of the 12 flows (ent decision, 2026-10-26)
  assert.equal(counts.A01.placed + counts.A01.pending, 63); // 61 + the disposition and its basis (ent decision, 2026-10-26)
  for (const n of Object.values(counts)) assert.ok(n.placed > 10 * n.pending, JSON.stringify(n));
});

test("nothing is lost, nothing is made up: for every flow with categories and every question answered, the placed lines and the rest are exactly the answered lines", () => {
  for (const flow of Object.values<any>(S.FLOWS)) {
    if (!flow.cat) continue;
    const answers: any = {};
    for (const q of flow.questions) {
      if (I.SKIP.has(q.id)) continue;
      answers[q.id] = q.type === "choice" ? q.options[0].id : q.type === "multi" ? [q.options[0].id] : q.type === "number" ? 7 : q.type === "time" ? "10:00" : "x";
    }
    const kase = { ...KASE, sex: "女性", structured: "", intake: null as any };
    kase.intake = { flow: flow.id, answers };
    kase.structured = I.renderStructured(flow, answers, kase);
    const r = R.routeAnswers(flow.cat.note, { flow, kase });
    assert.equal(r.fromText, false, flow.id);
    const got = [...Object.values<string[]>(r.routed).flat(), ...r.rest.map((x: any) => x.line)];
    assert.deepEqual(sorted(got), sorted(askedLines(flow, answers, kase)), flow.id); // each answered line once, none added
    assert.equal(r.answered, got.length);
    assert.equal(r.placed + r.rest.length, r.answered);
    assert.equal(Object.values<number>(r.reasons).reduce((a, b) => a + b, 0), r.rest.length);
    // a routed line sits in a field of the type, and only there
    for (const f of Object.keys(r.routed)) assert.ok(T.NOTE_TYPES[flow.cat.note].sections.some((s: any) => s.key === f), f);
  }
});

test("A04: only the answered questions are written; an unanswered one adds nothing, so it cannot read as negative or normal", () => {
  const note = A.assemble("A04", { kase: withFlow(KASE, { spo2: 96 }), flow: FLOW });
  assert.deepEqual(note.routing.rest, []);
  assert.deepEqual(note.extras, []);
  const text = A.toText(note);
  assert.match(text, /■初期評価・ABCDE\n\［バイタル\］\nBP 92\/54, HR 108\n\［場面・症候の入力（フローの質問への答え）\］\nSpO2：96 %\n/);
  assert.ok(!text.includes("欄に結びつかなかった"), "no rest, no block");
  assert.ok(!text.includes("未入力の中核項目") && !text.includes("clinical-modules") && !text.includes("陰性ではありません"), "the notes meant for the model stay out");
  // the only words the assembly adds: the headings and the one sentence under the rest block
  assert.match(R.REST_NOTE, /ここにない項目は未確認で、陰性・正常を意味しません/);
  // answers only (no typed findings): the physical-exam field says （未入力）, the routed field is not （未入力）
  const only = A.assemble("A04", { kase: withFlow({}, { spo2: 96 }), flow: FLOW });
  assert.ok(only.sections.find((s: any) => s.key === "exam").empty && only.unfilled.includes("exam"));
  assert.ok(!only.sections.find((s: any) => s.key === "initial").empty && !only.unfilled.includes("initial"));
});

test("A04: when the answers cannot be read question by question, all of the text is kept as the rest, nothing is routed, and it is said", () => {
  const good = withFlow();
  const all = textLines(R.answeredText(good.structured));
  const cases: Record<string, any> = {
    "no flow structure": { kase: good, flow: null },
    "no stored answers": { kase: { ...good, intake: null }, flow: FLOW },
    "another flow's answers": { kase: { ...good, intake: { flow: "emergency-department.chest-pain", answers: ANSWERS } }, flow: FLOW },
    "answers that are no longer the text that was sent": { kase: { ...good, intake: { flow: FLOW.id, answers: { ...ANSWERS, spo2: 88 } } }, flow: FLOW },
    "a flow that has no categories (outpatient first visit)": { kase: good, flow: S.FLOWS["outpatient-first-visit.fever"] },
  };
  for (const [name, c] of Object.entries(cases)) {
    const note = A.assemble("A04", { ...c });
    assert.equal(note.routing.fromText, true, name);
    assert.equal(note.routing.placed, 0, name);
    assert.deepEqual(note.routing.rest.map((r: any) => r.line), all, name); // every answered line, in order
    assert.deepEqual(note.routing.reasons, { text: all.length }, name);
    assert.ok(note.sections.every((s: any) => s.blocks.every((b: any) => b.source !== "routed")), name);
    const text = A.toText(note);
    for (const l of all) assert.ok(text.includes(l), `${name}: ${l}`);
    assert.match(R.routingSummary(note.routing), /0 件を ROUTES の欄に振り分けました/);
  }
  // a stale schema (a category ROUTES does not take, or none at all) leaves the answer in the rest, as stale, not placed anywhere
  const stale = structuredClone(FLOW);
  stale.questions.find((q: any) => q.id === "spo2").br.cat = "nonsense";
  delete stale.questions.find((q: any) => q.id === "rr").br.cat;
  const n = A.assemble("A04", { kase: withFlow(KASE, { spo2: 96, rr: 18 }, stale), flow: stale });
  assert.deepEqual(n.routing.reasons, { stale: 2 });
  assert.equal(n.routing.placed, 0);
});

test("A04: dropping the AI mark and the source marks does not touch the answers (they are the doctor's own input)", () => {
  const note = A.assemble("A04", { kase: withFlow(), flow: FLOW, items: [item("plan", "輸液の反応を見る [標準・出典未確認]", [BOOK])] });
  for (const opts of [{}, { aiMark: false }, { sourceMarks: false }, { aiMark: false, sourceMarks: false }]) {
    const t = A.toText(note, opts);
    assert.match(t, /\［場面・症候の入力（フローの質問への答え）\］\n第一印象：sick\n呼吸数：18 回\/分/, JSON.stringify(opts));
    assert.match(t, /■欄に結びつかなかった場面・症候の入力/, JSON.stringify(opts));
    assert.ok(!t.includes("AI草案〕呼吸数") && !t.includes("［書籍］"), JSON.stringify(opts));
  }
  const full = A.toText(note);
  assert.ok(full.indexOf("■欄に結びつかなかった場面・症候の入力") < full.indexOf("■AI草案の出典（採用した項目）"));
});

test("scope: A04 and A01 route; the other types place the answers beside the findings as before", () => {
  assert.deepEqual(R.ROUTED, ["A04", "A01"]);
  for (const id of R.ROUTED) for (const [field, parts] of Object.entries<string[]>(A.FILL[id])) assert.ok(!parts.includes("structured"), `${id}.${field} still names the flow's answers`);
  for (const id of A.ENABLED.filter((t: string) => !R.ROUTED.includes(t))) {
    const note = A.assemble(id, { kase: withFlow(), flow: FLOW });
    assert.equal(note.routing, null, id);
    assert.deepEqual(note.extras, [], id);
    assert.ok(JSON.stringify(note.sections).includes("第一印象：sick"), `${id} still carries the answers in a field`);
    assert.ok(!A.toText(note).includes("■欄に結びつかなかった"), id);
  }
  // no answers: nothing is routed, no block, no heading made up
  for (const id of R.ROUTED) {
    assert.equal(A.assemble(id, { kase: KASE, flow: FLOW }).routing, null);
    assert.ok(!A.toText(A.assemble(id, { kase: KASE, flow: FLOW })).includes("場面・症候の入力"));
  }
  // a flow of another scene is not routed into a type it does not name: the emergency answers do not go into A01's fields (and the reverse)
  const emergencyInA01 = A.assemble("A01", { kase: withFlow(), flow: FLOW });
  assert.equal(emergencyInA01.routing.fromText, true);
  assert.equal(emergencyInA01.routing.placed, 0);
  const outpatientInA04 = A.assemble("A04", { kase: withFlow(KASE, OP_ANSWERS, OP_FLOW), flow: OP_FLOW });
  assert.equal(outpatientInA04.routing.fromText, true);
  assert.equal(outpatientInA04.routing.placed, 0);
});

test("A01: each answer of the outpatient flow goes to the field ROUTES gives its question's category; what is typed stays as it was; the host factors and the medicines are patient background and go to the background field", () => {
  const note = A.assemble("A01", { kase: withFlow(KASE, OP_ANSWERS, OP_FLOW), flow: OP_FLOW });
  const by = Object.fromEntries(note.sections.map((s: any) => [s.key, s.blocks.map((b: any) => b.source)]));
  assert.deepEqual(by, {
    visit: ["ctx", "routed"],
    hpi: ["complaint", "routed"],
    background: ["history", "routed"],
    initial: ["vitals", "routed"],
    exam: ["findings", "routed"],
    tests: ["routed"],
    reasoning: ["own", "routed"],
    plan: ["routed"],
    followup: [],
  });
  const text = (key: string) => note.sections.find((s: any) => s.key === key).blocks.find((b: any) => b.source === "routed").text;
  assert.equal(text("visit"), "紹介状：なし");
  assert.equal(text("hpi"), "主訴：発熱と咳\n期間：急性");
  assert.equal(text("background"), "宿主：糖尿病\n既往・ベースライン：高血圧\n薬剤：最近の抗菌薬\nアレルギー：なし\n居住：独居"); // in the order the flow asks
  assert.equal(text("initial"), "第一印象：sick\n体温：38.6 ℃");
  assert.equal(text("exam"), "口腔・咽頭・耳・副鼻腔：咽頭発赤・扁桃腫大");
  assert.equal(text("tests"), "血液・生化学の異常：好中球減少");
  assert.equal(text("reasoning"), "問題の要約：急性の発熱");
  assert.equal(text("plan"), "実施した検査：血算・白血球分画\n解熱薬の処方：アセトアミノフェン");
  // the typed findings are no longer mixed with the flow's answers in the physical-exam field
  assert.equal(note.sections.find((s: any) => s.key === "exam").blocks[0].text, "Cr 2.4 mg/dL, K 5.8 mEq/L");
  // the medicines and the host factors are patient background (context, 2026-10-25): nothing is left over
  assert.deepEqual(note.routing.reasons, {});
  assert.deepEqual(note.extras.map((e: any) => e.key), []);
  assert.equal(note.routing.placed, 15);
  assert.match(R.routingSummary(note.routing), /15 件のうち、15 件を ROUTES の欄に振り分けました。/);
  // an unanswered question adds nothing: the follow-up field says （未入力）, nothing is made normal or negative
  assert.deepEqual(note.unfilled, ["followup"]);
  const fields = A.toText(note).split("■欄に結びつかなかった")[0];
  assert.ok(!fields.includes("陰性") && !fields.includes("正常"), "the assembly adds no word of its own about findings in the fields (the one sentence under the rest block says they are not negative)");
});

test("the table and the declarations the routing reads are consistent: ROUTES' fields are the type's own, one (entity, category) goes to one field, only the scenes with a note type have categories", () => {
  assert.deepEqual(Object.keys(T.NOTE_ROUTES.A04), T.NOTE_TYPES.A04.sections.map((s: any) => s.key));
  for (const [note, fields] of Object.entries<any>(T.NOTE_ROUTES)) assert.deepEqual(new Set(Object.keys(fields)), new Set(T.NOTE_TYPES[note].sections.map((s: any) => s.key)), note);
  for (const note of R.ROUTED) {
    const seen = new Map<string, string>();
    for (const [field, rules] of Object.entries<any>(T.NOTE_ROUTES[note])) {
      for (const [entity, cats] of Object.entries<string[]>(rules)) for (const c of cats) {
        if (c === "*") continue;
        assert.ok(!seen.has(`${entity}:${c}`), `${note}: ${entity}:${c} goes to ${seen.get(`${entity}:${c}`)} and ${field}`);
        seen.set(`${entity}:${c}`, field);
      }
    }
  }
  assert.equal(T.NOTE_TYPES_SOURCE.routes_path, "scripts/note_expanded.py (ROUTES)");
  assert.equal(S.FLOW_SCHEMA_SOURCE.commit, T.NOTE_TYPES_SOURCE.commit, "both were read from the same commit of clinical-modules");
  const NOTE_OF: any = { "emergency-department": "A04", "outpatient-first-visit": "A01" };
  for (const flow of Object.values<any>(S.FLOWS)) {
    const note = NOTE_OF[flow.scene];
    assert.equal(!!flow.cat, !!note, flow.id);
    if (note) assert.equal(flow.cat.note, note, flow.id);
    for (const q of flow.questions) assert.equal(q.br && "cat" in q.br, !!note && !!flow.cat.entity[q.br.ent], `${flow.id}.${q.id}`);
  }
  assert.deepEqual(R.ROUTED, Object.values(NOTE_OF).sort().reverse());
});

test("adopted items: only the ticked ones enter, grouped by the draft section they came from; the doctor's own words carry no AI mark", () => {
  const items = [item("problems", "急性腎障害の疑い [推論]"), item("assessment", "腎前性を第一に考える", [BOOK]), item("plan", "輸液の反応を見る [標準・出典未確認]"), item("contingency", "尿量が出なければ腎臓内科へ相談 [施設依存]")];
  const note = A.assemble("A04", { kase: KASE, items });
  const text = A.toText(note);
  assert.equal(note.adopted, 4);
  assert.match(text, /■重症度・第一仮説・鑑別\n［先生のアセスメント（入力）］\n腎前性AKIを第一に考える。\n［問題リスト（草案）］\n・〔AI草案〕急性腎障害の疑い \[推論\]\n［各問題の評価（草案）］\n・〔AI草案〕腎前性を第一に考える ［書籍 p\.10-12］/);
  assert.match(text, /■治療・処置・コンサルト\n［初期プラン（草案。予定・検討であり、実施の記録ではありません）］\n・〔AI草案〕輸液の反応を見る/);
  assert.match(text, /\n［コンサルト・医師コールの基準（草案）］\n・〔AI草案〕尿量が出なければ/);
  // the doctor's typed assessment line has no AI mark
  assert.ok(!/〔AI草案〕腎前性AKI/.test(text));
  // nothing that was not passed in appears
  assert.ok(!text.includes("採用していない"));
  const without = A.toText(A.assemble("A04", { kase: KASE, items: [] }));
  assert.ok(!without.includes("AI草案") && !without.includes("［問題リスト"));
  assert.equal(A.assemble("A04", { kase: KASE, items: [] }).adopted, 0);
});

test("adopted items that the type has no field for are reported, never silently dropped; junk items are ignored", () => {
  const note = A.assemble("A08", { kase: KASE, items: [item("plan", "x"), item("problems", "y"), { role: "nope", text: "z" }, { role: "plan", text: "  " }, null] });
  assert.equal(note.adopted, 0);
  assert.equal(note.unplaced, 2);
  const text = A.toText(note);
  assert.ok(!text.includes("・〔AI草案〕"));
  assert.throws(() => A.assemble("B05", { kase: KASE }), /not offered/);
  assert.throws(() => A.assemble("ZZ9", { kase: KASE }), /not offered/);
});

test("B02: the request side only (the response side's fields are not made); B06's task field says nothing is assigned", () => {
  const note = A.assemble("B02", { kase: KASE });
  const keys = note.sections.map((s: any) => s.key);
  assert.deepEqual(keys, ["target", "summary", "question", "findings", "management", "communication", "followup"]);
  assert.ok(!keys.includes("response_context") && !keys.includes("recommendation"));
  const handover = A.toText(A.assemble("B06", { kase: KASE, items: [item("plan", "輸液の反応を見る")] }));
  assert.match(handover, /■次担当者に必要な行動・担当・期限\n［初期プラン（草案.*\n・〔AI草案〕輸液の反応を見る\n（担当・期限は入力していません）/);
});

test("toText options: the AI mark and the source marks can be dropped separately; a warning on a number is always kept", () => {
  const items = [item("plan", "架空薬Xを 10 mg で開始 【出典未確認・要確認】 [標準・出典未確認]", [BOOK]), item("assessment", "腎前性を考える [推論]")];
  const note = A.assemble("A01", { kase: KASE, items });
  const full = A.toText(note);
  assert.match(full, /※〔AI草案〕の印がある項目は/);
  assert.match(full, /・〔AI草案〕架空薬Xを 10 mg で開始 【出典未確認・要確認】 \[標準・出典未確認\] ［書籍 p\.10-12］/);
  assert.match(full, /■AI草案の出典（採用した項目）\n・架空内科ハンドブック p\.10-12/);
  const noAi = A.toText(note, { aiMark: false });
  assert.ok(!noAi.includes("AI草案〕") && !noAi.includes("※〔"));
  assert.match(noAi, /・架空薬Xを 10 mg で開始/);
  assert.match(noAi, /\[推論\]/); // the source marks stay when only the AI mark is dropped
  const noSrc = A.toText(note, { sourceMarks: false });
  assert.ok(!/\[(推論|標準・出典未確認|施設依存)\]/.test(noSrc) && !noSrc.includes("［書籍") && !noSrc.includes("AI草案の出典"));
  assert.match(noSrc, /・〔AI草案〕架空薬Xを 10 mg で開始 【出典未確認・要確認】$/m);
  const bare = A.toText(note, { aiMark: false, sourceMarks: false });
  assert.match(bare, /【出典未確認・要確認】/); // always kept: it warns about the number, it is not a mark of origin
  assert.ok(!bare.includes("AI草案"));
});

// ---------------------------------------------------------------------------------- which draft sections can be adopted
test("draft sections: the four chart-content headings map to roles; the draft's own sections are never adoptable", () => {
  for (const h of MODE_HEADINGS.assess) {
    const role = A.headingRole(h);
    if (A.NOT_ADOPTABLE.some((n: string) => h.startsWith(n))) assert.equal(role, null, h);
    else assert.ok(role, `${h} has no role`);
  }
  assert.ok(A.NOT_ADOPTABLE.includes(OWN_SECTION_ASSESS));
  assert.equal(A.headingRole(OWN_SECTION_ASSESS), null);
  assert.deepEqual(MODE_HEADINGS.assess.map((h: string) => A.headingRole(h)), ["problems", "assessment", "plan", "contingency", null, null]);
  // the model's heading may carry numbering or a different bracket
  assert.equal(A.headingRole("2. 各問題の評価(根拠)"), "assessment");
  assert.equal(A.headingRole("確認すべき数値"), null);
  assert.equal(A.headingRole("書籍に見つからなかった点"), null);
  for (const r of Object.values<any>(A.ROLES)) assert.ok(MODE_HEADINGS.assess.some((h: string) => h.startsWith(r.heading)), r.heading);
});

// ---------------------------------------------------------------------------------- the screen code sends and keeps nothing
test("pins: the assembly and the note screen never send, save, export, print or share; they only copy (through the app's clipboard helper)", () => {
  const forbidden = /\bfetch\s*\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|indexedDB|\bprint\s*\(|navigator\.share|createObjectURL|new Blob|\bdownload\b|window\.open|navigator\.clipboard|innerHTML|\beval\s*\(|new Function/;
  for (const f of ["note-assemble.js", "note-ui.js", "note-types.js", "draft-scenes.js", "note-route.js"]) {
    const code = readFileSync(web(f), "utf-8").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(code, forbidden, f);
  }
  // nothing from the AI side is imported by the assembly: it is deterministic
  const asm = readFileSync(web("note-assemble.js"), "utf-8");
  assert.deepEqual([...asm.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]), ["./case-model.js", "./case-course.js", "./draft-scenes.js", "./note-route.js", "./note-types.js"]);
  // the one thing taken from the course is how a day is called ("入院N日目" or "基準日からN日後"): case-course.js imports nothing at all
  assert.deepEqual([...readFileSync(web("case-course.js"), "utf-8").matchAll(/^import /gm)], []);
  // the routing reads the question structure and the table, and nothing else: pure functions
  assert.deepEqual([...readFileSync(web("note-route.js"), "utf-8").matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]), ["./intake.js", "./note-types.js"]);
  // the scenes' headings are plain data: they import nothing at all (docs/enhancement-plan.md 8.16)
  assert.deepEqual([...readFileSync(web("draft-scenes.js"), "utf-8").matchAll(/^import /gm)], []);
  const ui = readFileSync(web("note-ui.js"), "utf-8");
  assert.deepEqual([...ui.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]).sort(), ["./note-assemble.js", "./note-route.js", "./note-types.js"]);
});

test("pins: the Worker has no endpoint for notes (the note is made in the browser; nothing about it is sent or stored)", () => {
  const handler = readFileSync(join(REPO, "worker", "src", "handler.ts"), "utf-8");
  assert.doesNotMatch(handler, /\/api\/note/);
  const app = readFileSync(web("app.js"), "utf-8");
  // the app wires the notes to a clipboard helper and, for the doctor's own "症例の記録へ" button, to the record's entry (docs/clinical-use.md 1e):
  // that is the only thing the note screen can hand on, and it goes through the record store, not through a note endpoint
  assert.match(app, /initNotes\(\{ el, \$, openDialog, copyText, toRecord: \(kase, items\) => records\.addAdopted\(kase, items\) \}\)/);
  // the note screen itself reaches no server
  const ui = readFileSync(web("note-ui.js"), "utf-8").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(ui, /\bfetch\(|\bapi\(|XMLHttpRequest|localStorage|sessionStorage/);
});

// ---------------------------------------------------------------------------------- the S/O/A/P view (the doctor's decision D11 b, 2026-10-26)
test("the S/O/A/P view: the same lines, grouped S / O / A / P by the chart skill; only the encounter notes have it", () => {
  const note = A.assemble("A04", { kase: withFlow(), flow: FLOW, items: [item("problems", "#1 試験の問題"), item("plan", "試験の計画")] });
  const plain = A.toText(note);
  const soap = A.toText(note, { soap: true });
  const heads = [...soap.matchAll(/^(S|O|A|A\/P|P)\)/gm)].map((m) => m[1]);
  assert.deepEqual(heads, ["S", "O", "A", "P"]);
  // every line of the field view is in the S/O/A/P view, and the S/O/A/P view adds only the part headings
  const lines = (t: string) => t.split("\n").filter((l) => l.trim());
  const extra = lines(soap).filter((l) => !lines(plain).includes(l));
  assert.ok(extra.every((l) => /^(S|O|A|A\/P|P)\)|^その他$/.test(l)), JSON.stringify(extra));
  assert.equal(lines(soap).length, lines(plain).length + heads.length);
  // the fields keep their own order inside a part
  const order = [...soap.matchAll(/^■(.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(order.slice(0, 3), ["来院情報", "現病歴", "患者背景"]);
  assert.ok(order.indexOf("重症度・第一仮説・鑑別") < order.indexOf("帰宅・入院・転院と根拠"));
  // a summary, a consult and a handover have no S/O/A/P view: the option leaves them as they are
  for (const t of ["A08", "B02", "B06"]) {
    assert.equal(A.hasSoapView(t), false, t);
    const n = A.assemble(t, { kase: KASE });
    assert.equal(A.toText(n, { soap: true }), A.toText(n));
  }
  for (const t of ["A04", "A01", "A05", "A06", "A02"]) assert.ok(A.hasSoapView(t), t);
  // every field of the mapped types has a part (nothing falls to "その他")
  for (const [t, map] of Object.entries(A.SOAP_MAP) as [string, any][]) assert.deepEqual(T.NOTE_TYPES[t].sections.map((s: any) => s.key).filter((k: string) => !map[k]), [], t);
});

test("the S/O/A/P view splits the plan's answers into Dx / Tx / Ex by their question's category; an uncategorised line is not guessed", () => {
  const SCHEMA_FLOWS: any = S.FLOWS;
  const flow = SCHEMA_FLOWS["emergency-department.shock"];
  const answers = { tests: ["vbg", "labs"], fluid: "given", t_fluid: "02:30", consult: ["icu"] };
  const kase = { ...KASE, structured: I.renderStructured(flow, answers, KASE), intake: { flow: flow.id, answers } };
  const note = A.assemble("A04", { kase, flow });
  const mgmt = note.sections.find((s: any) => s.key === "management");
  const routed = mgmt.blocks.find((b: any) => b.source === "routed");
  assert.equal(routed.lines.length, routed.cats.length);
  const soap = A.toText(note, { soap: true });
  const part = soap.slice(soap.indexOf("■治療・処置・コンサルト"));
  const dx = part.indexOf("Dx（診断・確認）:");
  const tx = part.indexOf("Tx（治療・処置・依頼）:");
  assert.ok(dx >= 0 && tx > dx, part.slice(0, 300));
  assert.ok(part.slice(dx, tx).includes("オーダーした検査"), "an order of tests is Dx");
  assert.ok(part.slice(tx).includes("細胞外液"), "a treatment is Tx");
  // the field view is unchanged: one block of lines, no Dx/Tx/Ex headings
  assert.ok(!A.toText(note).includes("Dx（診断・確認）:"));
});
