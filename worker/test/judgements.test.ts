// The fixes from the independent review of stage 3 (docs/enhancement-plan.md 8.14): the history of a judgement stays consistent when the doctor
// goes back to an earlier day, a record made before the log existed keeps what it had, a reopened task keeps when it was closed, AI-origin
// problem names carry their mark in the course notes, the admission note has no trend line, caps and blank rows do not lose or invent
// anything, and the size of a record is told before it can no longer be saved.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { REPO } from "./nodeDb.ts";

const web = (f: string) => join(REPO, "web", f);
const R: any = await import(web("case-record.js"));
const C: any = await import(web("case-course.js"));
const N: any = await import(web("record-notes.js"));
const A: any = await import(web("note-assemble.js"));

const CASE = { age: "70代", sex: "男性", setting: "救急", complaint: "3日前から腹痛、嘔気", vitals: "BP 92/54, HR 108", findings: "Cr 2.4 mg/dL", history: "高血圧", own: "" };
const part = (t: string, label: string) => t.split(`■${label}`)[1].split("\n■")[0];

function admission() {
  let r = R.newRecord(CASE);
  r = R.addProblem(r, "腎前性AKI").rec; // p1
  r = R.setProblem(r, "p1", { certainty: "suspected" });
  r = R.addEntry(r, "p1", "assess", "脱水と薬剤の関与を考える").rec;
  r = R.addEntry(r, "p1", "plan", "細胞外液の輸液を検討").rec; // i2
  return r;
}

// ---------------------------------------------------------------------------------- 1. the admission note has no trend line
test("the admission note has no trend line: a trend recorded on day 1 never prints a note without its state", () => {
  let r = admission();
  r = C.setTrend(r, 1, "p1", "improved", "解熱した");
  r = C.setTrend(r, 1, "p1", "worse");
  assert.ok(!/推移|解熱した/.test(A.toText(R.admissionNote(r))), "A05 has no 推移 (a note whose state was dropped would read as an improvement)");
  assert.match(A.toText(N.progressNote(r, 1)), /推移（入院1日目）: 悪化 — 解熱した/, "the progress note of day 1 shows the state the doctor chose, with its note");
});

// ---------------------------------------------------------------------------------- 2. AI marks on problem names in the course notes
test("course notes: an AI-origin problem's name carries the AI mark, the citation and where it came from; the notice is shown; the marks come off together", () => {
  let r = R.addAdopted(R.newRecord(CASE), [{ role: "problems", heading: "問題リスト", text: "敗血症の可能性 [推論]", cites: [{ kind: "book", title: "T", page: "p.12" }] }, { role: "problems", heading: "問題リスト", text: "腎前性AKI" }]).rec;
  r = R.attach(R.attach(r, "a1", "new").rec, "a2", "new").rec; // p1 (AI), p2 (AI)
  r = R.addEntry(r, "p1", "assess", "培養を待つ").rec;
  r = C.setToday(r, 2);
  r = C.setDayTurning(r, 2, true);
  r = C.setTrend(r, 2, "p1", "worse");
  r = C.addTask(r, { text: "培養の結果", kind: "result", owner: "主治医", due: "入院3日目", problem: "p1" }).rec;
  r = C.setDischarge(r, { decided: true, day: 2 });
  r = R.setProblem(r, "p2", { dx: "main" });
  const a06 = N.progressNote(r, 2);
  const t06 = A.toText(a06);
  assert.match(part(t06, "Problem別Assessment・Plan"), /［1\. 〔AI草案〕敗血症の可能性 \[推論\] ［書籍 p\.12］ 〔救急から〕］/);
  assert.ok(a06.adopted > 0 && t06.includes(A.AI_NOTICE), "the notice about AI items is there");
  const a08 = A.toText(N.dischargeNote(r));
  assert.match(a08, /・推移 〔AI草案〕敗血症の可能性 \[推論\]: 悪化/, "a trend line names the problem with its mark");
  assert.match(a08, /［〔AI草案〕敗血症の可能性 \[推論\]］/, "a task's problem too");
  assert.match(a08, /区分を選んでいない問題: 〔AI草案〕敗血症の可能性 \[推論\]/, "and the problems not classed");
  const plain = A.toText(N.dischargeNote(r), { aiMark: false, sourceMarks: false });
  assert.ok(!plain.includes("〔AI草案〕") && !plain.includes("[推論]") && !plain.includes("［書籍"), "with the marks off none is left, in the names inside other lines too");
  assert.match(plain, /・推移 敗血症の可能性: 悪化/);
});

// ---------------------------------------------------------------------------------- 3. going back a day to edit a judgement
test("going back to an earlier day and editing a judgement: the board and the latest notes agree (the edit counts from the last day already recorded)", () => {
  let r = admission();
  r = C.setToday(r, 5);
  r = R.setProblem(r, "p1", { certainty: "confirmed" });
  r = C.setToday(r, 4);
  r = R.setProblem(r, "p1", { certainty: "likely" });
  assert.equal(r.problems[0].certainty, "likely");
  assert.equal(C.asOf(r, 5).problems[0].certainty, "likely", "the doctor's last act is what the latest notes show");
  assert.equal(C.asOf(r, 4).problems[0].certainty, "suspected", "the note of day 4, as it was recorded then");
  assert.deepEqual(r.problems[0].cert_log.map((l: any) => [l.day, l.certainty]), [[1, "suspected"], [5, "likely"]]);
  let q = admission();
  q = C.setToday(q, 5);
  q = R.setEntry(q, "p1", "plan", "i2", { state: "done", reason: "開始" });
  q = C.setToday(q, 4);
  q = R.setEntry(q, "p1", "plan", "i2", { state: "stopped", reason: "x|y" }); // a reason may hold any character
  assert.deepEqual([C.asOf(q, 5).problems[0].plan[0].state, C.asOf(q, 5).problems[0].plan[0].reason], ["stopped", "x|y"]);
  assert.equal(C.asOf(q, 4).problems[0].plan[0].state, "planned");
  // an item added on day 5 and edited from day 3: the log is not earlier than the item
  let s = C.setToday(admission(), 5);
  s = R.addEntry(s, "p1", "plan", "あとから").rec; // i3, added 5
  s = C.setToday(s, 3);
  s = R.setEntry(s, "p1", "plan", "i3", { state: "done" });
  assert.deepEqual(s.problems[0].plan[1].log, [{ day: 5, state: "done" }]);
});

test("fuzz: whatever order the days are worked in, the last day's notes show the board's current certainty and plan states", () => {
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
  for (let trial = 0; trial < 200; trial++) {
    let r = admission();
    r = R.addEntry(r, "p1", "plan", "二つ目").rec; // i3
    for (let step = 0; step < 12; step++) {
      r = C.setToday(r, 1 + rnd(8));
      if (rnd(2)) r = R.setProblem(r, "p1", { certainty: ["", "suspected", "likely", "confirmed", "ruled_out"][rnd(5)] });
      else r = R.setEntry(r, "p1", "plan", rnd(2) ? "i2" : "i3", { state: ["planned", "done", "changed", "stopped"][rnd(4)], ...(rnd(2) ? { reason: "r" } : {}) });
    }
    const last = C.asOf(r, 365).problems[0];
    assert.equal(last.certainty, r.problems[0].certainty, `trial ${trial}: certainty`);
    assert.deepEqual(last.plan.map((e: any) => [e.state, e.reason]), r.problems[0].plan.map((e: any) => [e.state ?? "planned", e.reason]), `trial ${trial}: plan states`);
  }
});

// ---------------------------------------------------------------------------------- 4. a record made before the log existed
test("a record made before the judgements had a log keeps its day-1 certainty and plan state after the first later edit", () => {
  const legacy = R.cleanRecord({
    v: 1,
    title: "t",
    ed: { case: CASE, adopted: [], seen: [], reading: {} },
    adm: {},
    problems: [{ id: "p1", label: "腎前性AKI", certainty: "likely", from: "typed", assess: [], plan: [{ id: "i1", text: "輸液", from: "typed", state: "done", reason: "開始" }] }],
    contingency: [],
  });
  assert.equal(legacy.problems[0].cert_log, undefined);
  let r = C.setToday(legacy, 3);
  r = R.setProblem(r, "p1", { certainty: "confirmed" });
  r = R.setEntry(r, "p1", "plan", "i1", { state: "changed", reason: "減量" });
  assert.equal(C.asOf(r, 1).problems[0].certainty, "likely", "the admission note still says what it said");
  assert.deepEqual([C.asOf(r, 1).problems[0].plan[0].state, C.asOf(r, 1).problems[0].plan[0].reason], ["done", "開始"]);
  assert.equal(C.asOf(r, 3).problems[0].certainty, "confirmed");
  assert.equal(C.asOf(r, 3).problems[0].plan[0].state, "changed");
  // a new record has nothing to seed (nothing was chosen): the first choice is its own first item
  const fresh = R.setProblem(C.setToday(R.addProblem(R.newRecord(CASE), "x").rec, 2), "p1", { certainty: "likely" });
  assert.deepEqual(fresh.problems[0].cert_log, [{ day: 2, certainty: "likely" }]);
});

// ---------------------------------------------------------------------------------- 5. caps do not lose what was typed
test("the day cap: a day with nothing in it is not kept; a day beyond the cap can be known before typing (canWriteDay)", () => {
  let r = admission();
  for (let d = 1; d <= C.COURSE_LIMITS.days; d++) r = C.setDayField(r, d, "interval", `d${d}`);
  assert.equal(r.course.days.length, C.COURSE_LIMITS.days);
  assert.equal(C.canWriteDay(r, C.COURSE_LIMITS.days + 1), false);
  assert.equal(C.canWriteDay(r, 3), true, "a day that has an entry can always be written");
  assert.equal(JSON.stringify(C.setDayField(r, 200, "interval", "x")), JSON.stringify(r), "nothing is made beyond the cap");
  // clearing the only text of a day gives its place back
  const cleared = C.setDayField(r, 3, "interval", "");
  assert.equal(cleared.course.days.length, C.COURSE_LIMITS.days - 1);
  assert.equal(C.canWriteDay(cleared, 200), true);
  // a mark or a trend keeps the day; taking the last of them away removes it
  let m = C.setDayTurning(admission(), 4, true);
  assert.equal(m.course.days.length, 1);
  m = C.setDayTurning(m, 4, false);
  assert.equal(m.course.days.length, 0);
  assert.equal(C.setTrend(admission(), 6, "p1", "").course.days.length, 0, "taking back a trend of a day with no entry makes no entry");
});

// ---------------------------------------------------------------------------------- 6. the header does not claim more than it holds
test("the as-of line says which part is as of the day and which part is the last edit", () => {
  let r = C.setToday(admission(), 4);
  r = C.setSummary(r, "context", "一般病棟へ転棟"); // typed on day 4
  const t = A.toText(N.interimNote(r, 3));
  assert.match(t, /※入院3日目の時点の記録です。確度・計画の状態・推移・課題の完了は、その日までに記録したものだけです。文章（問題名・評価・計画・先生が入力した文）は、最後に編集したものです。/);
  assert.match(part(t, "転棟先・引継ぎ理由"), /一般病棟へ転棟/, "a text is the last edit, as the line says");
});

// ---------------------------------------------------------------------------------- 7. a reopened task keeps when it was closed
test("tasks: closing and reopening are logged, so the note of the day it was closed shows it closed", () => {
  let r = C.setToday(admission(), 2);
  r = C.addTask(r, { text: "血培の結果", kind: "result", owner: "A", due: "入院3日目" }).rec; // k1, added day 2
  r = C.setToday(r, 3);
  r = C.setTask(r, "k1", { state: "done" });
  r = C.setToday(r, 6);
  r = C.setTask(r, "k1", { state: "open" });
  assert.deepEqual(r.course.tasks[0].log, [{ day: 3, state: "done" }, { day: 6, state: "open" }]);
  assert.equal(r.course.tasks[0].state, "open");
  assert.ok(!("closed" in r.course.tasks[0]));
  assert.ok(!A.toText(N.interimNote(r, 3)).includes("血培の結果"), "on day 3 it was closed: not listed");
  assert.equal(C.asOf(r, 4).course.tasks[0].state, "done");
  assert.equal(C.asOf(r, 4).course.tasks[0].closed, 3);
  assert.ok(A.toText(N.interimNote(r, 6)).includes("血培の結果"), "on day 6 it is open again");
  assert.equal(C.asOf(r, 2).course.tasks[0].state, "open", "before it was closed it was open");
  // a task closed before the log existed (it has `closed` and no log) keeps its history when it is reopened
  const legacy = C.cleanCourse({ today: 6, tasks: [{ id: "k1", text: "x", added: 2, state: "done", closed: 3 }] }, []);
  const rec = { ...r, course: legacy };
  const reopened = C.setTask(rec, "k1", { state: "open" });
  assert.equal(C.asOf(reopened, 4).course.tasks[0].state, "done");
  assert.equal(C.asOf(reopened, 6).course.tasks[0].state, "open");
  // the log is the history: a task read back takes its state from it
  const back = C.cleanCourse({ tasks: [{ id: "k1", text: "x", added: 1, state: "open", log: [{ day: 2, state: "done" }] }] }, []);
  assert.deepEqual([back.tasks[0].state, back.tasks[0].closed], ["done", 2]);
  // closing the same day it was reopened leaves one item for the day
  let s = C.setToday(C.addTask(C.setToday(admission(), 2), { text: "y" }).rec, 3);
  s = C.setTask(C.setTask(s, "k1", { state: "done" }), "k1", { state: "open" });
  assert.deepEqual(s.course.tasks[0].log, [{ day: 3, state: "open" }]);
});

// ---------------------------------------------------------------------------------- 8. a task's kind is blank unless the doctor chose it
test("a task's kind is not guessed: blank unless chosen, printed with no label, counted with no label", () => {
  let r = C.setToday(admission(), 2);
  r = C.addTask(r, { text: "返事を確認" }).rec;
  assert.equal(r.course.tasks[0].kind, "");
  assert.match(A.toText(N.interimNote(r, 2)), /・返事を確認（担当: 未入力／期限: 未入力）/);
  assert.ok(!A.toText(N.interimNote(r, 2)).includes("結果待ち:"));
  assert.deepEqual(R.checks(r, {}).find((x: any) => x.id === "tasks_open").items, ["返事を確認"]);
  r = C.setTask(r, "k1", { kind: "result" });
  assert.match(A.toText(N.interimNote(r, 2)), /・結果待ち: 返事を確認/);
  assert.equal(C.setTask(r, "k1", { kind: "weird" }).course.tasks[0].kind, "", "a kind that is not one of the four is blank");
});

// ---------------------------------------------------------------------------------- 9. the relativized record is computed once per record object
test("relativizeRecord: the same record object gives the same answer without computing again; another day or another object is computed", () => {
  const r = C.setDayField(C.setToday(admission(), 2), 2, "interval", "10/22 から発熱");
  const a = R.relativizeRecord(r, { now: new Date("2026-10-24T03:00:00Z") });
  assert.equal(R.relativizeRecord(r, { now: new Date("2026-10-24T09:00:00Z") }), a, "same object, same day");
  const b = R.relativizeRecord(r, { now: new Date("2026-10-26T03:00:00Z") });
  assert.notEqual(b, a, "another day");
  assert.notEqual(b.rec.course.days[0].interval, a.rec.course.days[0].interval, "and the relative text follows the day");
  const r2 = C.setDayField(r, 2, "interval", "10/22 から咳");
  assert.match(R.relativizeRecord(r2, { now: new Date("2026-10-24T03:00:00Z") }).rec.course.days[0].interval, /咳/, "an edited record is another object");
  assert.equal(r.course.days[0].interval, "10/22 から発熱", "the record itself is not changed");
});

// ---------------------------------------------------------------------------------- 10. the size of a record is told before it cannot be saved
test("the size of a record: the budget is the server's limit, and a note appears from 70% of it (a count, no verdict)", async () => {
  const { MAX_RECORD_PAYLOAD } = await import(join(REPO, "worker", "src", "recordstore.ts"));
  assert.equal(R.RECORD_BUDGET, MAX_RECORD_PAYLOAD, "the screen's budget and the server's limit are the same number");
  assert.ok(!R.checks(admission(), {}).some((x: any) => x.id === "size"));
  let r = admission();
  for (let d = 1; d <= 30; d++) for (const f of C.DAY_FIELDS) r = C.setDayField(r, d, f.key, "あ".repeat(f.max));
  for (let d = 1; d <= 30; d++) r = C.setTrend(r, d, "p1", "improved", "い".repeat(400));
  for (let i = 0; i < 12; i++) r = R.addProblem(r, `問題${i}`).rec;
  for (let d = 1; d <= 30; d++) for (let i = 2; i <= 12; i++) r = C.setTrend(r, d, `p${i}`, "worse", "う".repeat(400));
  const size = JSON.stringify(r).length;
  assert.ok(size > R.RECORD_BUDGET * 0.7, `${size}`);
  const c = R.checks(r, {}).find((x: any) => x.id === "size");
  assert.match(c.text, /^この記録の大きさは、保存できる上限の \d+% です/);
  assert.ok(!/異常|正常|遅|問題なし|不足|警告|危険|要注意/.test(c.text));
});

// ---------------------------------------------------------------------------------- 11. rows with no text
test("a task or a medication with no text is not printed and not counted (it does not survive a reload either)", () => {
  let r = C.setToday(admission(), 2);
  r = C.addTask(r, {}).rec;
  r = C.addMed(r, {}).rec;
  r = C.addMed(r, { text: "薬A" }).rec;
  r = C.setDischarge(r, { decided: true, day: 2 });
  const interim = A.toText(N.interimNote(r, 2));
  assert.equal(part(interim, "結果待ち・未解決事項").trim(), "（未入力）");
  const dc = A.toText(N.dischargeNote(r));
  assert.ok(!/・ — /.test(dc) && /・薬A — 区分未記入/.test(dc));
  assert.ok(!R.checks(r, {}).some((x: any) => x.id === "tasks_open"));
  assert.deepEqual(R.checks(r, {}).find((x: any) => x.id === "meds_unset").items, ["薬A"]);
  const only = C.setDischarge(C.addMed(C.setToday(admission(), 2), {}).rec, { decided: true, day: 2 });
  assert.ok(!A.toText(N.dischargeNote(only)).includes("退院時処方"), "no medication with text: the conditional field is left out");
  assert.equal(R.cleanRecord(JSON.parse(JSON.stringify(r))).course.discharge.meds.length, 1, "what a reload keeps is what the notes showed");
});

// ---------------------------------------------------------------------------------- 13. hardening
test("a discharge is not made from an invalid day or an unclean record; a note's day is a day", () => {
  const r = C.setToday(admission(), 5);
  const bad = C.setDischarge(r, { decided: true, day: 999 });
  assert.equal(bad.course.discharge.decided, false, "deciding with a day that is not a day is not a decision");
  assert.equal(bad.course.discharge.day, null);
  assert.equal(C.setDischarge(r, { decided: true }).course.discharge.day, 5, "deciding with no day given uses the working day");
  const raw = JSON.parse(JSON.stringify(C.setDischarge(r, { decided: true, day: 3 })));
  raw.course.discharge.decided = "yes";
  assert.equal(N.dischargeNote(raw), null, "only the boolean true decides");
  assert.equal(C.asOf(raw, 2).course.discharge.decided, "yes", "(a view of an unclean record is not made into one)");
  for (const day of [0, 2.5, "3", -1, 1000]) assert.match(A.toText(N.progressNote(r, day as any)), /入院5日目/, `day ${day} is the working day`);
  assert.equal(N.interimNote(r, 2.5 as any).asOf, 5);
});
