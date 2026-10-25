// The outpatient record (docs/enhancement-plan.md 8.19): web/case-record.js (kind, start, pastePlan), web/case-course.js (day labels, the visit's fields),
// web/record-notes.js (the revisit note A02 and the first-visit note A01 built from the record).  Pinned: no calendar date anywhere, a blank stays
// blank, a plan is "planned" until the doctor records otherwise, nothing recorded later is in the note of an earlier visit, the previous plan is shown
// with what the doctor recorded about it (never as done or not done by itself), and an admission's record is exactly what it was.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { handle } from "../src/handler.ts";
import { scanAll } from "../src/idguard.ts";
import { buildFixtureDb, openDb, openRw, REPO } from "./nodeDb.ts";

const web = (f: string) => join(REPO, "web", f);
const R: any = await import(web("case-record.js"));
const C: any = await import(web("case-course.js"));
const N: any = await import(web("record-notes.js"));
const A: any = await import(web("note-assemble.js"));
const S: any = await import(web("flow-schema.js"));
const I: any = await import(web("intake.js"));

const CASE = { age: "58", sex: "女性", setting: "外来", complaint: "高血圧と腎機能の経過観察。", vitals: "", findings: "Cr 1.2 mg/dL", history: "糖尿病", own: "" };
const text = (note: any, opts: object = {}) => A.toText(note, opts);
const part = (t: string, label: string) => t.split(`■${label}`)[1].split("\n■")[0];

/** A record that began at a revisit: the last plan pasted, then a visit 28 days after the base day. */
function revisitRecord() {
  let r = R.newRecord(CASE, { kind: "outpatient", start: "revisit" });
  const p = R.pastePlan(r, null, "- 降圧薬を継続する\n2. 2週間後に採血\n・食事指導", "高血圧・腎機能");
  r = p.rec; // p1; i1..i3 on day 1
  r = R.setProblem(r, "p1", { certainty: "likely" }); // today = 2: stamped day 2
  return r;
}

// ---------------------------------------------------------------------------------- the record's shape
test("kind: an outpatient record says so and how it began; an admission's record carries neither (and is what it always was)", () => {
  const first = R.newRecord(CASE, { kind: "outpatient", start: "first" });
  assert.equal(first.kind, "outpatient");
  assert.equal(first.start, "first");
  assert.equal(first.course.today, 1);
  assert.match(first.title, /^外来: /);
  const revisit = R.newRecord(CASE, { kind: "outpatient", start: "revisit" });
  assert.equal(revisit.start, "revisit");
  assert.equal(revisit.course.today, 2, "a record that begins at a revisit works on the day after the base day");
  const adm = R.newRecord({ ...CASE, setting: "救急" });
  assert.ok(!("kind" in adm) && !("start" in adm), "an admission's record is unchanged");
  assert.ok(!adm.title.startsWith("外来"));
  // read back from the server: a kind that is not one of the two is an admission's; `start` is one of two words
  assert.equal(R.cleanRecord({ ...first, kind: "weird" }).kind, undefined);
  assert.equal(R.cleanRecord({ ...first, start: "weird" }).start, "first");
  assert.deepEqual(R.cleanRecord(JSON.parse(JSON.stringify(revisit))), revisit);
  assert.equal(R.isOutpatient(revisit), true);
  assert.equal(R.isOutpatient(adm), false);
  // editing the case keeps the kind and the title's prefix
  assert.match(R.setCase(first, { ...CASE, complaint: "別の主訴" }).title, /^外来: /);
});

test("days: the base day is 基準日 and later ones are N days after it; an admission's days are still 入院N日目; a day's entry keeps the visit's purpose", () => {
  const out = { kind: "outpatient" };
  assert.deepEqual([1, 2, 29].map((n) => C.dayLabelFor(out, n)), ["基準日", "基準日から1日後", "基準日から28日後"]);
  assert.deepEqual([1, 3].map((n) => C.dayLabelFor({}, n)), ["入院1日目", "入院3日目"]);
  let r = revisitRecord();
  r = C.setToday(r, 29);
  r = C.setDayField(r, 29, "purpose", "血圧と腎機能の再評価");
  assert.equal(r.course.days[0].purpose, "血圧と腎機能の再評価");
  assert.equal(R.cleanRecord(JSON.parse(JSON.stringify(r))).course.days[0].purpose, "血圧と腎機能の再評価");
  // a day that holds only a purpose is a day; clearing it removes the day
  assert.equal(C.setDayField(r, 29, "purpose", "").course.days.length, 0);
  // an admission's day entries gain an empty `purpose` and lose nothing
  const adm = C.setDayField(R.newRecord({ ...CASE, setting: "救急" }), 1, "interval", "発熱が続く");
  assert.equal(adm.course.days[0].purpose, "");
  assert.equal(adm.course.days[0].interval, "発熱が続く");
  assert.equal(C.OUTPATIENT_DAY_FIELDS.map((f: any) => f.key).join(), "purpose,interval,subjective,objective,handover");
});

// ---------------------------------------------------------------------------------- the last plan, pasted
test("pastePlan: each line is a plan entry of the base day, planned, in the doctor's words; list marks go; the room is respected; nothing is made without the doctor's act", () => {
  let r = R.newRecord(CASE, { kind: "outpatient", start: "revisit" });
  const made = R.pastePlan(r, null, "・降圧薬を継続\n\n  1) 2週間後に採血  \n- 食事指導", "高血圧");
  assert.equal(made.added, 3);
  assert.equal(made.left, 0);
  r = made.rec;
  const p = r.problems[0];
  assert.deepEqual([p.id, p.label, p.added, p.from], ["p1", "高血圧", 1, "typed"]);
  assert.deepEqual(p.plan.map((e: any) => [e.id, e.text, e.state, e.from, e.added]), [["i1", "降圧薬を継続", "planned", "typed", 1], ["i2", "2週間後に採血", "planned", "typed", 1], ["i3", "食事指導", "planned", "typed", 1]]);
  // to an existing problem; the room is LIMITS.entries a problem and the lines past it are said, not added
  const many = R.pastePlan(r, "p1", Array.from({ length: 12 }, (_, i) => `方針${i}`).join("\n"));
  assert.equal(many.added, R.LIMITS.entries - 3);
  assert.equal(many.left, 3);
  assert.equal(many.rec.problems[0].plan.length, R.LIMITS.entries);
  // an unknown problem, or nothing to paste: nothing changes
  assert.equal(R.pastePlan(r, "p9", "x").rec, r);
  assert.equal(R.pastePlan(r, null, " \n \n").added, 0);
  // ids are not reused (a removed problem's number is gone)
  const gone = R.removeProblem(r, "p1");
  assert.equal(R.pastePlan(gone, null, "新しい方針").id, "p2");
  // a date in what was pasted is made relative when the record is saved (no calendar date is kept)
  const dated = R.pastePlan(R.newRecord(CASE, { kind: "outpatient", start: "revisit" }), null, "2026年10月20日に採血、次回は11月5日", "高血圧").rec;
  const rel = R.relativizeRecord(dated, { now: new Date("2026-10-25T00:00:00") });
  assert.ok(rel.changes.length >= 1);
  assert.doesNotMatch(JSON.stringify(rel.rec), /2026年|10月20日|11月5日/);
});

// ---------------------------------------------------------------------------------- the revisit note (A02)
test("A02: the previous plan with what the doctor recorded since; today's plan and the trend; the visit's own words; every blank is （未入力）", () => {
  let r = revisitRecord();
  r = C.setToday(r, 29); // 28 days after the base day
  r = R.setEntry(r, "p1", "plan", "i1", { state: "done" }); // 降圧薬を継続: done (recorded on day 29)
  r = R.setEntry(r, "p1", "plan", "i2", { state: "changed", reason: "腎機能を見て4週後に延ばした" });
  // i3 (食事指導) is left: no record
  r = R.addEntry(r, "p1", "plan", "降圧薬を1段階増量する").rec; // i4, added on day 29
  r = R.addEntry(r, "p1", "assess", "家庭血圧は高め、腎機能は横ばい").rec; // i5
  r = C.setTrend(r, 29, "p1", "worse", "家庭血圧が上がっている");
  r = C.setDayField(r, 29, "purpose", "血圧と腎機能の再評価");
  r = C.setDayField(r, 29, "interval", "内服は続けられていた。");
  r = C.setDayField(r, 29, "subjective", "ときどき頭痛。");
  r = C.setDayField(r, 29, "objective", "家庭血圧の平均は日によって上下。Cr 1.3 mg/dL");
  r = C.setDayField(r, 29, "handover", "悪化時は早めに受診するよう説明。");
  r = C.addTask(r, { text: "次回の採血で腎機能", kind: "followup", owner: "担当医", due: "基準日から4週後" }).rec;
  const note = N.revisitNote(r, 29);
  const t = text(note);
  assert.equal(note.type.id, "A02");
  assert.deepEqual(note.sections.map((s: any) => s.key), ["context", "previous_plan", "interval", "subjective", "objective", "problem_ap", "followup"]);
  assert.match(t, /^【外来再診】下書き\n［日付］　［患者ID］　［氏名］\n※基準日から28日後の時点の記録です。/);
  assert.match(part(t, "再診目的"), /基準日から28日後（前回: 基準日）/);
  assert.match(part(t, "再診目的"), /血圧と腎機能の再評価/);
  const prev = part(t, "前回方針と実施結果");
  assert.match(prev, /実施（医師の記録）:\n・降圧薬を継続する/);
  assert.match(prev, /変更（医師の記録）:\n・2週間後に採血（理由: 腎機能を見て4週後に延ばした）/);
  assert.match(prev, /計画（予定・検討。実施の記録ではありません）:\n・食事指導/, "an entry with nothing recorded stays planned: it is not called done and not called not done");
  assert.ok(!prev.includes("降圧薬を1段階増量"), "today's plan is not the previous plan");
  const ap = part(t, "Problem別Assessment・Plan");
  assert.match(ap, /推移（基準日から28日後）: 悪化 — 家庭血圧が上がっている/);
  assert.match(ap, /評価:\n・家庭血圧は高め、腎機能は横ばい/);
  assert.match(ap, /計画（予定・検討。実施の記録ではありません）:\n・降圧薬を1段階増量する/);
  assert.ok(!ap.includes("食事指導") && !ap.includes("降圧薬を継続する"), "the old plan is under the previous plan, once");
  assert.match(part(t, "前回からの経過"), /内服は続けられていた。/);
  assert.match(part(t, "現在の症状"), /ときどき頭痛。/);
  assert.match(part(t, "所見・検査トレンド"), /Cr 1\.3 mg\/dL/);
  const follow = part(t, "再診・再検査・悪化時対応");
  assert.match(follow, /悪化時は早めに受診するよう説明。/);
  assert.match(follow, /フォロー: 次回の採血で腎機能（担当: 担当医／期限: 基準日から4週後）/);
  assert.ok(!t.includes("入院"), "an outpatient record's notes never say 入院N日目");
  assert.doesNotMatch(t, /20\d\d[-/年]\d/, "no calendar date");
});

test("A02: nothing recorded later is in the note of an earlier visit; a blank stays （未入力）, never normal, never unchanged", () => {
  let r = revisitRecord();
  r = C.setToday(r, 15);
  r = C.setDayField(r, 15, "purpose", "2週間後の確認");
  r = C.setToday(r, 29);
  r = R.setEntry(r, "p1", "plan", "i1", { state: "stopped", reason: "副作用の訴え" }); // recorded on day 29
  r = R.setProblem(r, "p1", { certainty: "confirmed" }); // day 29
  r = C.setTrend(r, 29, "p1", "improved");
  r = C.setDayField(r, 29, "subjective", "頭痛は消えた");
  const early = text(N.revisitNote(r, 15));
  assert.match(part(early, "前回方針と実施結果"), /計画（予定・検討。実施の記録ではありません）:\n・降圧薬を継続する/, "on day 15 the plan was still planned");
  assert.ok(!early.includes("中止") && !early.includes("副作用"), "the stop recorded on day 29 is not in day 15's note");
  assert.ok(!early.includes("確定") && !early.includes("改善") && !early.includes("頭痛は消えた"));
  assert.match(part(early, "再診目的"), /基準日から14日後（前回: 基準日）/);
  assert.ok(!early.includes("■現在の症状"), "a conditional field with nothing is left out");
  assert.match(part(early, "前回からの経過"), /（未入力）/, "a required field with nothing says so");
  assert.match(part(early, "所見・検査トレンド"), /（未入力）/);
  assert.match(part(early, "Problem別Assessment・Plan"), /（未入力）/);
  assert.ok(!/推移（/.test(early), "no trend was chosen by day 15: no trend line, no 不変, no 安定");
  assert.doesNotMatch(early, /不変|安定|正常/);
  // day 29: the previous visit is day 15 (the latest earlier visit with an entry), so the plan of day 15 and before is the previous plan
  const late = text(N.revisitNote(r, 29));
  assert.match(part(late, "再診目的"), /基準日から28日後（前回: 基準日から14日後）/);
  assert.match(part(late, "前回方針と実施結果"), /中止・しない:\n・降圧薬を継続する（理由: 副作用の訴え）/);
});

test("A02: an AI-origin plan entry keeps its mark in the previous plan; the marks can be left out of the copy, the doctor's own words never carry one", () => {
  let r = R.newRecord(CASE, { kind: "outpatient", start: "first" });
  r = R.addAdopted(r, [{ role: "plan", heading: "初期プラン", text: "家庭血圧の記録を始める [標準・出典未確認]", cites: [{ kind: "book", title: "架空内科ハンドブック", page: "p.10" }] }, { role: "problems", heading: "問題リスト", text: "高血圧", cites: [] }]).rec;
  r = R.attach(r, "a2", "new").rec; // p1 from the AI's problem list
  r = R.attach(r, "a1", "p1").rec; // the plan arrives planned, from: "ai"
  r = C.setToday(r, 15);
  const note = N.revisitNote(r, 15);
  const withMarks = text(note);
  assert.match(part(withMarks, "前回方針と実施結果"), /・〔AI草案〕家庭血圧の記録を始める/);
  assert.match(part(withMarks, "前回方針と実施結果"), /〔AI草案〕高血圧/, "the problem's name keeps the mark too");
  const plain = text(note, { aiMark: false, sourceMarks: false });
  assert.doesNotMatch(plain, /AI草案|\[標準・出典未確認\]|書籍 p\.10/);
  // the entry is never "done" on its own
  assert.doesNotMatch(withMarks, /実施（医師の記録）/);
});

test("A02: the base day is not a revisit (its note is the first visit's), and the working day starts after it for a record that began at a revisit", () => {
  const r = revisitRecord();
  assert.equal(r.course.today, 2);
  assert.equal(N.previousVisit(r, 2), 1);
  let q = C.setDayField(C.setToday(r, 10), 10, "purpose", "x");
  q = C.setDayField(C.setToday(q, 30), 30, "purpose", "y");
  assert.equal(N.previousVisit(q, 30), 10);
  assert.equal(N.previousVisit(q, 10), 1);
  assert.equal(N.previousVisit(q, 1), 1);
  assert.equal(N.firstVisitNote(r), null, "a record that began at a revisit has no first visit in it");
  assert.equal(N.firstVisitNote(R.newRecord({ ...CASE, setting: "救急" })), null, "an admission's record has none either");
});

// ---------------------------------------------------------------------------------- the first-visit note (A01)
test("A01 from the record: the case as typed, the flow answers routed to A01's fields, and the adopted items the doctor carried to the board", () => {
  const flow = S.FLOWS["outpatient-first-visit.fever"];
  const answers = { first: "sick", duration: "acute", problem_line: "急性の発熱" };
  const kase: any = { ...CASE, complaint: "発熱", intake: { flow: flow.id, answers } };
  kase.structured = I.renderStructured(flow, answers, kase);
  let r = R.newRecord(kase, { kind: "outpatient", start: "first" });
  r = R.addAdopted(r, [{ role: "plan", heading: "初期プラン", text: "解熱薬を使う", cites: [] }, { role: "assessment", heading: "各問題の評価", text: "ウイルス性を考える", cites: [] }]).rec;
  r = R.addProblem(r, "発熱").rec;
  r = R.attach(r, "a1", "p1").rec; // carried; a2 is left undecided
  const note = N.firstVisitNote(r, flow);
  const t = text(note);
  assert.equal(note.type.id, "A01");
  assert.match(part(t, "初期安全評価"), /第一印象：sick/);
  assert.match(part(t, "現病歴・時間経過"), /期間：急性/);
  assert.match(t, /〔AI草案〕解熱薬を使う/, "the carried item is in, marked");
  assert.ok(!t.includes("ウイルス性を考える"), "an adopted item the doctor did not carry is not in");
  assert.doesNotMatch(t, /入院\d+日目/);
  // without the flow structure the answers are kept whole, not guessed into fields
  assert.equal(N.firstVisitNote(r, null).routing.fromText, true);
});

// ---------------------------------------------------------------------------------- the checks
test("checks: the same counts in the outpatient words; nothing about the admission note; no word of judgement", () => {
  let r = revisitRecord();
  r = C.setToday(r, 29);
  r = C.setDayField(r, 29, "purpose", "再評価");
  const list = R.checks(r, S.FLOWS);
  const by = Object.fromEntries(list.map((c: any) => [c.id, c.text]));
  assert.match(by.plan_unrecorded, /^前回までに立てた計画のうち、実施・変更・中止のどれも記録していないものが 3 件（予定のまま）/);
  assert.match(by.trend_missing, /^基準日から28日後の推移（改善・不変・悪化）を選んでいない問題が 1 件/);
  assert.ok(!("unfilled" in by), "the admission note's blanks are not counted for an outpatient record");
  assert.ok(!Object.values(by).some((x: any) => x.includes("入院")));
  assert.equal(R.checks(R.newRecord(CASE, { kind: "outpatient", start: "revisit" }), S.FLOWS).find((c: any) => c.id === "no_problems").text.includes("再診"), true);
  const all = JSON.stringify(list);
  assert.doesNotMatch(all, /正常|異常|遅れ|遅い|早い|良好|問題なし/);
  // an admission's record keeps its words
  const adm = R.checks(R.newRecord({ ...CASE, setting: "救急" }), S.FLOWS);
  assert.ok(adm.some((c: any) => c.id === "unfilled"));
});

// ---------------------------------------------------------------------------------- the server and the pins
test("the Worker keeps an outpatient record like any other: it reads no part of it (kind, start, purpose are just keys), and refuses an identifier in it", async () => {
  const rw = openRw();
  const deps = { db: openDb(buildFixtureDb()), apiKey: "k", appToken: "test-token-0123456789abcdef", model: "m", rw: rw as any };
  const call = (path: string, init: RequestInit = {}) => handle(new Request(`http://x${path}`, { ...init, headers: { authorization: "Bearer test-token-0123456789abcdef", "content-type": "application/json" } }), deps);
  let r = revisitRecord();
  r = C.setToday(r, 29);
  r = C.setDayField(r, 29, "purpose", "血圧の再評価");
  const put = await call("/api/records/r0123456789abcdef0123456789abcd", { method: "PUT", body: JSON.stringify({ record: r }) });
  assert.equal(put.status, 200);
  const got: any = await (await call("/api/records/r0123456789abcdef0123456789abcd")).json();
  assert.deepEqual(R.cleanRecord(got.record), r);
  const bad = C.setDayField(r, 29, "purpose", "患者ID 123456 の再診");
  assert.equal((await call("/api/records/r0123456789abcdef0123456789abcd", { method: "PUT", body: JSON.stringify({ rev: got.rev, record: bad }) })).status, 400);
  assert.ok(scanAll(["患者ID 123456"]).length > 0);
});

test("pins: the outpatient record reaches no server of its own, keeps nothing in the browser, and is kept out of the Casebook packet and the scenes' summaries", () => {
  const ui = readFileSync(web("record-ui.js"), "utf-8").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(ui, /localStorage|sessionStorage|indexedDB/);
  assert.match(ui, /外来の記録は、Casebook へは送れません/);
  // the scenes after the admission do not follow an outpatient record
  assert.match(ui, /const recordFor = \(kase\) => \(S\.rec && S\.id && !S\.unlinking && !isOutpatient\(S\.rec\)/);
  for (const f of ["case-record.js", "case-course.js", "record-notes.js"]) assert.doesNotMatch(readFileSync(web(f), "utf-8").replace(/\/\/[^\n]*/g, ""), /\bfetch\s*\(|localStorage|sessionStorage|new Date\(\)\.to|toISOString|Date\.now/, f);
});
