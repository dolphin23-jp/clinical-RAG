// The summary of a case record that goes to the draft of a scene (web/record-brief.js, docs/enhancement-plan.md 8.16).
// Pinned: it is the record as it stood on one day (nothing later), a blank stays blank, an AI-draft line says so, the doctor's choices are
// copied and not judged, no calendar date is in it, it fits what the Worker takes, and the function touches nothing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BRIEF_LIMIT, parseBrief } from "../src/casemode.ts";
import { REPO } from "./nodeDb.ts";

const web = (f: string) => join(REPO, "web", f);
const R: any = await import(web("case-record.js"));
const C: any = await import(web("case-course.js"));
const B: any = await import(web("record-brief.js"));

const CASE = { age: "70代", sex: "男性", setting: "救急", complaint: "3日前から腹痛、嘔気", vitals: "BP 92/54, HR 108", findings: "Cr 2.4 mg/dL", history: "高血圧", own: "" };
const snap = (o: unknown) => JSON.stringify(o);

/** A record worked over three hospital days: two problems (one carried from an AI draft), plans, a trend, a task, a day's texts. */
function worked() {
  let r = R.newRecord(CASE);
  r = R.addAdopted(r, [{ role: "problems", heading: "問題リスト", text: "腎前性AKI [推論]", cites: [{ kind: "book", title: "T", page: "p.12" }] }, { role: "plan", heading: "初期プラン", text: "細胞外液の輸液を検討 [標準・出典未確認]" }]).rec;
  r = R.attach(r, "a1", "new").rec; // p1, AI-origin
  r = R.attach(r, "a2", "p1").rec; // an AI plan, planned
  r = R.setProblem(r, "p1", { certainty: "likely" });
  r = R.addEntry(r, "p1", "assess", "脱水と薬剤の関与を考える").rec; // the doctor's own
  r = R.addProblem(r, "糖尿病").rec; // p2: no certainty chosen
  r = C.setToday(r, 2);
  r = C.setDayField(r, 2, "interval", "夜間に発熱");
  r = C.setDayField(r, 2, "overall", "食事は半量");
  r = C.setTrend(r, 2, "p1", "improved", "尿量が増えた");
  r = C.addTask(r, { text: "血液培養の結果を確認", kind: "result" }).rec;
  r = R.addEntry(r, "p1", "plan", "内服薬を見直す").rec;
  r = R.setEntry(r, "p1", "plan", "i3", { state: "done", reason: "NSAIDs を中止した" });
  return r;
}

test("the summary is the record as it stood on the day: problems in order, the certainty as chosen, plans with their state, the trend the doctor chose, the open tasks, the day's own texts", () => {
  const { text, day, problems, tasks, truncated } = B.recordBrief(worked(), 2);
  assert.equal(day, 2);
  assert.equal(problems, 2);
  assert.equal(tasks, 1);
  assert.equal(truncated, false);
  assert.match(text, /^入院2日目の時点の記録（先生の記録。後日の事実は含みません）\n/);
  assert.match(text, /1\. 腎前性AKI \[推論\]（AI草案を採用したもの） — 確度: 可能性が高い/);
  assert.match(text, /推移（入院2日目に先生が選んだもの）: 改善 — 尿量が増えた/);
  assert.match(text, /評価: ・脱水と薬剤の関与を考える\n/);
  assert.match(text, /計画: ・予定・検討: 細胞外液の輸液を検討 \[標準・出典未確認\]（AI草案を採用したもの）/);
  assert.match(text, /計画: ・実施（医師の記録）: 内服薬を見直す（理由: NSAIDs を中止した）/);
  assert.match(text, /2\. 糖尿病 — 確度: 未選択/);
  assert.match(text, /入院2日目の先生の記録:\n  前回からのイベント: 夜間に発熱\n  患者全体の状態: 食事は半量/);
  assert.match(text, /未完了の課題（先生の記録）:\n  ・結果待ち: 血液培養の結果を確認（担当: 未入力／期限: 未入力）/);
  // the doctor's own lines are not marked as a draft's
  assert.doesNotMatch(text, /脱水と薬剤の関与を考える（AI草案を採用したもの）/);
  assert.doesNotMatch(text, /内服薬を見直す（AI草案を採用したもの）/);
});

test("a blank stays blank: no certainty, no trend, no owner or due is filled in", () => {
  let r = R.newRecord(CASE);
  r = R.addProblem(r, "糖尿病").rec;
  const t = B.recordBrief(r, 1).text;
  assert.match(t, /1\. 糖尿病 — 確度: 未選択/);
  assert.doesNotMatch(t, /推移/, "a trend nobody chose has no line");
  assert.doesNotMatch(t, /不変|改善|悪化|安定/, "no state is made up");
  assert.doesNotMatch(t, /課題/, "no task, no heading for tasks");
  // a record with nothing says so, and still has its head
  const empty = B.recordBrief(R.newRecord(CASE), 1).text;
  assert.equal(empty, "入院1日目の時点の記録（先生の記録。後日の事実は含みません）\n問題: 記録にはまだありません");
});

test("nothing recorded after the day is in it: a later problem, certainty, plan state, trend, task and day text", () => {
  let r = worked();
  r = C.setToday(r, 4);
  r = R.setProblem(r, "p1", { certainty: "confirmed" });
  r = R.addProblem(r, "後から立てた問題").rec;
  r = R.setEntry(r, "p1", "plan", "i1", { state: "stopped", reason: "尿量が回復した" });
  r = C.setTrend(r, 4, "p1", "worse", "再び悪化");
  r = C.setDayField(r, 4, "interval", "四日目の出来事");
  r = C.addTask(r, { text: "四日目の課題", kind: "other" }).rec;
  const t2 = B.recordBrief(r, 2).text;
  assert.match(t2, /確度: 可能性が高い/);
  assert.doesNotMatch(t2, /確定|後から立てた問題|中止・しない|尿量が回復した|再び悪化|四日目/);
  assert.match(t2, /推移（入院2日目に先生が選んだもの）: 改善/);
  const t4 = B.recordBrief(r, 4).text;
  assert.match(t4, /確度: 確定/);
  assert.match(t4, /3\. 後から立てた問題/);
  assert.match(t4, /中止・しない: 細胞外液の輸液を検討/);
  assert.match(t4, /推移（入院4日目に先生が選んだもの）: 悪化 — 再び悪化/);
  // a task done by the day is not open on it
  r = C.setTask(r, "k1", { state: "done" });
  assert.match(B.recordBrief(r, 2).text, /血液培養の結果を確認/, "it was open on day 2");
  assert.doesNotMatch(B.recordBrief(r, 4).text, /血液培養の結果を確認/, "it is closed by day 4");
});

test("the day of a scene's summary: the working day, or the discharge day once the doctor has decided the discharge", () => {
  let r = worked();
  r = C.setToday(r, 3);
  assert.equal(B.briefDay(r, "prog"), 3);
  assert.equal(B.briefDay(r, "dc"), 3);
  r = C.setDischarge(r, { decided: true, day: 5 });
  assert.equal(B.briefDay(r, "dc"), 5);
  assert.equal(B.briefDay(r, "prog"), 3, "only the discharge summary follows the discharge day");
  assert.equal(B.recordBrief(r, B.briefDay(r, "dc")).day, 5);
});

test("no calendar date is in it, and no judging word is added to what the doctor wrote", () => {
  let r = worked();
  r = R.addEntry(r, "p2", "assess", "2026/10/20 に入院、10月22日 から血糖が高め").rec;
  const t = B.recordBrief(r, 2).text;
  assert.doesNotMatch(t, /2026|10\/20|10月22日/);
  // the words the summary adds itself carry no verdict (the doctor's own words are copied as they are)
  const own = B.recordBrief(R.addProblem(R.newRecord(CASE), "").rec, 1).text;
  assert.doesNotMatch(own + t.replace(/脱水と薬剤の関与を考える|細胞外液の輸液を検討|内服薬を見直す|NSAIDs を中止した|夜間に発熱|食事は半量|尿量が増えた|血液培養の結果を確認|血糖が高め/g, ""), /正常|異常|遅れ|遅い|早い|基準値|閾値|重症度|軽症|重症/);
});

test("it fits what the Worker takes: a heavy record is cut shorter, then its last problems are left out and the text says how many; the first problem always stays", () => {
  let r = R.newRecord(CASE);
  for (let i = 0; i < 20; i++) {
    r = R.addProblem(r, `問題${i + 1} ${"名".repeat(60)}`).rec;
    for (let j = 0; j < 8; j++) r = R.addEntry(r, `p${i + 1}`, j % 2 ? "plan" : "assess", `${"あ".repeat(500)}${i}-${j}`).rec;
  }
  const b = B.recordBrief(r, 1);
  assert.ok(b.text.length <= BRIEF_LIMIT, String(b.text.length));
  assert.equal(b.truncated, true);
  assert.ok(b.omitted > 0);
  assert.match(b.text, new RegExp(`（長いため、優先順位の低い問題 ${b.omitted} 件は渡していません）`));
  assert.match(b.text, /1\. 問題1 /);
  assert.doesNotMatch(b.text, /問題20 /, "the last problem is the first to go");
  assert.equal(parseBrief(b.text), b.text.trim(), "the Worker takes it");
  // a small limit is honoured too
  assert.ok(B.recordBrief(worked(), 2, { limit: 300 }).text.length <= 300);
  // an ordinary record is not cut
  assert.equal(B.recordBrief(worked(), 2).truncated, false);
});

test("it changes nothing and gives the same text for the same record", () => {
  const r = worked();
  const before = snap(r);
  const a = B.recordBrief(r, 2);
  const b = B.recordBrief(r, 2);
  assert.equal(snap(r), before);
  assert.deepEqual(a, b);
});

test("pins: the summary code reaches no server, no storage and no screen; it imports only the record's own pure modules", () => {
  const src = readFileSync(web("record-brief.js"), "utf-8").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|indexedDB|document\.|window\.|innerHTML|navigator\.|\beval\s*\(|new Function/);
  assert.deepEqual([...src.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]), ["./case-record.js", "./case-course.js", "./draft-scenes.js"]);
});
