// The case record's model (web/case-record.js) and the admission note built from it (web/note-assemble.js, `board`).
// Pinned: stable problem ids that are never reused, carrying an item is the doctor's act (and keeps its AI origin), an AI item is never
// "done", a blank stays blank, the time axis judges nothing, the checks count and do not conclude, and the note holds no date or ID.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO } from "./nodeDb.ts";

const web = (f: string) => join(REPO, "web", f);
const R: any = await import(web("case-record.js"));
const A: any = await import(web("note-assemble.js"));
const I: any = await import(web("intake.js"));
const S: any = await import(web("flow-schema.js"));

const CASE = { age: "70代", sex: "男性", setting: "救急", complaint: "3日前から腹痛、嘔気", vitals: "BP 92/54, HR 108", findings: "Cr 2.4 mg/dL", history: "高血圧", own: "" };
const ITEMS = [
  { role: "problems", heading: "問題リスト", text: "腎前性AKI（脱水・NSAIDs）", cites: [{ kind: "book", title: "腎臓病学 ［転写］", page: "p.10", url: "" }] },
  { role: "problems", heading: "問題リスト", text: "急性腹症の原因検索" },
  { role: "assessment", heading: "各問題の評価", text: "尿Na低値が前提。 [推論]" },
  { role: "plan", heading: "初期プラン", text: "細胞外液の輸液を検討 [標準・出典未確認]", cites: [{ kind: "book", title: "腎臓病学 ［転写］", page: "p.12" }] },
  { role: "contingency", heading: "コンサルト・医師コールの基準", text: "尿量が減ったときは連絡する [推論]" },
];
const snapshot = (o: unknown) => JSON.stringify(o);
const withItems = () => R.addAdopted(R.newRecord(CASE), ITEMS).rec;

// ---------------------------------------------------------------------------------- shape
test("newRecord / cleanRecord: a record keeps its case and its parts; unknown keys, bad values and over-long texts are dropped", () => {
  const r = R.newRecord(CASE);
  assert.equal(r.v, 1);
  assert.equal(r.title, "70代・男性・救急｜3日前から腹痛、嘔気");
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.seq, { p: 0, i: 0, a: 0 });
  assert.deepEqual(Object.keys(r.adm), ["route", "summary", "baseline", "general", "outlook"]);
  assert.deepEqual(R.cleanRecord(JSON.parse(JSON.stringify(r))), r); // a round trip through the server's JSON

  const dirty = {
    v: 1,
    title: "t".repeat(200),
    extra: "x",
    ed: { case: { ...CASE, extra: 1 }, adopted: [{ id: "a1", role: "plan", text: "あ".repeat(900), heading: "h", cites: [{ title: "T", page: "p.1", junk: 1 }, "x", { nothing: 1 }], to: "p9" }, { id: "bad", role: "plan", text: "x" }, { id: "a2", role: "nonsense", text: "x" }, { id: "a1", role: "plan", text: "dup" }] },
    adm: { route: " 救急から入院 ", junk: "x", summary: 5 },
    problems: [
      { id: "p1", label: "AKI", certainty: "made-up", from: "ed", assess: [{ id: "i1", text: "評価", from: "ai" }, { id: "i1", text: "same id" }, { id: "x", text: "bad id" }, { id: "i2", text: "" }], plan: [{ id: "i3", text: "輸液", state: "done", reason: "実施" }, { id: "i4", text: "x", state: "weird", from: "?" }] },
      { id: "p1", label: "dup" },
      { id: "q1", label: "bad id" },
      "x",
    ],
    contingency: [{ id: "i5", text: "連絡", from: "ai" }],
    seq: { p: 1, i: 2, a: 0 },
  };
  const c = R.cleanRecord(dirty);
  assert.equal(c.title.length, 80);
  assert.ok(!("extra" in c) && !("extra" in c.ed.case));
  assert.deepEqual(c.adm, { route: "救急から入院", summary: "", baseline: "", general: "", outlook: "" });
  assert.equal(c.ed.adopted.length, 1);
  assert.equal(c.ed.adopted[0].text.length, 600);
  assert.deepEqual(c.ed.adopted[0].cites, [{ title: "T", page: "p.1" }]);
  assert.equal(c.ed.adopted[0].to, "", "a carry-target that is not a problem of the record is dropped");
  assert.deepEqual(c.problems.map((p: any) => [p.id, p.label, p.certainty, p.from]), [["p1", "AKI", "", "ed"]]);
  assert.deepEqual(c.problems[0].assess.map((e: any) => e.id), ["i1"]);
  assert.deepEqual(c.problems[0].plan.map((e: any) => [e.id, e.state, e.from, e.reason]), [["i3", "done", "typed", "実施"], ["i4", "planned", "typed", undefined]]);
  assert.deepEqual(c.contingency.map((e: any) => e.id), ["i5"]);
  assert.deepEqual(c.seq, { p: 1, i: 5, a: 1 }, "the counters are past every id in use");
  for (const bad of [null, "x", [], {}, { v: 2, ed: { case: CASE } }, { v: 1 }, { v: 1, ed: {} }, { v: 1, ed: { case: { age: "70代" } } }]) assert.equal(R.cleanRecord(bad), null);
  assert.equal(R.newRecord({ age: "70代" }), null); // an empty case is not a record
});

test("cleanRecord: counts are limited (problems, entries, adopted items) and ids stay unique", () => {
  const many = Array.from({ length: 40 }, (_, k) => ({ id: `p${k + 1}`, label: `問題${k}`, assess: Array.from({ length: 30 }, (_, j) => ({ id: `i${k * 100 + j + 1}`, text: "x" })) }));
  const c = R.cleanRecord({ v: 1, ed: { case: CASE, adopted: Array.from({ length: 90 }, (_, k) => ({ id: `a${k + 1}`, role: "plan", text: `p${k}` })) }, problems: many });
  assert.equal(c.problems.length, R.LIMITS.problems);
  assert.ok(c.problems.every((p: any) => p.assess.length <= R.LIMITS.entries));
  assert.equal(c.ed.adopted.length, R.LIMITS.adopted);
  assert.equal(new Set(c.problems.map((p: any) => p.id)).size, c.problems.length);
});

// ---------------------------------------------------------------------------------- stable ids and the board
test("problems: ids are stable and never reused, even after a problem is removed; the input record is never changed", () => {
  const r0 = R.newRecord(CASE);
  const before = snapshot(r0);
  const a = R.addProblem(r0, "腎前性AKI");
  assert.equal(snapshot(r0), before, "the input is not changed");
  const b = R.addProblem(a.rec, "急性腹症");
  assert.deepEqual(b.rec.problems.map((p: any) => p.id), ["p1", "p2"]);
  const gone = R.removeProblem(b.rec, "p1");
  const c = R.addProblem(gone, "感染症");
  assert.deepEqual(c.rec.problems.map((p: any) => p.id), ["p2", "p3"], "p1 is not given again");
  assert.equal(c.id, "p3");
  // the counters survive a save and reload
  const back = R.cleanRecord(JSON.parse(JSON.stringify(c.rec)));
  assert.equal(R.addProblem(back, "x").id, "p4");
  // a removed problem's id is not reused even when the record is read back with the problem already gone
  assert.equal(R.addProblem(R.cleanRecord({ ...JSON.parse(JSON.stringify(gone)), seq: { p: 2, i: 0, a: 0 } }), "y").id, "p3");
  // a full board adds nothing
  let full = r0;
  for (let i = 0; i < R.LIMITS.problems; i++) full = R.addProblem(full, `p${i}`).rec;
  assert.equal(R.addProblem(full, "one more").id, null);
});

test("problems: priority order, label, certainty (the doctor's choice; anything else is blank); entries and plan states", () => {
  let r = R.addProblem(R.addProblem(R.newRecord(CASE), "A").rec, "B").rec;
  r = R.moveProblem(r, "p2", -1);
  assert.deepEqual(r.problems.map((p: any) => p.label), ["B", "A"]);
  r = R.moveProblem(r, "p2", -1); // already first
  r = R.moveProblem(r, "p9", 1);
  assert.deepEqual(r.problems.map((p: any) => p.label), ["B", "A"]);
  r = R.setProblem(r, "p1", { label: "  腎前性AKI  ", certainty: "suspected" });
  assert.deepEqual([r.problems[1].label, r.problems[1].certainty], ["腎前性AKI", "suspected"]);
  r = R.setProblem(r, "p1", { certainty: "definitely" });
  assert.equal(r.problems[1].certainty, "", "a certainty that is not one of the choices is not chosen");
  const e = R.addEntry(r, "p1", "plan", "輸液を検討");
  assert.equal(e.rec.problems[1].plan[0].state, "planned", "a plan entry starts as planned");
  assert.equal(e.rec.problems[1].plan[0].from, "typed");
  const e2 = R.addEntry(e.rec, "p1", "assess", "脱水が主");
  assert.equal(e2.rec.problems[1].assess[0].state, undefined, "an assessment has no state");
  assert.equal(R.addEntry(e2.rec, "p9", "plan", "x").id, null);
  let r2 = R.setEntry(e2.rec, "p1", "plan", e.id, { state: "done", reason: "救急で開始" });
  assert.deepEqual([r2.problems[1].plan[0].state, r2.problems[1].plan[0].reason], ["done", "救急で開始"]);
  r2 = R.setEntry(r2, "p1", "plan", e.id, { state: "whatever" });
  assert.equal(r2.problems[1].plan[0].state, "done", "a state that is not one of the three is ignored");
  r2 = R.setEntry(r2, "p1", "plan", e.id, { reason: "" });
  assert.ok(!("reason" in r2.problems[1].plan[0]));
  r2 = R.setEntry(r2, "p1", "assess", e2.id, { state: "done", text: "脱水と薬剤" });
  assert.deepEqual(r2.problems[1].assess[0], { id: e2.id, text: "脱水と薬剤", from: "typed" }, "an assessment never gets a state");
  r2 = R.removeEntry(r2, "p1", "plan", e.id);
  assert.deepEqual(r2.problems[1].plan, []);
  assert.equal(R.setAdm(r2, "route", "救急から入院").adm.route, "救急から入院");
  assert.equal(R.setAdm(r2, "nonsense", "x").adm.nonsense, undefined);
});

// ---------------------------------------------------------------------------------- carrying over
test("attach: carrying an item is the doctor's act; it keeps its AI origin and citations; a plan item arrives as planned, never done", () => {
  const r0 = withItems();
  assert.deepEqual(r0.ed.adopted.map((a: any) => [a.id, a.role, a.to]), [["a1", "problems", ""], ["a2", "problems", ""], ["a3", "assessment", ""], ["a4", "plan", ""], ["a5", "contingency", ""]]);
  assert.deepEqual(r0.problems, [], "adopting an item changes nothing on the board");
  assert.equal(R.addAdopted(r0, ITEMS).added, 0, "an item already taken is not taken twice");
  let r = R.attach(r0, "a1", "new").rec;
  assert.deepEqual(r.problems.map((p: any) => [p.id, p.label, p.from, p.certainty]), [["p1", "腎前性AKI（脱水・NSAIDs）", "ed", ""]]);
  assert.equal(r.ed.adopted[0].to, "p1");
  r = R.attach(r, "a3", "p1").rec;
  r = R.attach(r, "a4", "p1").rec;
  const p = r.problems[0];
  assert.deepEqual(p.assess.map((e: any) => [e.text, e.from]), [["尿Na低値が前提。 [推論]", "ai"]]);
  assert.deepEqual(p.plan.map((e: any) => [e.state, e.from, e.cites?.[0]?.page]), [["planned", "ai", "p.12"]]);
  r = R.attach(r, "a5", "outlook").rec;
  assert.deepEqual(r.contingency.map((e: any) => [e.from, e.text]), [["ai", "尿量が減ったときは連絡する [推論]"]]);
  assert.equal(R.attach(r, "a2", "none").rec.ed.adopted[1].to, "none");
  // an item goes only where it fits
  for (const [id, target] of [["a3", "new"], ["a4", "outlook"], ["a2", "outlook"], ["a1", "p9"], ["zz", "p1"]] as const) assert.equal(R.attach(r0, id, target).ok, false, `${id} -> ${target}`);
  // choosing again replaces: the entry it made is taken back
  r = R.attach(r, "a4", "").rec;
  assert.deepEqual(r.problems[0].plan, []);
  assert.equal(r.ed.adopted[3].to, "");
  const r3 = R.attach(R.attach(r0, "a4", "new").rec, "a4", "").rec; // "new" is for the problem list only
  assert.deepEqual(r3.problems, []);
});

test("carried items: removing the problem or the entry sends the item back to 'not decided'; the entry ids are never reused", () => {
  let r = R.attach(R.attach(withItems(), "a1", "new").rec, "a4", "p1").rec;
  const entry = r.ed.adopted[3].entry;
  const gone = R.removeEntry(r, "p1", "plan", entry);
  assert.deepEqual([gone.ed.adopted[3].to, gone.ed.adopted[3].entry], ["", undefined]);
  const again = R.attach(gone, "a4", "p1").rec;
  assert.notEqual(again.problems[0].plan[0].id, entry, "a removed entry's id is not used again");
  const noProblem = R.removeProblem(r, "p1");
  assert.deepEqual(noProblem.ed.adopted.map((a: any) => a.to), ["", "", "", "", ""]);
  // the carried state survives a save and reload, and a carry-target that no longer exists is dropped on the way in
  assert.deepEqual(R.cleanRecord(JSON.parse(JSON.stringify(r))), r);
  const broken = JSON.parse(JSON.stringify(r));
  broken.problems = [];
  assert.equal(R.cleanRecord(broken).ed.adopted[0].to, "");
});

// ---------------------------------------------------------------------------------- no calendar date is kept
test("relativizeRecord: dates in every free text of the record become relative before saving; nothing else is touched", () => {
  const now = new Date("2026-10-24T03:00:00Z");
  let r = R.newRecord({ ...CASE, complaint: "10/22 から腹痛" });
  r = R.setAdm(r, "summary", "10/20に入院、10/22に発熱。血圧 120/80");
  r = R.addProblem(r, "2026年10月22日の再燃").rec;
  r = R.addEntry(r, "p1", "plan", "2/3 に減量。10/23 に再評価").rec;
  r = R.setEntry(r, "p1", "plan", "i1", { state: "done", reason: "10月22日に開始" });
  r = R.attach(R.addAdopted(r, ITEMS).rec, "a5", "outlook").rec;
  const before = snapshot(r);
  const out = R.relativizeRecord(r, { now });
  assert.equal(snapshot(r), before, "the input is not changed");
  assert.equal(out.rec.ed.case.complaint, "2日前 から腹痛");
  assert.equal(out.rec.adm.summary, "4日前に入院、入院3日目に発熱。血圧 120/80");
  assert.equal(out.rec.problems[0].label, "2日前の再燃");
  assert.equal(out.rec.problems[0].plan[0].text, "2/3 に減量。1日前 に再評価");
  assert.equal(out.rec.problems[0].plan[0].reason, "2日前に開始");
  assert.ok(out.changes.length >= 6 && out.changes.every((c: any) => c.from && c.to));
  const again = R.relativizeRecord(out.rec, { now });
  assert.equal(again.rec, out.rec, "nothing to change: the same object comes back");
  assert.deepEqual(again.changes, []);
  const json = JSON.stringify(out.rec);
  assert.ok(!/10\/2[0-9]|2026年|10月22日/.test(json.replace(/120\/80/g, "")));
});

// ---------------------------------------------------------------------------------- the time axis
const AP = S.FLOWS["emergency-department.abdominal-pain"];
test("time axis: minutes from the flow's own origin; a time before it is read as the next day and says so; observations hang on their time", () => {
  const answers = I.cleanAnswers(AP, { t_arrival: "21:40", t_ecg: "21:52", ecg_find: ["normal"], t_vbg: "22:10", vbg_res: ["pending"], t_us: "22:05", t_analg: "22:30", t_dispo: "00:10" }).answers;
  const t = R.timeline(AP, answers, {});
  assert.deepEqual(t.origin, { label: "病着", time: "21:40" });
  assert.equal(t.originMissing, false);
  assert.deepEqual(t.rows.map((r: any) => [r.id, r.time, r.min, r.wrapped, r.label]), [
    ["t_arrival", "21:40", 0, false, "病着"],
    ["t_ecg", "21:52", 12, false, "12誘導ECG"],
    ["t_us", "22:05", 25, false, "腹部エコー"],
    ["t_vbg", "22:10", 30, false, "血液ガス"],
    ["t_analg", "22:30", 50, false, "鎮痛"],
    ["t_dispo", "00:10", 150, true, "Disposition決定"],
  ]);
  assert.equal(t.rows[0].isOrigin, true);
  assert.deepEqual(t.rows[1].details, ["12誘導ECG：ECG異常なし"], "the ECG finding hangs on the ECG time, in the option's own short words");
  assert.deepEqual(t.rows[3].details, ["血液ガス：未実施・結果待ち"], "the blood gas result (waiting) hangs on its time, as the doctor chose it");
  // nothing in a row is a judgement: no late/early, no colour, no threshold
  for (const r of t.rows) assert.deepEqual(Object.keys(r).sort(), ["details", "id", "isOrigin", "label", "min", "time", "wrapped"]);
  // without the arrival time the axis is by clock time and says the origin is missing
  const noOrigin = R.timeline(AP, I.cleanAnswers(AP, { t_ecg: "21:52", t_us: "22:05" }).answers, {});
  assert.equal(noOrigin.origin, null);
  assert.equal(noOrigin.originMissing, true);
  assert.deepEqual(noOrigin.rows.map((r: any) => [r.id, r.min]), [["t_ecg", null], ["t_us", null]]);
  assert.deepEqual(R.timeline(AP, {}, {}).rows, []);
  // a time question whose condition is not met is not on the axis; labels
  assert.equal(R.minutesOf("23:59"), 1439);
  for (const bad of ["24:00", "9:5", "", null, "12:60"]) assert.equal(R.minutesOf(bad), null);
});

test("time axis: every flow has an origin question that is a time question, and every time question gets a name", () => {
  for (const f of Object.values<any>(S.FLOWS)) {
    const q = f.questions.find((x: any) => x.id === f.origin?.q);
    assert.ok(q && q.type === "time", `${f.id}: origin_q ${f.origin?.q}`);
    for (const t of f.questions.filter((x: any) => x.type === "time")) assert.ok(R.timeLabel(t).length > 0 && !R.timeLabel(t).includes("{value}"), `${f.id}.${t.id}`);
  }
});

// ---------------------------------------------------------------------------------- waiting and checks
test("waiting: only what the doctor chose as waiting (the bridge's classes); an unanswered question is not waiting", () => {
  assert.deepEqual(R.waiting(AP, {}, {}), []);
  const w = R.waiting(AP, I.cleanAnswers(AP, { gyn_us: "pending", ct_res: ["pending"], us_res: ["pending"], ecg_find: ["normal"] }).answers, { sex: "女性" });
  assert.deepEqual(w.map((x: any) => [x.id, x.kind]).sort(), [["ct_res", "wait"], ["gyn_us", "pend"], ["us_res", "wait"]].sort());
  assert.deepEqual(R.waiting(AP, I.cleanAnswers(AP, { gyn_us: "notdone" }).answers, {}).map((x: any) => [x.id, x.kind]), [["gyn_us", "wait"]]);
  // a result and "waiting" cannot both be chosen in one question (the form keeps the exclusive one only if it is last), so a result is never waiting
  assert.deepEqual(R.waiting(AP, I.cleanAnswers(AP, { us_res: ["pending", "free_fluid"] }).answers, {}), []);
});

test("checks: they count what is blank or undecided and name it; none of them is a verdict", () => {
  const FL = S.FLOWS;
  const answers = { first: "sick", t_arrival: "21:40", gyn_us: "pending", ct_res: ["pending"] };
  let r = R.newRecord({ ...CASE, structured: "場面・症候: 救急外来 × 腹痛（x）\n［受け入れ］\n第一印象：sick", intake: { flow: "emergency-department.abdominal-pain", answers } });
  r = R.addAdopted(r, ITEMS).rec;
  const ids = (rec: any) => R.checks(rec, FL).map((c: any) => c.id);
  assert.deepEqual(ids(r), ["core_missing", "pending", "waiting", "undecided", "no_problems", "unfilled"]);
  const cm = R.checks(r, FL).find((c: any) => c.id === "core_missing");
  assert.match(cm.text, /未入力（未確認。陰性ではありません）が \d+ 件/);
  assert.ok(cm.items.length > 10);
  assert.equal(R.checks(r, FL).find((c: any) => c.id === "undecided").items.length, 5);
  r = R.attach(R.attach(r, "a1", "new").rec, "a2", "none").rec;
  r = R.attach(r, "a3", "p1").rec;
  r = R.attach(r, "a4", "p1").rec;
  r = R.attach(r, "a5", "outlook").rec;
  assert.ok(!ids(r).includes("undecided") && !ids(r).includes("no_problems"));
  assert.deepEqual(ids(r).filter((x: string) => x.startsWith("no_") || x === "unnamed"), ["no_certainty"]); // the carried problem has an assessment and a plan
  r = R.setProblem(r, "p1", { certainty: "suspected" });
  assert.ok(!ids(r).includes("no_certainty"));
  r = R.addProblem(r, "").rec;
  assert.ok(ids(r).includes("unnamed"));
  r = R.addProblem(r, "感染症").rec;
  assert.deepEqual(R.checks(r, FL).filter((c: any) => ["no_certainty", "no_assessment", "no_plan"].includes(c.id)).map((c: any) => [c.id, c.items]), [["no_certainty", ["感染症"]], ["no_assessment", ["感染症"]], ["no_plan", ["感染症"]]]);
  // a record without a flow has no flow checks; the wording never says normal / abnormal / delayed / ok
  const noFlow = R.newRecord(CASE);
  assert.ok(!ids(noFlow).includes("core_missing"));
  for (const c of R.checks(r, FL)) assert.ok(!/異常|正常|遅|問題なし|不足|警告|危険|要注意/.test(c.text + c.items.join("")), c.text);
});

// ---------------------------------------------------------------------------------- the admission note
const noteText = (rec: any, opts: object = {}) => A.toText(R.admissionNote(rec), opts);
function boarded() {
  let r = R.attach(R.attach(withItems(), "a1", "new").rec, "a3", "p1").rec;
  r = R.attach(r, "a4", "p1").rec;
  r = R.attach(r, "a5", "outlook").rec;
  r = R.setProblem(r, "p1", { label: "腎前性AKI", certainty: "suspected" });
  r = R.addProblem(r, "高血圧の管理").rec; // typed by the doctor
  r = R.addEntry(r, "p2", "assess", "内服を再開する前に血圧を確認").rec;
  const e = R.addEntry(r, "p2", "plan", "降圧薬は腎機能をみて再開").rec;
  r = R.setEntry(e, "p2", "plan", "i5", { state: "done", reason: "内服は継続した" });
  r = R.setAdm(r, "route", "救急外来から、脱水と腎機能の評価・加療のため");
  r = R.setAdm(r, "summary", "70代男性。脱水に伴う腎前性AKIを疑う。");
  return r;
}

test("admission note: the case as typed, the board's problems in priority order, and the doctor's own texts; the AI mark and the carried mark are removable", () => {
  const r = boarded();
  const t = noteText(r);
  assert.match(t, /^【病棟入院時】下書き\n［日付］　［患者ID］　［氏名］\n※〔AI草案〕の印がある項目は/);
  const part = (label: string) => t.split(`■${label}`)[1].split("\n■")[0];
  assert.match(part("入院経路・目的"), /70代・男性・救急/);
  assert.match(part("入院経路・目的"), /救急外来から、脱水と腎機能の評価・加療のため/);
  assert.match(part("入院までの現病歴"), /3日前から腹痛、嘔気/);
  assert.match(part("既往・薬剤・アレルギー・生活歴"), /高血圧/);
  assert.match(part("入院時状態・検査"), /BP 92\/54, HR 108/);
  assert.match(part("Clinical Summary"), /脱水に伴う腎前性AKIを疑う/);
  assert.equal(part("優先順位付きProblem List").trim(), "1. 腎前性AKI（疑い） 〔救急から〕\n2. 高血圧の管理");
  const ap = part("Problem別Assessment・Plan");
  assert.match(ap, /［1\. 腎前性AKI（疑い）］\n評価:\n・〔AI草案〕尿Na低値が前提。 \[推論\]/);
  assert.match(ap, /計画（予定・検討。実施の記録ではありません）:\n・〔AI草案〕細胞外液の輸液を検討 \[標準・出典未確認\] ［書籍 p\.12］/);
  assert.match(ap, /［2\. 高血圧の管理］\n評価:\n・内服を再開する前に血圧を確認\n実施（医師の記録）:/);
  assert.ok(!/計画（予定・検討。実施の記録ではありません）:\n・降圧薬/.test(ap), "a plan the doctor recorded as done is not also listed as planned");
  assert.match(ap, /実施（医師の記録）:\n・降圧薬は腎機能をみて再開（理由: 内服は継続した）/);
  assert.match(part("再評価予定・退院条件・申し送り"), /［コンサルト・医師コールの基準（草案）］\n・〔AI草案〕尿量が減ったときは連絡する/);
  // the doctor's own entries carry no AI mark; the AI ones do, and the options take the marks off
  assert.ok(!/〔AI草案〕内服を再開/.test(t) && !/〔AI草案〕降圧薬/.test(t));
  const plain = noteText(r, { aiMark: false, sourceMarks: false });
  assert.ok(!plain.includes("〔AI草案〕") && !plain.includes("〔救急から〕") && !plain.includes("[推論]") && !plain.includes("［書籍") && !plain.includes("※〔"));
  assert.match(plain, /・細胞外液の輸液を検討\n/);
});

test("admission note: nothing the doctor did not carry is in it; a blank stays blank; no date, ID or name; AI items are never 'done'", () => {
  const r = withItems();
  const t = noteText(r); // five items adopted, none carried
  for (const w of ["腎前性AKI", "尿Na低値", "細胞外液", "尿量が減った"]) assert.ok(!t.includes(w), `${w} is not in the note until it is carried`);
  assert.match(t.split("■優先順位付きProblem List")[1].split("\n■")[0], /（未入力）/);
  assert.match(t.split("■Problem別Assessment・Plan")[1].split("\n■")[0], /（未入力）/);
  assert.match(t.split("■Clinical Summary")[1].split("\n■")[0], /（未入力）/);
  assert.ok(!/※〔AI草案〕/.test(t), "no AI notice when nothing of the AI reached the note");
  assert.match(t, /［日付］　［患者ID］　［氏名］/);
  assert.ok(!/\d{4}[年/-]\d{1,2}|\d{1,2}月\d{1,2}日|令和|患者ID[:：]\s*\d/.test(t));
  // every AI entry that is carried is planned: "done" exists only where the doctor set it
  const full = boarded();
  const states = full.problems.flatMap((p: any) => p.plan.map((e: any) => [e.from, e.state]));
  assert.deepEqual(states.filter(([f, s]: string[]) => f === "ai" && s !== "planned"), []);
  const note = R.admissionNote(full);
  assert.equal(note.adopted, 3, "the AI entries that reached the note are counted (assessment, plan, criteria to call)");
  // an unnamed problem is not in the note
  const withBlank = R.addProblem(full, "").rec;
  assert.equal(noteText(withBlank), noteText(full));
  // a problem the doctor removed leaves nothing
  assert.ok(!noteText(R.removeProblem(full, "p1")).split("■優先順位付きProblem List")[1].includes("腎前性AKI"));
});

test("admission note: other note types ignore the board, and the old behaviour for them is unchanged", () => {
  const board = R.boardOf(boarded());
  for (const id of ["A04", "A01", "A06", "A08", "B02", "B06"]) {
    const a = A.assemble(id, { kase: CASE, items: [] });
    const b = A.assemble(id, { kase: CASE, items: [], board });
    assert.deepEqual(b.sections, a.sections, id);
  }
  // without a board, A05 is the case and the adopted items only
  const plain = A.assemble("A05", { kase: CASE, items: ITEMS.map((i) => ({ ...i })) });
  assert.equal(plain.adopted, 5);
});

// ---------------------------------------------------------------------------------- purity
test("case-record.js is pure: no DOM, no network, no storage, no AI", () => {
  const src = readFileSync(web("case-record.js"), "utf-8").replace(/\/\/[^\n]*/g, "");
  for (const bad of [/\bfetch\(/, /localStorage|sessionStorage|indexedDB/, /\bdocument\./, /\bwindow\./, /XMLHttpRequest|WebSocket/, /anthropic|api\/ask|\/api\//i]) assert.doesNotMatch(src, bad);
});
