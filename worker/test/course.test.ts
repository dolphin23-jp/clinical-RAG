// The course of an admission in the case record: web/case-course.js (days, trends, tasks, asOf), the A06 built from it (web/record-notes.js).
// Pinned: nothing later is shown in a note for an earlier day, a blank stays blank, a plan is "planned" until the doctor records otherwise,
// the checks count and do not conclude, and no calendar date is anywhere.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO } from "./nodeDb.ts";

const web = (f: string) => join(REPO, "web", f);
const R: any = await import(web("case-record.js"));
const C: any = await import(web("case-course.js"));
const N: any = await import(web("record-notes.js"));
const A: any = await import(web("note-assemble.js"));

const CASE = { age: "70代", sex: "男性", setting: "救急", complaint: "3日前から腹痛、嘔気", vitals: "BP 92/54, HR 108", findings: "Cr 2.4 mg/dL", history: "高血圧", own: "" };
const snap = (o: unknown) => JSON.stringify(o);
const text = (rec: any, day?: number, opts: object = {}) => A.toText(N.progressNote(rec, day), opts);
const part = (t: string, label: string) => t.split(`■${label}`)[1].split("\n■")[0];

/** A record with two problems and a plan, worked over five hospital days. */
function admission() {
  let r = R.newRecord(CASE); // today = 1
  r = R.setAdm(r, "route", "脱水と腎機能の評価・加療のため");
  r = R.addProblem(r, "腎前性AKI").rec; // p1, day 1
  r = R.setProblem(r, "p1", { certainty: "suspected" });
  r = R.addEntry(r, "p1", "assess", "脱水と薬剤の関与を考える").rec; // i1
  r = R.addEntry(r, "p1", "plan", "細胞外液の輸液を検討").rec; // i2, planned
  r = R.addEntry(r, "p1", "plan", "内服薬を見直す").rec; // i3, planned
  return r;
}

// ---------------------------------------------------------------------------------- shape
test("cleanCourse: days are unique and in order, trends and tasks name only the record's problems, texts and counts are limited, blanks stay blank", () => {
  const c = C.cleanCourse(
    {
      today: 4,
      extra: "x",
      days: [
        { day: 3, interval: "  発熱が続く  ", objective: "あ".repeat(3000), turning: true, trend: { p1: { state: "worse", note: "咳が増えた" }, p9: { state: "improved" }, p2: { state: "bogus" }, p3: { state: "", note: "" } } },
        { day: 2, trend: { p1: { state: "improved" } } },
        { day: 3, interval: "duplicate day" },
        { day: 0 },
        { day: 1.5 },
        { day: 400 },
        "x",
      ],
      tasks: [
        { id: "k1", text: "CT の結果を確認", kind: "result", owner: "担当医", due: "入院5日目", added: 2, state: "done", closed: 4, problem: "p1" },
        { id: "k2", text: "x", kind: "weird", added: 99999, problem: "p9" },
        { id: "k1", text: "dup" },
        { id: "bad", text: "bad id" },
        { id: "k3", text: "" },
      ],
    },
    ["p1", "p2", "p3"],
  );
  assert.equal(c.today, 4);
  assert.ok(!("extra" in c));
  assert.deepEqual(c.days.map((d: any) => d.day), [2, 3]);
  assert.equal(c.days[1].interval, "発熱が続く");
  assert.equal(c.days[1].objective.length, 1500);
  assert.equal(c.days[1].turning, true);
  assert.deepEqual(c.days[1].trend, { p1: { state: "worse", note: "咳が増えた" } }, "an unknown problem is dropped; an unknown state with no note, and an empty trend, are not kept (blank)");
  assert.deepEqual(c.days[0].trend, { p1: { state: "improved" } });
  assert.deepEqual(c.tasks.map((k: any) => [k.id, k.kind, k.owner, k.due, k.added, k.state, k.closed, k.problem]), [["k1", "result", "担当医", "入院5日目", 2, "done", 4, "p1"], ["k2", "", "", "", 1, "open", undefined, undefined]]);
  assert.deepEqual(C.cleanCourse(null, []), C.emptyCourse());
  assert.deepEqual(C.emptyCourse().days, []);
  assert.deepEqual(C.cleanCourse({ today: 0 }, []).today, 1);
  assert.equal(C.dayNo(366, 7), 7);
  const many = C.cleanCourse({ days: Array.from({ length: 80 }, (_, i) => ({ day: i + 1 })), tasks: Array.from({ length: 80 }, (_, i) => ({ id: `k${i + 1}`, text: "t" })) }, []);
  assert.equal(many.days.length, C.COURSE_LIMITS.days);
  assert.equal(many.tasks.length, C.COURSE_LIMITS.tasks);
});

test("a record keeps its course through the server's JSON, and the counters never go back", () => {
  let r = admission();
  r = C.setToday(r, 3);
  r = C.setDayField(r, 3, "interval", "夜間に発熱");
  r = C.setTrend(r, 3, "p1", "worse", "咳が増えた");
  r = C.addTask(r, { text: "血液培養の結果", kind: "result", owner: "当直医", due: "入院4日目", problem: "p1" }).rec;
  const back = R.cleanRecord(JSON.parse(JSON.stringify(r)));
  assert.deepEqual(back, r);
  assert.equal(back.seq.k, 1);
  const gone = C.removeTask(r, "k1");
  assert.equal(C.addTask(R.cleanRecord(JSON.parse(JSON.stringify(gone))), { text: "別の課題" }).id, "k2", "a task id is not used again");
});

// ---------------------------------------------------------------------------------- the working day and what is stamped
test("what is added is stamped with the working day; a judgement that changes is logged with its day", () => {
  let r = admission();
  assert.equal(r.course.today, 1);
  assert.deepEqual([r.problems[0].added, r.problems[0].assess[0].added, r.problems[0].plan[0].added], [1, 1, 1]);
  r = C.setToday(r, 3);
  r = R.setProblem(r, "p1", { certainty: "confirmed" });
  r = R.setEntry(r, "p1", "plan", "i2", { state: "done", reason: "救急から開始した" });
  r = R.addProblem(r, "感染症").rec;
  r = R.addEntry(r, "p2", "plan", "培養を提出").rec;
  assert.deepEqual(r.problems[0].cert_log, [{ day: 1, certainty: "suspected" }, { day: 3, certainty: "confirmed" }]);
  assert.deepEqual(r.problems[0].plan[0].log, [{ day: 3, state: "done", reason: "救急から開始した" }]);
  assert.deepEqual([r.problems[1].added, r.problems[1].plan[0].added], [3, 3]);
  // changing it again the same day replaces that day's item (one per day)
  r = R.setEntry(r, "p1", "plan", "i2", { state: "changed", reason: "量を変更" });
  assert.deepEqual(r.problems[0].plan[0].log, [{ day: 3, state: "changed", reason: "量を変更" }]);
  // setting the same value again logs nothing new
  const same = R.setProblem(r, "p1", { certainty: "confirmed" });
  assert.deepEqual(same.problems[0].cert_log, r.problems[0].cert_log);
  // a reason edited alone is logged too
  assert.equal(R.setEntry(r, "p1", "plan", "i2", { reason: "量と回数を変更" }).problems[0].plan[0].log[0].reason, "量と回数を変更");
  assert.equal(C.setToday(r, 9999).course.today, 3, "a day outside 1..365 is ignored");
  assert.equal(C.nextDay(r), 4);
});

test("asOf: the record on an earlier day shows nothing added later and the judgements as they were then; the input is not touched", () => {
  let r = admission();
  r = C.setToday(r, 3);
  r = R.setProblem(r, "p1", { certainty: "confirmed" });
  r = R.setEntry(r, "p1", "plan", "i2", { state: "done", reason: "開始した" });
  r = R.addProblem(r, "感染症").rec;
  r = R.addEntry(r, "p2", "assess", "肺炎を疑う").rec;
  r = C.addTask(r, { text: "培養の結果", kind: "result" }).rec; // k1, day 3
  r = C.setToday(r, 5);
  r = C.setTask(r, "k1", { state: "done" });
  r = R.setEntry(r, "p1", "plan", "i2", { state: "stopped", reason: "中止した" });
  const before = snap(r);
  const d1 = C.asOf(r, 1);
  const d3 = C.asOf(r, 3);
  const d4 = C.asOf(r, 4);
  const d5 = C.asOf(r, 5);
  assert.equal(snap(r), before, "the input is not changed");
  assert.deepEqual(d1.problems.map((p: any) => [p.id, p.certainty, p.plan.map((e: any) => [e.id, e.state, e.reason])]), [["p1", "suspected", [["i2", "planned", undefined], ["i3", "planned", undefined]]]]);
  assert.deepEqual(d3.problems.map((p: any) => [p.id, p.certainty, p.plan.map((e: any) => [e.id, e.state, e.reason])]), [["p1", "confirmed", [["i2", "done", "開始した"], ["i3", "planned", undefined]]], ["p2", "", []]]);
  assert.deepEqual(d4.problems[0].plan.map((e: any) => e.state), ["done", "planned"], "day 4: the stop was recorded on day 5");
  assert.deepEqual(d5.problems[0].plan.map((e: any) => [e.state, e.reason]), [["stopped", "中止した"], ["planned", undefined]]);
  assert.deepEqual(d1.course.tasks, [], "a task added on day 3 is not there on day 1");
  assert.deepEqual(d4.course.tasks.map((k: any) => [k.id, k.state, "closed" in k]), [["k1", "open", false]], "closed on day 5: still open on day 4");
  assert.deepEqual(d5.course.tasks.map((k: any) => [k.id, k.state, k.closed]), [["k1", "done", 5]]);
  assert.equal(d3.course.today, 3);
  assert.equal(C.asOf(r, 9).course.today, 5, "a day after today shows today (nothing is invented)");
  assert.deepEqual(C.asOf(r, 2).problems[0].plan.map((e: any) => e.state), ["planned", "planned"]);
  // a plan whose first record is a later day was planned before it
  const late = C.setToday(admission(), 4);
  assert.equal(C.asOf(R.setEntry(late, "p1", "plan", "i3", { state: "done" }), 2).problems[0].plan[1].state, "planned");
});

// ---------------------------------------------------------------------------------- trends: the doctor's reading, blank when not chosen
test("trend: improved / unchanged / worse only when chosen; none is 'not assessed' (blank), never 'unchanged'; asOf gives the latest one on or before the day", () => {
  let r = admission();
  r = C.setTrend(r, 2, "p1", "improved", "解熱した");
  r = C.setTrend(r, 4, "p1", "worse");
  assert.deepEqual(r.course.days.map((d: any) => d.day), [2, 4]);
  assert.deepEqual(r.course.days[1].trend, { p1: { state: "worse" } });
  assert.equal(C.asOf(r, 1).problems[0].trend, null, "day 1: not assessed (blank)");
  assert.deepEqual(C.asOf(r, 2).problems[0].trend, { day: 2, state: "improved", note: "解熱した" });
  assert.deepEqual(C.asOf(r, 3).problems[0].trend, { day: 2, state: "improved", note: "解熱した" }, "day 3 has none of its own: the latest one before it, with its day");
  assert.deepEqual(C.asOf(r, 5).problems[0].trend, { day: 4, state: "worse" });
  // taking the choice back leaves nothing (blank), and a note alone is kept with no state
  assert.deepEqual(C.setTrend(r, 4, "p1", "").course.days.map((d: any) => d.day), [2], "the only choice of a day taken back: the day holds nothing and is not kept");
  const noteOnly = C.setTrend(C.setTrend(r, 4, "p1", ""), 4, "p1", undefined, "経過を見る");
  assert.deepEqual(noteOnly.course.days[1].trend, { p1: { state: "", note: "経過を見る" } });
  assert.equal(C.setTrend(r, 4, "p1", "sideways").course.days.find((d: any) => d.day === 4), undefined, "a state that is not one of the three is blank (and with no note, nothing is kept)");
  assert.deepEqual(C.setTrend(noteOnly, 4, "p1", "sideways").course.days[1].trend.p1, { state: "", note: "経過を見る" });
  assert.equal(snap(C.setTrend(r, 4, "p9", "worse")), snap(r), "an unknown problem is ignored");
  // removing a problem takes its trends and task links with it
  let k = C.addTask(r, { text: "x", problem: "p1" }).rec;
  k = R.removeProblem(k, "p1");
  assert.deepEqual(k.course.days, [], "and a day that held nothing else goes with them");
  assert.equal(k.course.tasks[0].problem, undefined);
});

// ---------------------------------------------------------------------------------- tasks
test("tasks: stamped with the working day; done is the doctor's and stamps its day; nothing is closed by itself; limits", () => {
  let r = C.setToday(admission(), 2);
  const made = C.addTask(r, { text: "  頭部 CT の結果  ", kind: "result", owner: "担当医", due: "入院3日目", problem: "p1" });
  r = made.rec;
  assert.equal(made.id, "k1");
  assert.deepEqual(r.course.tasks[0], { id: "k1", text: "頭部 CT の結果", kind: "result", owner: "担当医", due: "入院3日目", added: 2, state: "open", problem: "p1" });
  assert.deepEqual(C.addTask(r, { text: "x", kind: "nonsense", problem: "p9" }).rec.course.tasks[1], { id: "k2", text: "x", kind: "", owner: "", due: "", added: 2, state: "open" }, "a kind that was not chosen stays blank");
  r = C.setToday(r, 4);
  const done = C.setTask(r, "k1", { state: "done" });
  assert.deepEqual([done.course.tasks[0].state, done.course.tasks[0].closed], ["done", 4]);
  const reopened = C.setTask(done, "k1", { state: "open" });
  assert.ok(reopened.course.tasks[0].state === "open" && !("closed" in reopened.course.tasks[0]));
  assert.equal(C.setTask(r, "k1", { owner: "別の担当医", kind: "consult", problem: "p9" }).course.tasks[0].problem, undefined, "a problem that does not exist is cleared");
  assert.equal(C.setTask(r, "k9", { state: "done" }).course.tasks.length, 1);
  let full = r;
  for (let i = 0; i < C.COURSE_LIMITS.tasks; i++) full = C.addTask(full, { text: `t${i}` }).rec;
  assert.equal(C.addTask(full, { text: "one more" }).id, null);
});

// ---------------------------------------------------------------------------------- checks
test("checks: plans of an earlier day with no result recorded, tasks still open, trends not chosen — counted, never judged", () => {
  let r = admission();
  const ids = (x: any) => R.checks(x, {}).map((c: any) => c.id);
  assert.ok(!ids(r).includes("plan_unrecorded"), "on the day they were made the plans are just planned");
  r = C.setToday(r, 2);
  const c = R.checks(r, {}).find((x: any) => x.id === "plan_unrecorded");
  assert.match(c.text, /前の日までに立てた計画のうち、実施・変更・中止のどれも記録していないものが 2 件（予定のまま）/);
  assert.deepEqual(c.items, ["腎前性AKI: 細胞外液の輸液を検討", "腎前性AKI: 内服薬を見直す"]);
  r = R.setEntry(r, "p1", "plan", "i2", { state: "done", reason: "開始" });
  r = R.setEntry(r, "p1", "plan", "i3", { state: "stopped" });
  assert.ok(!ids(r).includes("plan_unrecorded"));
  assert.deepEqual(R.checks(r, {}).find((x: any) => x.id === "plan_reason").items, ["腎前性AKI: 内服薬を見直す"], "a stop with no reason is counted");
  r = R.setEntry(r, "p1", "plan", "i3", { reason: "他剤に変更済み" });
  assert.ok(!ids(r).includes("plan_reason"));
  // the trend: only once a day entry exists for the working day
  assert.ok(!ids(r).includes("trend_missing"));
  r = C.setDayField(r, 2, "interval", "特になし");
  assert.match(R.checks(r, {}).find((x: any) => x.id === "trend_missing").text, /入院2日目の推移（改善・不変・悪化）を選んでいない問題が 1 件（選ばなければ「未評価」です）/);
  r = C.setTrend(r, 2, "p1", "unchanged");
  assert.ok(!ids(r).includes("trend_missing"));
  // tasks
  r = C.addTask(r, { text: "培養の結果", kind: "result" }).rec;
  r = C.addTask(r, { text: "腎臓内科の返事", kind: "consult", owner: "主治医", due: "入院4日目" }).rec;
  assert.deepEqual(R.checks(r, {}).find((x: any) => x.id === "tasks_open").items, ["結果待ち: 培養の結果", "コンサルトの返事: 腎臓内科の返事"]);
  assert.deepEqual(R.checks(r, {}).find((x: any) => x.id === "tasks_incomplete").items, ["培養の結果（担当者・期限）"]);
  r = C.setTask(r, "k1", { state: "done" });
  assert.ok(!ids(r).includes("tasks_incomplete"));
  // the words: nothing that says normal / abnormal / late / ok
  for (const x of R.checks(r, {})) assert.ok(!/異常|正常|遅|問題なし|不足|警告|危険|要注意/.test(x.text + x.items.join("")), x.text);
});

// ---------------------------------------------------------------------------------- the progress note (A06) for a day
test("progress note: built as of its day — later certainty, plan states, trends, tasks and days are not in it; blanks say （未入力）", () => {
  let r = admission();
  r = C.setToday(r, 2);
  r = C.setDayField(r, 2, "interval", "夜間に38℃台の発熱があった");
  r = C.setDayField(r, 2, "objective", "BT 38.4℃、Cr 2.1 mg/dL（入院時 2.4）");
  r = C.setDayField(r, 2, "handover", "明朝の採血で Cr を確認する");
  r = C.setTrend(r, 2, "p1", "improved", "尿量が増えた");
  r = R.setEntry(r, "p1", "plan", "i2", { state: "done", reason: "開始した" });
  r = C.setToday(r, 5);
  r = R.setProblem(r, "p1", { certainty: "confirmed" });
  r = C.setDayField(r, 5, "interval", "退院調整を始めた");
  r = C.setTrend(r, 5, "p1", "worse", "再び悪化");
  r = R.setEntry(r, "p1", "plan", "i3", { state: "stopped", reason: "中止した" });
  const t2 = text(r, 2);
  assert.match(t2, /^【病棟日々の経過】下書き\n［日付］　［患者ID］　［氏名］/);
  assert.match(part(t2, "入院経過と現在の段階"), /入院2日目。脱水と腎機能の評価・加療のため/);
  assert.match(part(t2, "前回からのイベント"), /夜間に38℃台の発熱があった/);
  assert.match(part(t2, "身体所見・検査推移"), /BT 38\.4℃、Cr 2\.1 mg\/dL/);
  const ap2 = part(t2, "Problem別Assessment・Plan");
  assert.match(ap2, /［1\. 腎前性AKI（疑い）］\n推移（入院2日目）: 改善 — 尿量が増えた\n評価:\n・脱水と薬剤の関与を考える\n計画（予定・検討。実施の記録ではありません）:\n・内服薬を見直す\n実施（医師の記録）:\n・細胞外液の輸液を検討（理由: 開始した）/);
  assert.match(part(t2, "翌日確認・再評価・コール条件"), /明朝の採血で Cr を確認する/);
  for (const later of ["確定", "退院調整", "再び悪化", "中止した", "悪化"]) assert.ok(!t2.includes(later), `「${later}」は入院2日目の記載に入らない`);
  // the same record, day 5: the later things are there, the earlier day's are not repeated as today's
  const t5 = text(r, 5);
  assert.match(part(t5, "Problem別Assessment・Plan"), /［1\. 腎前性AKI（確定）］\n推移（入院5日目）: 悪化 — 再び悪化/);
  assert.match(part(t5, "前回からのイベント"), /退院調整を始めた/);
  assert.ok(!part(t5, "前回からのイベント").includes("夜間に38℃台"), "another day's text is not today's");
  assert.match(part(t5, "Problem別Assessment・Plan"), /中止・しない:\n・内服薬を見直す（理由: 中止した）/);
  // a day with nothing typed: the required fields are blank, never filled in
  const t4 = text(r, 4);
  assert.match(part(t4, "前回からのイベント"), /（未入力）/);
  assert.match(part(t4, "身体所見・検査推移"), /（未入力）/);
  assert.match(part(t4, "翌日確認・再評価・コール条件"), /（未入力）/);
  assert.match(part(t4, "Problem別Assessment・Plan"), /推移（入院2日目）: 改善 — 尿量が増えた/, "day 4 has no trend of its own: the latest before it, with its day");
  assert.ok(!/推移（入院4日目）/.test(t4));
  // not chosen is not written
  const blank = C.setDayField(admission(), 1, "interval", "入院時");
  assert.ok(!/推移（入院/.test(text(blank, 1)) && !/不変|安定/.test(text(blank, 1)), "no trend chosen: no 推移 line (not 不変, not 安定)");
});

test("progress note: AI-origin entries keep their mark, other note types are not affected, a date is never shown", () => {
  let r = R.addAdopted(R.newRecord(CASE), [{ role: "plan", heading: "初期プラン", text: "輸液を検討 [標準・出典未確認]", cites: [{ kind: "book", title: "T", page: "p.12" }] }, { role: "problems", heading: "問題リスト", text: "腎前性AKI" }]).rec;
  r = R.attach(R.attach(r, "a2", "new").rec, "a1", "p1").rec;
  r = C.setToday(r, 2);
  r = C.setDayField(r, 2, "interval", "10/22 から発熱。2026年10月23日に再検");
  const t = text(r, 2);
  assert.match(t, /〔AI草案〕輸液を検討/);
  assert.match(t, /※〔AI草案〕/);
  assert.ok(!/10\/2[0-9]|2026年|10月23日/.test(t), t);
  assert.ok(!text(r, 2, { aiMark: false, sourceMarks: false }).includes("〔AI草案〕"));
  // the case-based A06 of the note dialog is unchanged
  const plain = A.assemble("A06", { kase: CASE, items: [] });
  assert.match(plain.sections.find((s: any) => s.key === "interval").blocks[0].text, /3日前から腹痛/);
  // the admission note shows the admission day only: a problem added on day 3 is not in it
  let late = C.setToday(admission(), 3);
  late = R.addProblem(late, "感染症").rec;
  assert.ok(!A.toText(R.admissionNote(late)).includes("感染症"));
  assert.ok(!A.toText(N.progressNote(late, 3)).includes("感染症"), "a named problem with nothing recorded for the day has nothing to say in the A/P");
  const withTrend = C.setTrend(late, 3, "p2", "unchanged");
  assert.match(A.toText(N.progressNote(withTrend, 3)), /［2\. 感染症］\n推移（入院3日目）: 不変/, "once the doctor chooses a trend, it is there");
});

test("course texts are made relative with the rest of the record (days, trends, tasks, the history of a plan's reason)", () => {
  const now = new Date("2026-10-24T03:00:00Z");
  let r = C.setToday(admission(), 2);
  r = C.setDayField(r, 2, "interval", "10/22 から発熱");
  r = C.setTrend(r, 2, "p1", "improved", "2026年10月23日 から解熱");
  r = C.addTask(r, { text: "10/25 に再検", owner: "担当医", due: "11月2日" }).rec;
  r = R.setEntry(r, "p1", "plan", "i2", { state: "done", reason: "10月22日に開始" });
  const out = R.relativizeRecord(r, { now }).rec;
  const json = JSON.stringify(out);
  assert.ok(!/10\/2[0-9]|2026年|10月2[0-9]日|11月2日/.test(json), json);
  assert.equal(out.course.days[0].interval, "2日前 から発熱");
  assert.equal(out.course.tasks[0].due, "9日後");
});

// ---------------------------------------------------------------------------------- purity
test("case-course.js and record-notes.js are pure: no DOM, no network, no storage, no AI", () => {
  for (const f of ["case-course.js", "record-notes.js"]) {
    const src = readFileSync(web(f), "utf-8").replace(/\/\/[^\n]*/g, "");
    for (const bad of [/\bfetch\(/, /localStorage|sessionStorage|indexedDB/, /\bdocument\./, /\bwindow\./, /XMLHttpRequest|WebSocket/, /anthropic|api\/ask|\/api\//i]) assert.doesNotMatch(src, bad, f);
  }
  // the course module does not import the record module (no cycle: the record imports it)
  assert.doesNotMatch(readFileSync(web("case-course.js"), "utf-8"), /from "\.\/case-record\.js"/);
});
