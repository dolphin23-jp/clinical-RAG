// The books' pages kept for a problem (docs/enhancement-plan.md 8.16): web/case-record.js (refs, pinRef, unpinRef, refsOf), asOf, the discharge
// summary's lines, the record store.  Pinned: only where to look is kept (a title, a page, a section's name; never a line of the book), a page is
// one page however it came, a page left after a day is not in that day's view, the discharge summary says what the pages are and are not, and
// the copy without the marks of origin leaves them out.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import type { Db } from "../src/db.ts";
import { handle, type AppDeps } from "../src/handler.ts";
import { MAX_DEPTH, MAX_RECORD_PAYLOAD } from "../src/recordstore.ts";
import { buildFixtureDb, openDb, openRw, REPO } from "./nodeDb.ts";

const web = (f: string) => join(REPO, "web", f);
const R: any = await import(web("case-record.js"));
const C: any = await import(web("case-course.js"));
const N: any = await import(web("record-notes.js"));
const A: any = await import(web("note-assemble.js"));

let db: Db;
before(() => {
  db = openDb(buildFixtureDb());
});
const TOKEN = "test-token-0123456789abcdef";
const app = (extra: Partial<AppDeps> = {}): AppDeps => ({ db, apiKey: "k", appToken: TOKEN, model: "m", ...extra });
const req = (path: string, init: RequestInit = {}) => new Request(`http://x${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers as any) } });

const CASE = { age: "70代", sex: "男性", setting: "救急", complaint: "3日前から腹痛、嘔気", vitals: "BP 92/54, HR 108", findings: "Cr 2.4 mg/dL", history: "高血圧", own: "" };
const T = "架空内科ハンドブック 第1版";
const snap = (o: unknown) => JSON.stringify(o);
const keys = (o: object) => Object.keys(o).sort();

/** A record with an AI-origin problem (its page cited), an AI plan with a citation, and the doctor's own second problem. */
function base() {
  let r = R.newRecord(CASE);
  r = R.addAdopted(r, [
    { role: "problems", heading: "問題リスト", text: "腎前性AKI [推論]", cites: [{ kind: "book", title: `${T} ［転写者補助含む］`, page: "p.10-11" }] },
    { role: "plan", heading: "初期プラン", text: "細胞外液の輸液を検討", cites: [{ kind: "book", title: T, page: "p.12-13" }, { kind: "web", title: "KDIGO", url: "https://kdigo.org/x" }] },
  ]).rec;
  r = R.attach(r, "a1", "new").rec; // p1: AI-origin, cites p.10-11
  r = R.attach(r, "a2", "p1").rec; // an AI plan entry (i1) citing p.12-13 and a web page
  r = R.addProblem(r, "糖尿病").rec; // p2
  return r;
}

// ---------------------------------------------------------------------------------- shape
test("cleanRefs: known keys only, one per page, at most eight, a title without the flags at its end, blanks dropped, the way of coming normalised", () => {
  const refs = R.cleanRefs([
    { title: `${T} ［転写者補助含む］［照合未完］`, page: "p.10", section: "A 概念 > 定義", via: "found", added: 3, snippet: "本文のはず", extra: 1 },
    { title: T, page: "p.10", section: "dup" }, // the same page
    { title: T, page: "" },
    { title: "", page: "p.1" },
    "x",
    null,
    { title: "別の本", page: "p.2", via: "cited", added: 99999 },
    ...Array.from({ length: 12 }, (_, i) => ({ title: `本${i}`, page: `p.${i + 100}` })),
  ]);
  assert.equal(refs.length, R.LIMITS.refs);
  assert.deepEqual(refs[0], { title: T, page: "p.10", section: "A 概念 > 定義", via: "found", added: 3 });
  assert.deepEqual(keys(refs[0]), ["added", "page", "section", "title", "via"], "no text of a book, nothing unknown");
  assert.deepEqual(refs[1], { title: "別の本", page: "p.2", via: "found", added: 1 }, "only the doctor's own pages are stored: a bad day and an unknown way are made plain");
  assert.deepEqual(R.cleanRefs(undefined), []);
  assert.deepEqual(R.cleanRefs({ title: T, page: "p.1" }), [], "not a list");
  assert.equal(R.cleanRefs([{ title: "あ".repeat(500), page: "い".repeat(100), section: "う".repeat(500) }])[0].title.length, R.LIMITS.cite);
  assert.equal(R.cleanRefs([{ title: "あ".repeat(500), page: "い".repeat(100), section: "う".repeat(500) }])[0].page.length, R.LIMITS.page);
  assert.equal(R.cleanRefs([{ title: "あ".repeat(500), page: "い".repeat(100), section: "う".repeat(500) }])[0].section.length, R.LIMITS.section);
});

test("a record read back keeps the pages left for a problem and drops what is not a page", () => {
  let r = base();
  r = R.pinRef(r, "p2", { title: T, page: "p.30", section: "B 治療 > 血糖" }).rec;
  const back = R.cleanRecord(JSON.parse(JSON.stringify(r)));
  assert.deepEqual(back.problems[1].refs, [{ title: T, page: "p.30", section: "B 治療 > 血糖", via: "found", added: 1 }]);
  assert.ok(!("refs" in back.problems[0]), "a problem with none has no key");
  const raw = JSON.parse(JSON.stringify(r));
  raw.problems[1].refs.push({ title: 5, page: {} }, "x");
  raw.problems[0].refs = "not a list";
  const clean = R.cleanRecord(raw);
  assert.equal(clean.problems[1].refs.length, 1);
  assert.ok(!("refs" in clean.problems[0]));
  assert.equal(snap(R.cleanRecord(JSON.parse(snap(clean)))), snap(clean), "reading it again changes nothing");
});

// ---------------------------------------------------------------------------------- leaving a page
test("pinRef: a page chosen by the doctor is kept with the day; the same page is not added twice (also one an adopted item cites); at most eight; no such problem", () => {
  const r0 = base();
  const before = snap(r0);
  const ok = R.pinRef(r0, "p2", { title: T, page: "p.30", section: "B 治療 > 血糖", snippet: "not kept", text: "not kept" });
  assert.equal(ok.ok, true);
  assert.equal(snap(r0), before, "the record given is not changed");
  assert.deepEqual(ok.rec.problems[1].refs, [{ title: T, page: "p.30", section: "B 治療 > 血糖", via: "found", added: 1 }]);
  // the day comes from the record's working day
  const day3 = R.pinRef(C.setToday(r0, 3), "p2", { title: T, page: "p.31" });
  assert.equal(day3.rec.problems[1].refs[0].added, 3);
  // the same page again, also with other flags on its title
  assert.deepEqual([R.pinRef(ok.rec, "p2", { title: `${T} ［照合未完］`, page: "p.30" }).ok, R.pinRef(ok.rec, "p2", { title: `${T} ［照合未完］`, page: "p.30" }).reason], [false, "duplicate"]);
  // a page an adopted item of the problem already cites
  assert.equal(R.pinRef(r0, "p1", { title: T, page: "p.10-11" }).reason, "duplicate");
  assert.equal(R.pinRef(r0, "p1", { title: T, page: "p.12-13" }).reason, "duplicate");
  // not a page / no problem
  assert.equal(R.pinRef(r0, "p2", { title: T, page: "" }).reason, "bad");
  assert.equal(R.pinRef(r0, "p2", { title: "", page: "p.1" }).reason, "bad");
  assert.equal(R.pinRef(r0, "p2", undefined).reason, "bad");
  assert.equal(R.pinRef(r0, "p9", { title: T, page: "p.1" }).reason, "missing");
  // the limit
  let full = r0;
  for (let i = 0; i < R.LIMITS.refs; i++) full = R.pinRef(full, "p2", { title: T, page: `p.${200 + i}` }).rec;
  assert.equal(full.problems[1].refs.length, R.LIMITS.refs);
  assert.equal(R.pinRef(full, "p2", { title: T, page: "p.999" }).reason, "full");
  // another problem is not full
  assert.equal(R.pinRef(full, "p1", { title: T, page: "p.999" }).ok, true);
});

test("unpinRef takes back a page the doctor left; a page an adopted item cites goes with that item, not from here", () => {
  let r = R.pinRef(base(), "p2", { title: T, page: "p.30" }).rec;
  r = R.pinRef(r, "p2", { title: T, page: "p.31" }).rec;
  const gone = R.unpinRef(r, "p2", R.refKey({ title: T, page: "p.30" }));
  assert.deepEqual(gone.problems[1].refs.map((x: any) => x.page), ["p.31"]);
  assert.ok(!("refs" in R.unpinRef(gone, "p2", R.refKey({ title: T, page: "p.31" })).problems[1]), "the last one takes the key with it");
  assert.equal(snap(R.unpinRef(r, "p1", R.refKey({ title: T, page: "p.10-11" }))), snap(r), "a cited page is not removed from here");
  assert.equal(snap(R.unpinRef(r, "p9", "x|y")), snap(r));
  assert.equal(R.refsOf(R.unpinRef(base(), "p1", R.refKey({ title: T, page: "p.10-11" })).problems[0]).length, 2);
});

// ---------------------------------------------------------------------------------- what a problem has
test("refsOf: the pages left first, then the pages the adopted items cite, each once, with the day; a web citation is not a book", () => {
  let r = base();
  r = C.setToday(r, 2);
  r = R.pinRef(r, "p1", { title: T, page: "p.40", section: "C 補液" }).rec;
  const list = R.refsOf(r.problems[0]);
  assert.deepEqual(
    list.map((x: any) => [x.page, x.via, x.pinned, x.added]),
    [["p.40", "found", true, 2], ["p.10-11", "cited", false, 1], ["p.12-13", "cited", false, 1]],
  );
  assert.equal(list[1].title, T, "the flags at the end of a title are not part of the name");
  assert.ok(!list.some((x: any) => /KDIGO/.test(x.title)), "web");
  assert.deepEqual(R.refsOf(r.problems[1]), [], "a problem with nothing has no pages");
  // a page both cited and left is one page, and the doctor's own entry carries no citation of its own
  const dup = R.pinRef(r, "p1", { title: T, page: "p.10-11" });
  assert.equal(dup.ok, false);
  const own = R.addEntry(r, "p1", "assess", "自分の評価").rec;
  assert.equal(R.refsOf(own.problems[0]).length, 3);
  // once the doctor renames an AI problem, its own citations no longer apply (the pages of its entries stay with the entries)
  const renamed = R.setProblem(r, "p1", { label: "腎前性AKIの疑い（改）" });
  assert.deepEqual(R.refsOf(renamed.problems[0]).map((x: any) => x.page), ["p.40", "p.12-13"]);
});

// ---------------------------------------------------------------------------------- not before their day
test("a page left after day n is not in the record as it stood on day n; a page cited by an entry added later is not either", () => {
  let r = base(); // everything above came on day 1
  r = C.setToday(r, 3);
  r = R.pinRef(r, "p1", { title: T, page: "p.50" }).rec; // left on day 3
  r = R.addAdopted(r, [{ role: "assessment", heading: "各問題の評価", text: "後日の評価", cites: [{ kind: "book", title: T, page: "p.60" }] }]).rec;
  r = R.attach(r, "a3", "p1").rec; // an AI entry added on day 3
  const day2 = C.asOf(r, 2);
  assert.deepEqual(R.refsOf(day2.problems[0]).map((x: any) => x.page), ["p.10-11", "p.12-13"]);
  assert.ok(!("refs" in day2.problems[0]), "a problem with no page left by then has no key");
  const day3 = C.asOf(r, 3);
  assert.deepEqual(R.refsOf(day3.problems[0]).map((x: any) => x.page), ["p.50", "p.10-11", "p.60", "p.12-13"]);
  assert.equal(snap(r.problems[0].refs), snap([{ title: T, page: "p.50", via: "found", added: 3 }]), "the record itself is not changed by looking at a day");
});

// ---------------------------------------------------------------------------------- the discharge summary
const discharged = (mut: (r: any) => any = (r) => r) => {
  let r = base();
  r = R.setProblem(r, "p1", { certainty: "likely", dx: "main" });
  r = R.setProblem(r, "p2", { certainty: "confirmed", dx: "sub" });
  r = R.pinRef(r, "p1", { title: T, page: "p.40", section: "C 補液 > 輸液" }).rec;
  r = C.setToday(r, 4);
  r = mut(r);
  return C.setDischarge(r, { decided: true, day: 4 });
};

test("the discharge summary lists, under each main and sub diagnosis, the pages kept for it and says what they are", () => {
  const t = A.toText(N.dischargeNote(discharged()));
  const dx = t.split("■")[1 + t.split("■").findIndex((s: string) => s.startsWith("診断"))] ?? "";
  assert.match(t, /1\. .*腎前性AKI.*\n   書籍の根拠（先生が残した頁・採用した草案の引用の頁です。この記載の内容を書籍が支える確認ではありません）:\n   ・架空内科ハンドブック 第1版 p\.40（C 補液 > 輸液）［先生が検索で残した頁］\n   ・架空内科ハンドブック 第1版 p\.10-11［採用した草案の引用］\n   ・架空内科ハンドブック 第1版 p\.12-13［採用した草案の引用］/);
  assert.ok(!dx.includes("［転写者補助含む］"), "the flags are shown as flags elsewhere, not in a name");
  // a diagnosis with no page has no line; the text of a book is nowhere
  const p2 = t.split("\n").findIndex((l: string) => /^1\. 糖尿病|^2\. 糖尿病|副病名/.test(l));
  assert.ok(p2 >= 0);
  assert.equal((t.match(/書籍の根拠（/g) ?? []).length, 1);
  assert.doesNotMatch(t, /本文のはず|snippet/);
});

test("the copy without the marks of origin leaves the pages out; a page left after the discharge day is not in the summary; a problem not classed shows none", () => {
  const note = N.dischargeNote(discharged());
  assert.doesNotMatch(A.toText(note, { sourceMarks: false }), /書籍の根拠|p\.40|p\.10-11/);
  assert.match(A.toText(note, { sourceMarks: true }), /書籍の根拠/);
  assert.match(A.toText(note, { aiMark: false }), /書籍の根拠/, "the AI mark and the marks of origin are separate switches");
  // left on day 6, after the discharge on day 4
  let r = discharged();
  r = C.setToday(r, 6);
  r = R.pinRef(r, "p2", { title: T, page: "p.77" }).rec;
  assert.doesNotMatch(A.toText(N.dischargeNote(r)), /p\.77/);
  // a problem the doctor did not class as main or sub has no line, as the diagnoses block only lists the classed ones
  const unclassed = discharged((x) => R.setProblem(x, "p1", { dx: "" }));
  assert.doesNotMatch(A.toText(N.dischargeNote(unclassed)), /書籍の根拠/);
  assert.match(A.toText(N.dischargeNote(unclassed)), /区分を選んでいない問題/);
});

test("the other notes are as they were: the admission note and the progress note do not gain a page list", () => {
  const r = R.pinRef(base(), "p1", { title: T, page: "p.40" }).rec;
  assert.doesNotMatch(A.toText(R.admissionNote(r)), /書籍の根拠|p\.40/);
  assert.doesNotMatch(A.toText(N.progressNote(r, 1)), /書籍の根拠|p\.40/);
  assert.doesNotMatch(A.toText(N.interimNote(r, 1)), /書籍の根拠|p\.40/);
});

// ---------------------------------------------------------------------------------- dates, size and the store
test("a book's title and section are not touched by the date conversion (they are not the patient's dates)", () => {
  let r = R.pinRef(base(), "p2", { title: "診療ガイドライン 2026/10/20 改訂", page: "p.5", section: "10月22日の補遺" }).rec;
  const rel = R.relativizeRecord(r, { now: new Date("2026-10-24T03:00:00Z") });
  assert.equal(rel.rec.problems[1].refs[0].title, "診療ガイドライン 2026/10/20 改訂");
  assert.equal(rel.rec.problems[1].refs[0].section, "10月22日の補遺");
});

test("the pages cost little: the most a record can keep for every problem is a small part of what the server takes", () => {
  let r = R.newRecord(CASE);
  for (let i = 0; i < R.LIMITS.problems; i++) {
    r = R.addProblem(r, `問題${i}`).rec;
    for (let j = 0; j < R.LIMITS.refs; j++) r = R.pinRef(r, `p${i + 1}`, { title: `${"本".repeat(R.LIMITS.cite - 4)}${j}`.slice(0, R.LIMITS.cite), page: `p.${1000 + j}`, section: "節".repeat(R.LIMITS.section) }).rec;
  }
  const withRefs = JSON.stringify(r).length;
  const without = JSON.stringify(R.cleanRecord({ ...JSON.parse(JSON.stringify(r)), problems: r.problems.map(({ refs, ...p }: any) => p) })).length;
  assert.ok(withRefs - without < MAX_RECORD_PAYLOAD * 0.2, `${withRefs - without}`);
});

test("the store takes a record with pages (depth within the limit); an identifier-like title is refused with the kind only", async () => {
  assert.ok(MAX_DEPTH >= 6);
  const deps = app({ rw: openRw(), now: () => new Date("2026-10-24T00:00:00Z") });
  const put = (id: string, record: unknown) => handle(req(`/api/records/${id}`, { method: "PUT", body: JSON.stringify({ record }) }), deps);
  const rec = R.pinRef(base(), "p2", { title: T, page: "p.30", section: "B 治療 > 血糖" }).rec;
  assert.equal((await put("rec-refs0001", rec)).status, 200);
  const got: any = await (await handle(req("/api/records/rec-refs0001"), deps)).json();
  assert.deepEqual(got.record.problems[1].refs, [{ title: T, page: "p.30", section: "B 治療 > 血糖", via: "found", added: 1 }]);
  assert.equal(snap(R.cleanRecord(got.record)), snap(R.cleanRecord(rec)), "what is read back is what was saved");
  // a title that is a number the guard knows (built at run time: a 9-digit number)
  const idnum = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].join("");
  const bad = JSON.parse(JSON.stringify(rec));
  bad.problems[1].refs[0].title = `書名 ${idnum}`;
  const res = await put("rec-refs0002", bad);
  assert.equal(res.status, 400);
  const j: any = await res.json();
  assert.ok(!JSON.stringify(j).includes(idnum), "the matched text is not returned");
});

// ---------------------------------------------------------------------------------- the screen keeps and sends only where to look
test("pins: the screen keeps a title, a page and a section's name (never the snippet), searches by the problem's name only, and the model code is not reached", () => {
  const ui = readFileSync(web("record-ui.js"), "utf-8").replace(/\/\/[^\n]*/g, "");
  const keep = ui.slice(ui.indexOf("function keepRef"), ui.indexOf("function refsSection"));
  assert.match(keep, /pinRef\(S\.rec, p\.id, \{ title: hit\.book_title, page: hit\.page_label, section: String\(hit\.path \?\? ""\) \}\)/);
  assert.doesNotMatch(keep, /snippet/);
  const find = ui.slice(ui.indexOf("async function findRefs"), ui.indexOf("/** Leaves a found page"));
  assert.match(find, /queries: \[q\]/, "the search words are the problem's name");
  assert.match(find, /scan\(q\)/, "checked for identifiers before it is sent");
  assert.doesNotMatch(find, /S\.rec\.ed\.case|\.findings|\.complaint|\.vitals/, "nothing of the case goes into the search");
  const model = readFileSync(web("case-record.js"), "utf-8").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(model, /\bfetch\s*\(|\/api\//);
});
