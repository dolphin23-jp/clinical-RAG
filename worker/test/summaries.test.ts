// The interim summary (A07) and the discharge summary (A08) built from a case record: web/case-course.js (summary, discharge, medications,
// asOf) and web/record-notes.js (interimNote, dischargeNote).  Pinned: nothing recorded after the day of the note is in it, a discharge
// exists only when the doctor decided it and gave its day, a blank is "（未入力）" or "未入力" and never a sentence, what was not chosen
// is not written as chosen, and no calendar date is anywhere.
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
const interim = (rec: any, day?: number, opts: object = {}) => A.toText(N.interimNote(rec, day), opts);
const discharge = (rec: any, opts: object = {}) => A.toText(N.dischargeNote(rec), opts);
const part = (t: string, label: string) => t.split(`■${label}`)[1].split("\n■")[0];

/** Two problems over seven hospital days: day 3 is a turning point, a certainty is confirmed on day 5, a task opens on day 5, the discharge is day 7. */
function stay() {
  let r = R.newRecord(CASE);
  r = R.setAdm(r, "route", "脱水と腎機能の評価・加療のため");
  r = R.setAdm(r, "outlook", "尿量と Cr を毎日確認する");
  r = R.addProblem(r, "腎前性AKI").rec; // p1
  r = R.setProblem(r, "p1", { certainty: "suspected" });
  r = R.addEntry(r, "p1", "assess", "脱水と薬剤の関与を考える").rec; // i1
  r = R.addEntry(r, "p1", "plan", "細胞外液の輸液を検討").rec; // i2
  r = C.setToday(r, 3);
  r = C.setDayField(r, 3, "interval", "夜間に発熱");
  r = C.setDayField(r, 3, "handover", "朝に培養を確認する");
  r = C.setDayTurning(r, 3, true);
  r = C.setTrend(r, 3, "p1", "worse", "尿量低下");
  r = R.addProblem(r, "尿路感染症").rec; // p2, day 3
  r = C.setToday(r, 5);
  r = R.setProblem(r, "p1", { certainty: "confirmed", dx: "main" });
  r = R.setProblem(r, "p2", { dx: "sub" });
  r = R.setEntry(r, "p1", "plan", "i2", { state: "done", reason: "開始した" });
  r = C.setTrend(r, 5, "p1", "improved");
  r = C.addTask(r, { text: "培養の結果を確認", kind: "result", owner: "主治医", due: "入院6日目" }).rec; // k1, day 5
  return r;
}

// ---------------------------------------------------------------------------------- shape
test("cleanCourse: the interim texts, the discharge and its medications are cleaned; a discharge is decided only with a day", () => {
  const c = C.cleanCourse(
    {
      summary: { context: "  一般病棟へ  ", condition: "あ".repeat(2000), bogus: "x" },
      discharge: {
        decided: true,
        day: 7,
        dest: "自宅",
        state: "歩行可能",
        meds: [
          { id: "m1", text: "薬A", change: "stopped", reason: "副作用" },
          { id: "m2", text: "薬B", change: "bogus" },
          { id: "m1", text: "dup" },
          { id: "bad", text: "bad id" },
          { id: "m3", text: "" },
        ],
      },
    },
    [],
  );
  assert.equal(c.summary.context, "一般病棟へ");
  assert.equal(c.summary.condition.length, 800);
  assert.ok(!("bogus" in c.summary));
  assert.deepEqual([c.discharge.decided, c.discharge.day, c.discharge.dest, c.discharge.state], [true, 7, "自宅", "歩行可能"]);
  assert.deepEqual(c.discharge.meds.map((m: any) => [m.id, m.text, m.change, m.reason]), [["m1", "薬A", "stopped", "副作用"], ["m2", "薬B", "", undefined]], "an unknown change is blank, not guessed");
  assert.equal(C.cleanCourse({ discharge: { decided: true } }, []).discharge.decided, false, "decided with no day is not a discharge");
  assert.equal(C.cleanCourse({ discharge: { decided: true, day: 0 } }, []).discharge.decided, false);
  assert.equal(C.cleanCourse({ discharge: { decided: "yes", day: 3 } }, []).discharge.decided, false, "only the boolean true decides");
  assert.equal(C.cleanCourse({ discharge: { day: 3 } }, []).discharge.day, 3, "a day alone is kept (not decided)");
  const many = C.cleanCourse({ discharge: { meds: Array.from({ length: 80 }, (_, i) => ({ id: `m${i + 1}`, text: "t" })) } }, []);
  assert.equal(many.discharge.meds.length, C.COURSE_LIMITS.meds);
});

test("the record keeps the summary, the discharge, the medications and a problem's diagnosis class through a clean round trip", () => {
  let r = stay();
  r = C.setSummary(r, "handover", "病棟看護師へ申し送り");
  r = C.setDischarge(r, { decided: true, day: 7, dest: "自宅", procedures: "CT を施行" });
  r = C.addMed(r, { text: "薬A", change: "changed", reason: "腎機能" }).rec;
  const back = R.cleanRecord(JSON.parse(JSON.stringify(r)));
  assert.deepEqual(back, r);
  assert.equal(back.problems[0].dx, "main");
  assert.equal(back.seq.m, 1);
  assert.ok(!("dx" in R.setProblem(r, "p2", { dx: "bogus" }).problems[1]), "an unknown class is blank, not a class");
  assert.ok(!("dx" in R.setProblem(r, "p2", { dx: "" }).problems[1]), "the class can be cleared (blank)");
  assert.equal(R.cleanRecord({ ...JSON.parse(JSON.stringify(r)), problems: r.problems.map((p: any) => ({ ...p, dx: "bogus" })) }).problems[0].dx, undefined);
});

// ---------------------------------------------------------------------------------- the working functions
test("setDischarge: deciding stamps the working day when none is given; clearing the day undoes the decision; the texts are cut", () => {
  let r = C.setToday(stay(), 6);
  r = C.setDischarge(r, { decided: true });
  assert.deepEqual([r.course.discharge.decided, r.course.discharge.day], [true, 6]);
  r = C.setDischarge(r, { day: 8 });
  assert.deepEqual([r.course.discharge.decided, r.course.discharge.day], [true, 8]);
  r = C.setDischarge(r, { day: 0 });
  assert.deepEqual([r.course.discharge.decided, r.course.discharge.day], [false, null], "no day: not a discharge");
  r = C.setDischarge(r, { decided: false, followup: "あ".repeat(3000), dest: "  自宅  " });
  assert.equal(r.course.discharge.followup.length, 1000);
  assert.equal(r.course.discharge.dest, "自宅");
  assert.equal(C.setSummary(r, "context", "い".repeat(3000)).course.summary.context.length, 800);
  assert.equal(C.setSummary(r, "bogus", "x").course.summary.bogus, undefined);
});

test("medications: ids are stable and not reused; a blank change stays blank; a reason can be cleared; the list is limited", () => {
  let r = stay();
  const a = C.addMed(r, { text: "薬A" });
  r = C.addMed(a.rec, { text: "薬B", change: "continued" }).rec;
  assert.deepEqual(r.course.discharge.meds.map((m: any) => [m.id, m.change]), [["m1", ""], ["m2", "continued"]]);
  r = C.removeMed(r, "m1");
  assert.equal(C.addMed(r, { text: "薬C" }).id, "m3", "a removed id is not reused");
  r = C.setMed(r, "m2", { change: "stopped", reason: "副作用" });
  assert.deepEqual([r.course.discharge.meds[0].change, r.course.discharge.meds[0].reason], ["stopped", "副作用"]);
  r = C.setMed(r, "m2", { reason: "" });
  assert.ok(!("reason" in r.course.discharge.meds[0]));
  assert.equal(C.setMed(r, "m2", { change: "bogus" }).course.discharge.meds[0].change, "");
  let full = r;
  for (let i = 0; i < C.COURSE_LIMITS.meds; i++) full = C.addMed(full, { text: `t${i}` }).rec;
  assert.equal(C.addMed(full, { text: "one more" }).id, null);
});

test("checks: a medication changed or stopped with no reason, a medication with no class, the open tasks that a discharge would list — counted, never judged", () => {
  let r = stay();
  const ids = (x: any) => R.checks(x, {}).map((c: any) => c.id);
  assert.ok(!ids(r).includes("meds_reason") && !ids(r).includes("meds_unset"));
  r = C.addMed(r, { text: "薬A", change: "stopped" }).rec;
  r = C.addMed(r, { text: "薬B" }).rec;
  r = C.addMed(r, { text: "薬C", change: "continued" }).rec;
  assert.deepEqual(R.checks(r, {}).find((x: any) => x.id === "meds_reason").items, ["薬A"]);
  assert.deepEqual(R.checks(r, {}).find((x: any) => x.id === "meds_unset").items, ["薬B"]);
  assert.match(R.checks(r, {}).find((x: any) => x.id === "meds_unset").text, /選ばなければ「未記入」です/);
  r = C.setMed(r, "m1", { reason: "副作用" });
  assert.ok(!ids(r).includes("meds_reason"));
  r = C.addTask(r, { text: "返事待ち", owner: "", due: "" }).rec;
  assert.match(R.checks(r, {}).find((x: any) => x.id === "tasks_incomplete").text, /^担当者または期限が未入力の課題が 1 件/);
  r = C.setDischarge(r, { decided: true, day: 5 });
  assert.match(R.checks(r, {}).find((x: any) => x.id === "tasks_incomplete").text, /^退院時サマリーの「未解決」に載る課題のうち、担当者または期限が未入力の課題が 1 件/);
  for (const x of R.checks(r, {})) assert.ok(!/異常|正常|遅|問題なし|不足|警告|危険|要注意/.test(x.text + x.items.join("")), x.text);
});

// ---------------------------------------------------------------------------------- asOf
test("asOf: a discharge decided after the day is not known on that day; a task linked later to a problem is not linked earlier", () => {
  let r = stay();
  r = C.setDischarge(r, { decided: true, day: 7, dest: "自宅" });
  assert.equal(C.asOf(r, 6).course.discharge.decided, false);
  assert.equal(C.asOf(r, 6).course.discharge.dest, "", "its texts are not shown either");
  assert.deepEqual([C.asOf(r, 7).course.discharge.decided, C.asOf(r, 7).course.discharge.dest], [true, "自宅"]);
  let t = C.setToday(R.newRecord(CASE), 2);
  t = C.addTask(t, { text: "培養の確認" }).rec; // day 2
  t = C.setToday(t, 5);
  t = R.addProblem(t, "尿路感染症").rec; // p1, day 5
  t = C.setTask(t, "k1", { problem: "p1" });
  assert.equal(C.asOf(t, 2).course.tasks[0].problem, undefined, "on day 2 the problem did not exist");
  assert.equal(C.asOf(t, 5).course.tasks[0].problem, "p1");
});

// ---------------------------------------------------------------------------------- the interim summary (A07)
test("interim summary: only from a record; as of its day (nothing later), turning points, open tasks, blanks say （未入力）", () => {
  let r = stay();
  r = C.setSummary(r, "context", "一般病棟へ転棟");
  r = C.setSummary(r, "handover", "病棟看護師へ申し送り");
  assert.throws(() => A.assemble("A07", {}), /not offered/, "the typed-case picker does not offer A07");
  assert.ok(!A.ENABLED.includes("A07"));
  const t4 = interim(r, 4);
  assert.match(t4, /^【転棟・中間サマリ】下書き\n［日付］　［患者ID］　［氏名］\n※入院4日目の時点の記録です。確度・計画の状態・推移・課題の完了は、その日までに記録したものだけです。文章（問題名・評価・計画・先生が入力した文）は、最後に編集したものです。/);
  assert.match(part(t4, "転棟先・引継ぎ理由"), /一般病棟へ転棟/);
  assert.match(part(t4, "入院理由・初期病態"), /70代・男性・救急[\s\S]*脱水と腎機能の評価・加療のため/);
  assert.match(part(t4, "これまでの経過と転換点"), /入院3日目:\n・前回からのイベント: 夜間に発熱\n・推移 腎前性AKI: 悪化 — 尿量低下/);
  assert.ok(!part(t4, "これまでの経過と転換点").includes("朝に培養"), "the day's next-day plan is not a turning point's story");
  const ap4 = part(t4, "管理中のProblemと方針");
  assert.match(ap4, /［1\. 腎前性AKI（疑い）］\n推移（入院3日目）: 悪化 — 尿量低下\n評価:\n・脱水と薬剤の関与を考える\n計画（予定・検討。実施の記録ではありません）:\n・細胞外液の輸液を検討/);
  for (const later of ["確定", "尿路感染症", "改善", "培養の結果", "実施（医師の記録）", "開始した"]) assert.ok(!t4.includes(later), `「${later}」は入院4日目の中間サマリーに入らない`);
  for (const blank of ["現時点の呼吸・循環・意識等", "継続治療・デバイス", "結果待ち・未解決事項"]) assert.equal(part(t4, blank).trim(), "（未入力）", blank);
  assert.match(part(t4, "悪化時の再評価・連絡条件"), /尿量と Cr を毎日確認する/);
  assert.match(part(t4, "引継ぎ先・依頼・共有の状況"), /病棟看護師へ申し送り/);
  // day 6: the later things are in, each as it stood
  const t6 = interim(r, 6);
  assert.match(part(t6, "管理中のProblemと方針"), /［1\. 腎前性AKI（確定）］\n推移（入院5日目）: 改善/);
  assert.match(part(t6, "管理中のProblemと方針"), /実施（医師の記録）:\n・細胞外液の輸液を検討（理由: 開始した）/);
  assert.match(part(t6, "結果待ち・未解決事項"), /［未完了の課題（先生の記録）］\n・結果待ち: 培養の結果を確認（担当: 主治医／期限: 入院6日目）/);
  assert.ok(part(t6, "管理中のProblemと方針").includes("尿路感染症") === false, "a named problem with nothing recorded has nothing to say");
});

test("interim summary: no turning point marked is blank, not a summary; a task with no owner or due says 未入力; a closed task is not listed", () => {
  let r = stay();
  r = C.setDayTurning(r, 3, false);
  const t = interim(r, 6);
  assert.equal(part(t, "これまでの経過と転換点").trim(), "（未入力）");
  assert.ok(N.interimNote(r, 6).unfilled.includes("course"));
  r = C.addTask(r, { text: "コンサルトの返事", kind: "consult" }).rec;
  assert.match(interim(r, 6), /・コンサルトの返事: コンサルトの返事（担当: 未入力／期限: 未入力）/);
  r = C.setTask(r, "k1", { state: "done" }); // closed on day 5
  r = C.setTask(r, "k2", { state: "done" });
  assert.equal(part(interim(r, 6), "結果待ち・未解決事項").trim(), "（未入力）");
  assert.match(part(interim(r, 4), "結果待ち・未解決事項"), /（未入力）/, "on day 4 the day-5 task did not exist");
  // a turning day with nothing written is listed as such (the mark is the doctor's) and says so
  let e = C.setDayTurning(R.newRecord(CASE), 2, true);
  e = C.setToday(e, 2);
  assert.match(part(interim(e, 2), "これまでの経過と転換点"), /入院2日目: （未入力）/);
});

test("interim summary: AI marks and sources are kept, no calendar date is shown, the working day is the default", () => {
  let r = R.addAdopted(R.newRecord(CASE), [{ role: "plan", heading: "初期プラン", text: "輸液を検討 [標準・出典未確認]", cites: [{ kind: "book", title: "T", page: "p.12" }] }, { role: "problems", heading: "問題リスト", text: "腎前性AKI" }]).rec;
  r = R.attach(R.attach(r, "a2", "new").rec, "a1", "p1").rec;
  r = C.setToday(r, 3);
  r = C.setSummary(r, "condition", "10/22 から酸素不要。2026年10月23日に確認");
  const t = interim(r);
  assert.match(t, /^[^]*入院3日目の時点/, "default: the working day");
  assert.match(t, /〔AI草案〕輸液を検討/);
  assert.match(t, /※〔AI草案〕/);
  assert.ok(!/10\/2[0-9]|2026年|10月23日/.test(t), t);
  assert.ok(!interim(r, 3, { aiMark: false, sourceMarks: false }).includes("〔AI草案〕"));
});

// ---------------------------------------------------------------------------------- the discharge summary (A08)
test("discharge summary: none until the doctor decides the discharge and its day; then built as of that day", () => {
  let r = stay();
  r = C.setDischarge(r, { dest: "自宅" });
  assert.equal(N.dischargeNote(r), null, "texts without a decision are not a discharge");
  r = C.setDischarge(r, { decided: true, day: 7 });
  assert.ok(N.dischargeNote(r));
  assert.equal(N.dischargeNote(C.setDischarge(r, { decided: false })), null);
  assert.equal(N.dischargeNote(C.setDischarge(r, { day: 0 })), null);
  // a day earlier than what was recorded: what was recorded later is not in it
  const early = C.setDischarge(r, { day: 4 });
  const t4 = discharge(early);
  assert.match(t4, /入院1日目に入院、入院4日目に退院/);
  assert.match(t4, /※入院4日目の時点の記録です/);
  for (const later of ["改善", "培養の結果", "開始した"]) assert.ok(!t4.includes(later), `「${later}」は入院4日目の退院時サマリーに入らない`);
  // the class (主病名 / 副病名) is the doctor's choice for this summary, not a fact with a history; the certainty is the one chosen by the day
  assert.match(part(t4, "主病名・副病名・診断確度"), /主病名:\n1\. 腎前性AKI（確度: 疑い）/, "the certainty confirmed on day 5 is not in a day-4 summary");
});

test("discharge summary: the diagnoses are the ones the doctor classed, with the certainty chosen; the course shows what was chosen, day by day", () => {
  let r = stay();
  r = C.setDischarge(r, { decided: true, day: 7, dest: "自宅", procedures: "腹部 CT を施行", state: "歩行可能。食事摂取可", followup: "1 週間後に外来で Cr を確認" });
  r = C.setToday(r, 7);
  r = R.addProblem(r, "高血圧").rec; // p3, not classed
  r = R.setEntry(r, "p3", "assess", "i0", {});
  r = R.addEntry(r, "p3", "assess", "内服を継続").rec;
  const t = discharge(r);
  assert.match(t, /^【退院時サマリ】下書き/);
  assert.match(part(t, "入退院日・退院先"), /入院1日目に入院、入院7日目に退院[\s\S]*自宅/);
  const dx = part(t, "主病名・副病名・診断確度");
  assert.match(dx, /主病名:\n1\. 腎前性AKI（確度: 確定）/);
  assert.match(dx, /副病名:\n1\. 尿路感染症（確度: 未選択）/, "a certainty that was not chosen is shown as not chosen");
  assert.match(dx, /区分を選んでいない問題: 高血圧/);
  assert.match(part(t, "入院理由と現病歴"), /3日前から腹痛、嘔気[\s\S]*脱水と腎機能の評価・加療のため/);
  assert.match(part(t, "入院時状態"), /BP 92\/54[\s\S]*Cr 2\.4/);
  const course = part(t, "Problem別入院後経過");
  assert.match(course, /転換点（先生がマークした日）\］\n入院3日目:\n・前回からのイベント: 夜間に発熱/);
  assert.match(course, /［1\. 腎前性AKI（確定）］\n推移の記録:\n・入院3日目 悪化 — 尿量低下\n・入院5日目 改善/);
  assert.match(course, /［2\. 尿路感染症］\n（未入力）\n/, "a named problem with nothing recorded says so");
  assert.match(course, /実施（医師の記録）:\n・細胞外液の輸液を検討（理由: 開始した）/);
  assert.ok(!/推移（入院/.test(course), "the history replaces the latest-trend line");
  assert.match(part(t, "主要検査・処置"), /腹部 CT を施行/);
  assert.match(part(t, "退院時状態・残存課題"), /歩行可能。食事摂取可/);
  assert.match(part(t, "外来・在宅の方針"), /1 週間後に外来で Cr を確認/);
  assert.match(part(t, "結果待ち・担当者・確認期限"), /培養の結果を確認（担当: 主治医／期限: 入院6日目）/);
});

test("discharge summary: blanks stay blank; the medications show what the doctor chose and the reason or its absence", () => {
  let r = C.setDischarge(stay(), { decided: true, day: 7 });
  let t = discharge(r);
  assert.match(part(t, "入退院日・退院先"), /退院先（先生の入力）\］\n（未入力）/ , "no destination: shown as not entered");
  assert.equal(part(t, "外来・在宅の方針").trim(), "（未入力）");
  assert.ok(!t.includes("退院時処方・変更理由"), "no medication entered: the conditional field is left out");
  assert.ok(!t.includes("主要検査・処置"), "no procedure entered: the conditional field is left out");
  r = C.addMed(r, { text: "薬A", change: "stopped" }).rec;
  r = C.addMed(r, { text: "薬B" }).rec;
  r = C.addMed(r, { text: "薬C", change: "changed", reason: "腎機能に合わせて減量" }).rec;
  r = C.addMed(r, { text: "薬D", change: "continued" }).rec;
  r = C.addMed(r, { text: "薬E", change: "new", reason: "感染症のため" }).rec;
  t = discharge(r);
  const meds = part(t, "退院時処方・変更理由");
  assert.match(meds, /・薬A — 中止（理由: 未入力）/);
  assert.match(meds, /・薬B — 区分未記入\n/, "no class chosen: not written as new, changed, stopped or continued");
  assert.match(meds, /・薬C — 変更（理由: 腎機能に合わせて減量）/);
  assert.match(meds, /・薬D — 継続\n/, "a continued medication needs no reason, and none is made up");
  assert.match(meds, /・薬E — 新規（理由: 感染症のため）/);
  assert.ok(!/正常|異常|適切|問題なし/.test(t));
});

test("discharge summary: AI-origin items keep their mark in the diagnoses; no calendar date is shown; the other notes are unchanged", () => {
  let r = R.addAdopted(R.newRecord(CASE), [{ role: "problems", heading: "問題リスト", text: "腎前性AKI [推論]" }, { role: "plan", heading: "初期プラン", text: "輸液を検討", cites: [] }]).rec;
  r = R.attach(R.attach(r, "a1", "new").rec, "a2", "p1").rec;
  r = C.setToday(r, 5);
  r = R.setProblem(r, "p1", { certainty: "suspected", dx: "main" });
  r = C.setDischarge(r, { decided: true, day: 5, dest: "自宅", state: "10/22 に退院予定と説明。2026年10月23日に再確認" });
  const t = discharge(r);
  assert.match(part(t, "主病名・副病名・診断確度"), /1\. 〔AI草案〕腎前性AKI.*（確度: 疑い）/);
  assert.match(t, /※〔AI草案〕/);
  assert.ok(!/10\/2[0-9]|2026年|10月23日/.test(t), t);
  assert.ok(!discharge(r, { aiMark: false, sourceMarks: false }).includes("〔AI草案〕"));
  assert.equal(A.assemble("A08", { kase: CASE, items: [] }).asOf, null, "the typed-case A08 has no as-of line");
  assert.doesNotMatch(A.toText(A.assemble("A08", { kase: CASE, items: [] })), /時点の記録です/);
  assert.match(A.toText(R.admissionNote(r)), /^【病棟入院時】/);
});

test("the summary texts, the discharge texts and the medications are made relative with the rest of the record", () => {
  const now = new Date("2026-10-24T03:00:00Z");
  let r = C.setSummary(stay(), "handover", "10/25 に再診の予定");
  r = C.setDischarge(r, { dest: "11月2日に転院", followup: "2026年10月30日 に外来" });
  r = C.addMed(r, { text: "薬A", change: "changed", reason: "10月22日 から減量" }).rec;
  const out = R.relativizeRecord(r, { now }).rec;
  const json = JSON.stringify(out);
  assert.ok(!/10\/2[0-9]|2026年|10月2[0-9]日|11月2日/.test(json), json);
});

// ---------------------------------------------------------------------------------- the server accepts a record with all of this
test("a full record with a month of days, tasks, summary, discharge and medications is within the store's limits", async () => {
  const { check, MAX_RECORD_PAYLOAD } = await import(join(REPO, "worker", "src", "recordstore.ts"));
  let r = stay();
  for (let d = 1; d <= 30; d++) {
    r = C.setToday(r, d);
    for (const f of C.DAY_FIELDS) r = C.setDayField(r, d, f.key, "あ".repeat(f.max));
    r = C.setTrend(r, d, "p1", "improved", "い".repeat(400));
  }
  for (let i = 0; i < 40; i++) r = C.addTask(r, { text: "う".repeat(600), owner: "え".repeat(60), due: "お".repeat(60) }).rec;
  for (const f of C.SUMMARY_FIELDS) r = C.setSummary(r, f.key, "か".repeat(f.max));
  r = C.setDischarge(r, { decided: true, day: 30, ...Object.fromEntries(C.DISCHARGE_FIELDS.map((f: any) => [f.key, "き".repeat(f.max)])) });
  for (let i = 0; i < 40; i++) r = C.addMed(r, { text: "く".repeat(300), change: "changed", reason: "け".repeat(300) }).rec;
  const json = JSON.stringify(r);
  assert.ok(json.length < MAX_RECORD_PAYLOAD, `${json.length} < ${MAX_RECORD_PAYLOAD}`);
  assert.doesNotThrow(() => check(JSON.parse(json)));
  assert.deepEqual(R.cleanRecord(JSON.parse(json)).course.discharge.meds.length, 40);
});

// ---------------------------------------------------------------------------------- purity
test("record-notes.js builds the three notes from the record only: it reads no typed case's free-text field for the course", () => {
  const src = readFileSync(web("record-notes.js"), "utf-8").replace(/\/\/[^\n]*/g, "");
  for (const bad of [/\bfetch\(/, /localStorage|sessionStorage|indexedDB/, /\bdocument\./, /\bwindow\./, /XMLHttpRequest|WebSocket/, /anthropic|api\/ask|\/api\//i]) assert.doesNotMatch(src, bad);
  // none of the words of a verdict is in the builders
  assert.doesNotMatch(src, /正常|異常|遅れ|問題なし|適切/);
});
