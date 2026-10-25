// Sending a case record to Casebook (docs/enhancement-plan.md 8.17; docs/clinical-use.md 1f): the state kept in the record, the items the
// record offers, the packet (codec, ids, shapes) and the pins that keep the screen from sending anything over the network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO } from "./nodeDb.ts";

const web = (f: string) => join(REPO, "web", f);
const S: any = await import(web("casebook-state.js"));
const P: any = await import(web("casebook-packet.js"));
const R: any = await import(web("case-record.js"));
const C: any = await import(web("case-course.js"));
const V = JSON.parse(readFileSync(join(REPO, "tests", "vectors", "casebook-handoff.json"), "utf-8"));

const SEED = "abcdefghij";
const KASE = { age: "72", sex: "男性", setting: "救急", complaint: "3日前から発熱と咳。昨日から尿量が減った。", vitals: "BP 92/54, HR 108, SpO2 94%", findings: "Cr 2.4 mg/dL（ふだんは 0.9）, K 5.8 mEq/L", history: "高血圧。アムロジピン内服。", own: "腎前性AKIを第一に考える。" };

/** A record with a problem the doctor wrote (suspected), an assessment and a plan the doctor wrote, and a problem from the AI draft. */
function sample() {
  let rec = R.newRecord(KASE);
  const a = R.addProblem(rec, "腎前性AKI");
  rec = R.setProblem(a.rec, a.id, { certainty: "suspected" });
  rec = R.addEntry(rec, a.id, "assess", "感染と脱水に伴う。NSAIDs の関与を疑う。").rec;
  const plan = R.addEntry(rec, a.id, "plan", "補液と原因薬の中止を検討する。");
  rec = plan.rec;
  rec = S.ensureSeed(rec, Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
  return { rec, pid: a.id, planId: plan.id };
}
const ULID = Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
const PID = P.ulidFrom(1_700_000_000_000, ULID);
const NEW = { mode: "new", patient: { ageYears: 72, sex: "M", setting: "emergency" }, synthetic: true, packetId: PID };
const allKeys = (rec: any) => P.candidates(rec).filter((c: any) => !c.blockers.length).map((c: any) => c.key);

/** Reads a packet text back the way Casebook does (CRC, base64url, UTF-8, JSON). */
function unwrap(text: string): any {
  assert.match(text, /^CBH1:[A-Za-z0-9_-]+\.[0-9a-f]{8}$/);
  const [body, crc] = text.slice(5).split(".");
  assert.equal(P.crc32(P.utf8Encode(body)).toString(16).padStart(8, "0"), crc);
  const b64 = body.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
}

// ---------------------------------------------------------------------------------- the copy of Casebook's codec and ids
test("sha256 equals node's, for empty, ASCII, Japanese, a surrogate pair and block-boundary lengths", () => {
  for (const t of ["", "abc", "あいう", "😀", "x".repeat(55), "x".repeat(56), "x".repeat(63), "x".repeat(64), "x".repeat(119), "あ".repeat(500)]) {
    assert.equal(Buffer.from(P.sha256(t)).toString("hex"), createHash("sha256").update(t).digest("hex"), `length ${t.length}`);
  }
});

test("ulidFrom and the codec give Casebook's own strings (tests/vectors/casebook-handoff.json, made by Casebook's encoder)", () => {
  for (const v of V.ulid) assert.equal(P.ulidFrom(v.timeMs, Uint8Array.from(v.bytes)), v.id);
  for (const v of V.codec) {
    assert.equal(P.wrapPacket(JSON.stringify(v.json)), v.packet, v.name);
    assert.deepEqual(unwrap(v.packet), v.json, v.name);
  }
  assert.match(V.source.commit, /^[0-9a-f]{40}$/);
});

test("the shape check accepts Casebook's own fixtures for the kinds it covers, and refuses what Casebook refuses", () => {
  const own = V.codec.find((v: any) => v.name === "rag-kinds").json;
  assert.deepEqual(P.validatePacket(own), []);
  const bad = (f: (p: any) => void) => {
    const p = structuredClone(own);
    f(p);
    return P.validatePacket(p).length > 0;
  };
  assert.ok(bad((p) => (p.extra = 1)), "unknown field");
  assert.ok(bad((p) => (p.target = { mode: "append", caseCode: "ABC234" })), "synthetic with an append");
  assert.ok(bad((p) => (p.synthetic = false)), "synthetic false is never written");
  assert.ok(bad((p) => (p.patient.setting = "outpatient")), "outpatient needs a date");
  assert.ok(bad((p) => (p.patient.ageYears = 131)));
  assert.ok(bad((p) => (p.patient.sex = "X")));
  assert.ok(bad((p) => (p.items[0].body.text = "x".repeat(501))));
  assert.ok(bad((p) => (p.items[0].body.text = "  ")));
  assert.ok(bad((p) => (p.items[0].problemId = p.items[2].problemId)), "a problem item has no problemId");
  assert.ok(bad((p) => (p.items[1].body.status = "ruled_out")));
  assert.ok(bad((p) => (p.items[3].itemId = p.items[2].itemId)), "duplicate item ids");
  assert.ok(bad((p) => (p.items = [])));
  assert.ok(bad((p) => (p.items = Array.from({ length: 101 }, (_, i) => ({ ...p.items[0], itemId: P.itemIdOf("s", `k${i}`) })))));
  assert.ok(bad((p) => (p.items[0].body.region = "neck-right")), "kinds here carry text only");
});

test("itemIdOf: a ULID, the same for the same seed/key/revision, different otherwise, and the first 16 bytes of the SHA-256", () => {
  const id = P.itemIdOf(SEED, "p.p1");
  assert.match(id, P.ULID_RE);
  assert.equal(id, P.itemIdOf(SEED, "p.p1"));
  assert.notEqual(id, P.itemIdOf(SEED, "p.p2"));
  assert.notEqual(id, P.itemIdOf("abcdefghik", "p.p1"));
  assert.notEqual(id, P.itemIdOf(SEED, "p.p1", 1));
  // the same bits, by another road: 128 bits, five at a time from the end
  const d = createHash("sha256").update(`${SEED}|p.p1|0`).digest();
  let n = 0n;
  for (let i = 0; i < 16; i++) n = (n << 8n) | BigInt(d[i]);
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let want = "";
  for (let i = 0; i < 26; i++) {
    want = A[Number(n & 31n)] + want;
    n >>= 5n;
  }
  assert.equal(id, want);
  for (let i = 0; i < 200; i++) assert.match(P.itemIdOf(SEED, `k${i}`, i % 10), P.ULID_RE);
});

// ---------------------------------------------------------------------------------- the state in the record
test("casebook state: read back with known keys only; a bad seed, code, key or hash is dropped; the old bands of a record without it are fine", () => {
  assert.deepEqual(S.cleanCasebook(undefined), { seed: "", code: "", sent: {}, count: 0 });
  assert.deepEqual(S.cleanCasebook("x"), S.emptyCasebook());
  const c = S.cleanCasebook({ seed: "abcdefghij", code: "ABC234", count: 3, extra: 1, sent: { "p.p1": { h: "k3j9a", r: 2 }, "BAD KEY": { h: "x", r: 0 }, "p.p2": { h: "UPPER", r: 0 }, "p.p3": { h: "abc", r: 99 }, "p.p4": "x" } });
  assert.deepEqual(c, { seed: "abcdefghij", code: "ABC234", sent: { "p.p1": { h: "k3j9a", r: 2 }, "p.p3": { h: "abc", r: 0 } }, count: 3 });
  assert.equal(S.cleanCasebook({ seed: "ABCDEFGHIJ" }).seed, "");
  assert.equal(S.cleanCasebook({ seed: "abc1efghij" }).seed, "", "letters only");
  for (const code of ["ABC230", "ABCDEFG", "abc234", "ABC23I", "ABC23O", "ABC23L", "ABC23U", "ABC 34"]) assert.equal(S.cleanCasebook({ code }).code, "", code);
  assert.equal(Object.keys(S.cleanCasebook({ sent: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, { h: "a", r: 0 }])) }).sent).length, S.SENT_LIMIT);
});

test("casebook state: seed from random bytes (letters only), code normalised, marks counted once per packet, reset starts a new seed", () => {
  assert.equal(S.newSeed(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])), "abcdefghij");
  assert.match(S.newSeed(new Uint8Array(10).fill(255)), /^[a-z]{10}$/);
  let rec = R.newRecord(KASE);
  assert.equal(rec.casebook.seed, "");
  rec = S.ensureSeed(rec, Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
  assert.equal(rec.casebook.seed, "abcdefghij");
  assert.equal(S.ensureSeed(rec, new Uint8Array(10)).casebook.seed, "abcdefghij", "an existing seed is kept");
  const r1 = S.setCode(rec, " abc 234 ");
  assert.deepEqual([r1.ok, r1.rec.casebook.code], [true, "ABC234"]);
  assert.equal(S.setCode(rec, "ABC230").ok, false);
  assert.equal(S.setCode(rec, "ABC230").rec.casebook.code, "");
  assert.equal(S.setCode(r1.rec, "").rec.casebook.code, "");
  const m = S.markSent(r1.rec, [{ key: "p.p1", h: "abc", r: 0 }, { key: "bad key", h: "abc", r: 0 }, { key: "ed.complaint.c1", h: "zz", r: 1 }]);
  assert.deepEqual(m.casebook.sent, { "p.p1": { h: "abc", r: 0 }, "ed.complaint.c1": { h: "zz", r: 1 } });
  assert.equal(m.casebook.count, 1);
  assert.equal(S.markSent(m, []).casebook.count, 1, "nothing marked, nothing counted");
  const reset = S.resetCasebook(m, Uint8Array.from([5, 5, 5, 5, 5, 5, 5, 5, 5, 5]));
  assert.deepEqual([reset.casebook.code, reset.casebook.sent, reset.casebook.count, reset.casebook.seed], ["", {}, 0, "ffffffffff"]);
  assert.equal(rec.casebook.code, "", "the input record is not touched");
});

test("a record keeps its casebook state through cleanRecord; one saved before it existed gets the empty state; the state is in the record only", () => {
  const { rec } = sample();
  const marked = S.markSent(S.setCode(rec, "ABC234").rec, [{ key: "p.p1", h: "abc", r: 0 }]);
  const back = R.cleanRecord(JSON.parse(JSON.stringify(marked)));
  assert.deepEqual(back.casebook, marked.casebook);
  const { casebook, ...old } = JSON.parse(JSON.stringify(marked));
  assert.deepEqual(R.cleanRecord(old).casebook, S.emptyCasebook());
  // no date, no time, no name in the state: only letters, the code, hashes and counts
  const text = JSON.stringify(marked.casebook);
  assert.doesNotMatch(text, /\d{4}-\d{2}|T\d{2}:\d{2}/);
});

// ---------------------------------------------------------------------------------- what the record offers
test("candidates: the case as typed, the problem, the diagnosis the doctor gave, the assessment and the plan, with stable keys and honest words", () => {
  const { rec, pid, planId } = sample();
  const c = P.candidates(rec);
  const by = Object.fromEntries(c.map((x: any) => [x.key, x]));
  assert.deepEqual(c.map((x: any) => x.key), ["ed.complaint.c1", "ed.vitals.c1", "ed.findings.c1", "ed.history.c1", "ed.own.c1", `p.${pid}`, `p.${pid}.dx`, `p.${pid}.assess.i1.c1`, `p.${pid}.plan.${planId}.c1`]);
  assert.deepEqual([by["ed.complaint.c1"].kind, by["ed.complaint.c1"].day, by["ed.complaint.c1"].source], ["course", 1, "user"]);
  assert.equal(by["ed.complaint.c1"].text, "主訴と経過: 3日前から発熱と咳。昨日から尿量が減った。");
  assert.equal(by["ed.history.c1"].kind, "note");
  assert.deepEqual([by[`p.${pid}`].kind, by[`p.${pid}`].text], ["problem", "腎前性AKI"]);
  assert.deepEqual([by[`p.${pid}.dx`].kind, by[`p.${pid}.dx`].status], ["diagnosis", "suspected"]);
  // a plan is sent as a note whose words say it is a plan; it is never a started treatment
  assert.equal(by[`p.${pid}.plan.${planId}.c1`].text, "計画（予定・検討）: 補液と原因薬の中止を検討する。");
  assert.ok(!c.some((x: any) => x.kind === "treatment" || x.kind === "lab" || x.kind === "vital"));
  assert.ok(c.every((x: any) => x.blockers.length === 0));
});

test("candidates: a blank stays blank (no certainty, no diagnosis; an empty field, no item); likely is sent as a suspicion; ruled out can not be sent", () => {
  let { rec, pid } = sample();
  rec = R.setProblem(rec, pid, { certainty: "" });
  assert.ok(!P.candidates(rec).some((x: any) => x.key === `p.${pid}.dx`));
  rec = R.setProblem(rec, pid, { certainty: "likely" });
  const likely = P.candidates(rec).find((x: any) => x.key === `p.${pid}.dx`);
  assert.equal(likely.status, "suspected");
  assert.match(likely.tag, /疑いとして/);
  rec = R.setProblem(rec, pid, { certainty: "confirmed" });
  assert.equal(P.candidates(rec).find((x: any) => x.key === `p.${pid}.dx`).status, "confirmed");
  rec = R.setProblem(rec, pid, { certainty: "ruled_out" });
  const out = P.candidates(rec).find((x: any) => x.key === `p.${pid}.dx`);
  assert.ok(out.blockers.length && /除外/.test(out.blockers[0]));
  const bare = R.newRecord({ ...KASE, vitals: "", findings: "", history: "", own: "" });
  assert.deepEqual(P.candidates(bare).map((x: any) => x.key), ["ed.complaint.c1"]);
});

test("a problem the doctor ruled out, with its diagnosis and what is written under it, is not sent (Casebook has no kind for it, and a lone note would read as something else)", () => {
  let { rec, pid } = sample();
  rec = R.setProblem(rec, pid, { certainty: "ruled_out" });
  rec = C.setTrend(rec, 1, pid, "improved", "");
  const under = P.candidates(rec).filter((x: any) => x.problem === pid);
  assert.deepEqual(under.map((x: any) => x.key.replace(`p.${pid}`, "P")).sort(), ["P", "P.assess.i1.c1", "P.dx", "P.plan.i2.c1", "P.trend.d1.c1"]);
  assert.ok(under.every((x: any) => x.blockers.length === 1 && /除外した問題です/.test(x.blockers[0])));
  assert.ok(under.every((x: any) => !P.ticked(rec, x)));
  const res = P.buildPacket(rec, { ...NEW, keys: under.map((x: any) => x.key) });
  assert.equal(res.ok, false);
  assert.match(res.errors.join("|"), /送れない項目/);
  // the case as typed is still sendable
  assert.equal(P.buildPacket(rec, { ...NEW, keys: ["ed.complaint.c1"] }).ok, true);
});

test("candidates: AI origin is kept (an AI problem, an AI entry); the marks the screen adds are not sent; the plan's state and reason are in the words", () => {
  let { rec, pid, planId } = sample();
  const next = structuredClone(rec);
  next.problems[0].ai = true;
  next.problems[0].label = "腎前性AKI [推論]";
  next.problems[0].assess[0].from = "ai";
  next.problems[0].assess[0].text = "感染と脱水に伴う ［書籍 p.12］ [標準・出典未確認]";
  const c = P.candidates(R.cleanRecord(next));
  const by = Object.fromEntries(c.map((x: any) => [x.key, x]));
  assert.equal(by[`p.${pid}`].source, "ai");
  assert.equal(by[`p.${pid}`].text, "腎前性AKI");
  assert.equal(by[`p.${pid}.dx`].source, "ai");
  assert.equal(by[`p.${pid}.assess.i1.c1`].source, "ai");
  assert.equal(by[`p.${pid}.assess.i1.c1`].text, "評価: 感染と脱水に伴う");
  assert.equal(by[`p.${pid}.plan.${planId}.c1`].source, "user");
  let r2 = R.setEntry(rec, pid, "plan", planId, { state: "stopped", reason: "腎機能が戻ったため" });
  assert.equal(P.candidates(r2).find((x: any) => x.key === `p.${pid}.plan.${planId}.c1`).text, "計画（中止・しない）: 補液と原因薬の中止を検討する。（理由: 腎機能が戻ったため）");
  r2 = R.setEntry(rec, pid, "plan", planId, { state: "done" });
  assert.match(P.candidates(r2).find((x: any) => x.key === `p.${pid}.plan.${planId}.c1`).text, /^計画（実施の記録）: /);
});

test("candidates: the criteria to call, the admission texts, the day texts and a chosen trend come with their day; the trend only when the doctor chose one", () => {
  let { rec, pid } = sample();
  rec = R.setAdm(rec, "summary", "高齢男性の感染に伴う腎前性AKI。");
  rec = R.setAdm(rec, "route", "");
  rec = C.setToday(rec, 3);
  rec = C.setDayField(rec, 3, "subjective", "咳は軽くなった。");
  rec = C.setDayField(rec, 3, "objective", "");
  rec = C.setTrend(rec, 3, pid, "improved", "尿量が戻った");
  const c = P.candidates(rec);
  const by = Object.fromEntries(c.map((x: any) => [x.key, x]));
  assert.equal(by["adm.summary.c1"].text, "Clinical Summary（全体の要約）: 高齢男性の感染に伴う腎前性AKI。");
  assert.equal(by["adm.summary.c1"].day, 1);
  assert.ok(!("adm.route.c1" in by));
  assert.deepEqual([by["day.d3.subjective.c1"].day, by["day.d3.subjective.c1"].kind], [3, "course"]);
  assert.ok(!("day.d3.objective.c1" in by), "an empty field is not an item");
  assert.deepEqual([by[`p.${pid}.trend.d3`.concat(".c1")].text, by[`p.${pid}.trend.d3.c1`].day], ["推移: 改善（尿量が戻った）", 3]);
  rec = C.setTrend(rec, 3, pid, "", "");
  assert.ok(!P.candidates(rec).some((x: any) => /\.trend\./.test(x.key)), "no trend chosen, no trend item");
});

test("pieces: one text under the limit stays one; a long one is split at sentence ends into numbered pieces that together hold everything", () => {
  assert.deepEqual(P.pieces("評価", "短い。"), ["評価: 短い。"]);
  assert.deepEqual(P.pieces("評価", "  "), []);
  const sentence = (i: number) => `${i}番目の所見は${"あ".repeat(60)}である。`;
  const text = Array.from({ length: 30 }, (_, i) => sentence(i)).join("");
  const ps = P.pieces("経過", text);
  assert.ok(ps.length >= 3);
  for (const [i, p] of ps.entries()) {
    assert.ok(p.length <= P.MAX_TEXT, `piece ${i} is ${p.length}`);
    assert.ok(p.startsWith(`経過（${i + 1}/${ps.length}）: `));
    assert.ok(/。$/.test(p), "ends at a sentence end");
  }
  assert.equal(ps.map((p: string) => p.replace(/^経過（\d+\/\d+）: /, "")).join(""), text);
  // one sentence longer than the limit is cut in the middle, and nothing is lost
  const one = "い".repeat(1200);
  const cut = P.pieces("経過", one);
  assert.ok(cut.length >= 3 && cut.every((p: string) => p.length <= P.MAX_TEXT));
  assert.equal(cut.map((p: string) => p.replace(/^経過（\d+\/\d+）: /, "")).join(""), one);
  // a character outside the basic plane is never cut in half
  const emoji = "😀".repeat(600);
  const e = P.pieces("経過", emoji);
  assert.equal(e.map((p: string) => p.replace(/^経過（\d+\/\d+）: /, "")).join(""), emoji);
  for (const p of e) assert.doesNotMatch(p, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
});

test("blockers: an identifier word, a long number, a calendar date (several shapes) and an empty text stop an item; ordinary findings do not", () => {
  const stops = ["カルテ番号 12345678", "ID: 1234567", "090-1234-5678", "tanaka@example.com", "2025-10-24 来院", "2025年10月24日に受診", "10月24日に受診", "10/20 から腹痛", "R7.10.24 入院", "S25.3.4生", ""];
  for (const t of stops) assert.ok(P.blockersOf(t).length > 0, t);
  const fine = ["BP 92/54, HR 108, SpO2 94%（室内気）, BT 38.4℃", "Cr 2.4 mg/dL（ふだんは 0.9）, K 5.8 mEq/L", "3日前から発熱と咳。昨日から尿量が減った。", "入院3日目、解熱傾向。", "HbA1c 7.2%、eGFR 25 mL/min/1.73m2", "NYHA 3度、2/3 の血管で狭窄"];
  for (const t of fine) assert.deepEqual(P.blockersOf(t), [], t);
  // the reason names the kind, never the text
  for (const w of P.blockersOf("カルテ番号 12345678")) assert.ok(!w.includes("12345678"));
});

test("a record with identifier-like or dated text offers that item as blocked, and a packet that includes it is refused", () => {
  let { rec, pid } = sample();
  rec = R.addEntry(rec, pid, "assess", "2025年10月24日に再診").rec;
  const c = P.candidates(rec);
  const blocked = c.filter((x: any) => x.blockers.length);
  assert.equal(blocked.length, 1);
  const res = P.buildPacket(rec, { ...NEW, keys: [blocked[0].key] });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e: string) => /送れない項目/.test(e)));
  assert.equal(res.text, "");
});

// ---------------------------------------------------------------------------------- the packet
test("buildPacket (new): the envelope, problems first, links to the problem, no link on problem/diagnosis; the text reads back; shapes pass", () => {
  const { rec, pid } = sample();
  const res = P.buildPacket(rec, { ...NEW, keys: allKeys(rec) });
  assert.equal(res.ok, true, res.errors.join("/"));
  const j = unwrap(res.text);
  assert.deepEqual(j, res.json);
  assert.deepEqual(P.validatePacket(j), []);
  assert.deepEqual([j.magic, j.schemaVersion, j.packetId, j.target, j.patient, j.synthetic, j.hospitalDay], ["CBH1", 1, PID, { mode: "new" }, { ageYears: 72, sex: "M", setting: "emergency" }, true, 1]);
  assert.deepEqual(j.items.map((i: any) => i.body.kind), ["problem", "diagnosis", "course", "course", "course", "note", "note", "note", "note"]);
  const problem = j.items[0];
  assert.equal(problem.itemId, P.itemIdOf(SEED, `p.${pid}`));
  assert.equal(problem.problemId, undefined);
  assert.equal(j.items[1].problemId, undefined);
  assert.equal(j.items[1].body.status, "suspected");
  const assess = j.items.find((i: any) => i.body.text.startsWith("評価: "));
  assert.equal(assess.problemId, problem.itemId);
  assert.equal(j.items.find((i: any) => i.body.text.startsWith("主訴と経過")).problemId, undefined);
  assert.ok(j.items.every((i: any) => i.day === 1 && i.source === "user"));
  assert.equal(res.entries.length, j.items.length);
  assert.ok(res.entries.every((e: any) => e.r === 0 && /^[0-9a-z]{1,8}$/.test(e.h)));
});

test("buildPacket: a real case has no synthetic mark; an append carries the code and no patient / mark / hospital day", () => {
  const { rec } = sample();
  const real = P.buildPacket(rec, { ...NEW, synthetic: false, keys: allKeys(rec) });
  assert.equal(real.ok, true);
  assert.ok(!("synthetic" in real.json));
  const ap = P.buildPacket(rec, { mode: "append", code: "ABC234", packetId: PID, keys: allKeys(rec).slice(0, 3), synthetic: true, patient: NEW.patient });
  assert.equal(ap.ok, true, ap.errors.join("/"));
  assert.deepEqual(ap.json.target, { mode: "append", caseCode: "ABC234" });
  for (const k of ["patient", "synthetic", "hospitalDay"]) assert.ok(!(k in ap.json), k);
});

test("buildPacket: every missing or wrong choice is said; nothing is guessed (age, sex, setting, real/fictional, code, items, limits)", () => {
  const { rec } = sample();
  const keys = allKeys(rec);
  const errs = (o: any) => P.buildPacket(rec, { ...NEW, keys, ...o }).errors.join("|");
  assert.match(errs({ patient: { ...NEW.patient, ageYears: null } }), /年齢/);
  assert.match(errs({ patient: { ...NEW.patient, ageYears: 131 } }), /年齢/);
  assert.match(errs({ patient: { ...NEW.patient, sex: "" } }), /性別/);
  assert.match(errs({ patient: { ...NEW.patient, setting: "outpatient" } }), /外来/);
  assert.match(errs({ patient: { ...NEW.patient, setting: "" } }), /場面/);
  assert.match(errs({ synthetic: null }), /実症例か架空症例/);
  assert.match(errs({ synthetic: undefined }), /実症例か架空症例/);
  assert.match(errs({ packetId: "x" }), /パケットの ID/);
  assert.match(errs({ keys: [] }), /送る項目を選んでください/);
  assert.match(errs({ keys: ["nope"] }), /送る項目を選んでください/);
  assert.match(P.buildPacket(rec, { mode: "append", code: "ABC230", packetId: PID, keys }).errors.join("|"), /症例コード/);
  assert.match(P.buildPacket(rec, { mode: "append", code: "", packetId: PID, keys }).errors.join("|"), /症例コード/);
  const noSeed = R.newRecord(KASE);
  assert.match(P.buildPacket(noSeed, { ...NEW, keys: ["ed.complaint.c1"] }).errors.join("|"), /seed/);
  // more than 100 items
  let big = rec;
  for (let d = 2; d <= 30; d++) {
    big = C.setToday(big, d);
    for (const f of ["interval", "subjective", "objective", "overall"]) big = C.setDayField(big, d, f, `${d}日目の${f}`);
  }
  const bigKeys = allKeys(big);
  assert.ok(bigKeys.length > P.MAX_ITEMS);
  assert.match(P.buildPacket(big, { ...NEW, keys: bigKeys }).errors.join("|"), /100 項目まで/);
  assert.equal(P.buildPacket(big, { ...NEW, keys: bigKeys.slice(0, P.MAX_ITEMS) }).ok, true);
});

test("sending again: the same item has the same id (so Casebook makes no second one); sent items are not offered again; a changed item is sent as a new item", () => {
  let { rec, pid } = sample();
  const first = P.buildPacket(rec, { ...NEW, keys: allKeys(rec) });
  const again = P.buildPacket(rec, { ...NEW, packetId: P.ulidFrom(1, ULID), keys: allKeys(rec) });
  assert.deepEqual(first.json.items.map((i: any) => i.itemId), again.json.items.map((i: any) => i.itemId));
  // the doctor says Casebook took them in
  rec = S.markSent(S.setCode(rec, "ABC234").rec, first.entries);
  const c = P.candidates(rec);
  assert.ok(c.every((x: any) => P.stateOf(rec, x) === "sent"));
  assert.ok(c.every((x: any) => !P.ticked(rec, x)), "nothing is ticked: all were sent");
  assert.match(P.buildPacket(rec, { mode: "append", code: "ABC234", packetId: PID, keys: c.map((x: any) => x.key) }).errors.join("|"), /送信済み/);
  // a new entry is the only thing offered
  const added = R.addEntry(rec, pid, "assess", "尿量は回復傾向。");
  rec = added.rec;
  const fresh = P.candidates(rec).filter((x: any) => P.stateOf(rec, x) === "new");
  assert.deepEqual(fresh.map((x: any) => x.key), [`p.${pid}.assess.${added.id}.c1`]);
  assert.ok(P.ticked(rec, fresh[0]));
  const ap = P.buildPacket(rec, { mode: "append", code: rec.casebook.code, packetId: PID, keys: [fresh[0].key] });
  assert.equal(ap.ok, true);
  assert.equal(ap.json.items.length, 1);
  assert.equal(ap.json.items[0].problemId, P.itemIdOf(SEED, `p.${pid}`), "linked to the problem sent before");
  // the doctor changes a sent item: it is "changed", not ticked, refused unless sent again as a new item
  rec = R.setEntry(rec, pid, "assess", "i1", { text: "感染と脱水に伴う。NSAIDs は中止済み。" });
  const ch = P.candidates(rec).find((x: any) => x.key === `p.${pid}.assess.i1.c1`);
  assert.equal(P.stateOf(rec, ch), "changed");
  assert.ok(!P.ticked(rec, ch));
  assert.match(P.buildPacket(rec, { mode: "append", code: "ABC234", packetId: PID, keys: [ch.key] }).errors.join("|"), /新しい項目として送る/);
  const re = P.buildPacket(rec, { mode: "append", code: "ABC234", packetId: PID, keys: [ch.key], resend: [ch.key] });
  assert.equal(re.ok, true);
  assert.notEqual(re.json.items[0].itemId, P.itemIdOf(SEED, ch.key, 0));
  assert.equal(re.json.items[0].itemId, P.itemIdOf(SEED, ch.key, 1));
  assert.equal(re.entries[0].r, 1);
});

test("a diagnosis that changes (suspected -> confirmed) is a changed item; sent again it is a second diagnosis with its own id", () => {
  let { rec, pid } = sample();
  const first = P.buildPacket(rec, { ...NEW, keys: allKeys(rec) });
  rec = S.markSent(S.setCode(rec, "ABC234").rec, first.entries);
  rec = R.setProblem(rec, pid, { certainty: "confirmed" });
  const dx = P.candidates(rec).find((x: any) => x.key === `p.${pid}.dx`);
  assert.equal(P.stateOf(rec, dx), "changed");
  const re = P.buildPacket(rec, { mode: "append", code: "ABC234", packetId: PID, keys: [dx.key], resend: [dx.key] });
  assert.equal(re.ok, true, re.errors.join("/"));
  assert.equal(re.json.items[0].body.status, "confirmed");
  assert.notEqual(re.json.items[0].itemId, first.json.items.find((i: any) => i.body.kind === "diagnosis").itemId);
});

test("AI items are not ticked by themselves; they keep source ai in the packet", () => {
  const { rec } = sample();
  const next = structuredClone(rec);
  next.problems[0].ai = true;
  const r2 = R.cleanRecord(next);
  const c = P.candidates(r2);
  assert.ok(c.filter((x: any) => x.source === "ai").every((x: any) => !P.ticked(r2, x)));
  assert.ok(c.filter((x: any) => x.source === "user").every((x: any) => P.ticked(r2, x)));
  const res = P.buildPacket(r2, { ...NEW, keys: allKeys(r2) });
  assert.deepEqual(res.json.items.filter((i: any) => i.source === "ai").map((i: any) => i.body.kind).sort(), ["diagnosis", "problem"]);
});

test("patientDefaults: from the case; the old decade bands and outpatient give nothing to send", () => {
  const d = (k: any) => P.patientDefaults(R.newRecord({ ...KASE, ...k }));
  assert.deepEqual(d({}), { ageYears: 72, sex: "M", setting: "emergency" });
  assert.deepEqual(d({ age: "0", sex: "女性", setting: "病棟" }), { ageYears: 0, sex: "F", setting: "inpatient" });
  assert.deepEqual(d({ age: "70代", sex: "その他・不明", setting: "外来" }), { ageYears: null, sex: "other", setting: null });
  assert.deepEqual(d({ age: "", sex: "", setting: "" }), { ageYears: null, sex: null, setting: null });
});

// ---------------------------------------------------------------------------------- against Casebook's own code (when its worktree is at hand)
const CASEBOOK = process.env.CASEBOOK_DIR;
test("Casebook's own decoder and anonymization linter accept what this makes (runs when CASEBOOK_DIR points at the clinical-casebook worktree)", { skip: !CASEBOOK || !existsSync(join(CASEBOOK ?? "", "packages/core/src/handoff/packet.ts")) }, async () => {
  const dec: any = await import(join(CASEBOOK!, "packages/core/src/handoff/packet.ts"));
  const lint: any = await import(join(CASEBOOK!, "packages/core/src/lint/anonymize.ts"));
  const { rec } = sample();
  for (const synthetic of [true, false]) {
    const res = P.buildPacket(rec, { ...NEW, synthetic, keys: allKeys(rec) });
    const r = dec.decodePacket(res.text);
    assert.equal(r.ok, true);
    assert.deepEqual([r.value.invalid.length, r.value.unknownKind.length], [0, 0]);
    assert.equal(r.value.packet.synthetic, synthetic ? true : undefined);
    assert.equal(r.value.packet.items.length, res.json.items.length);
    for (const it of r.value.packet.items) assert.deepEqual(lint.lintAnonymization(it.body.text, { dobMaxYear: 2008 }).filter((f: any) => f.level === "error"), []);
  }
  const ap = P.buildPacket(rec, { mode: "append", code: "ABC234", packetId: PID, keys: allKeys(rec).slice(0, 4) });
  assert.equal(dec.decodePacket(ap.text).ok, true);
  // what Casebook's linter stops as an error, this pre-check stops too (it may stop more)
  for (const t of ["090-1234-5678", "tanaka@example.com", "2025-10-24 来院", "2025年10月24日に受診", "10月24日に受診", "令和7年10月24日", "R7.10.24", "S25.3.4生", "生年月日 1950年3月4日", "1950/03/04"]) {
    assert.ok(lint.lintAnonymization(t, { dobMaxYear: 2008 }).some((f: any) => f.level === "error"), `Casebook stops: ${t}`);
    assert.ok(P.blockersOf(t).length > 0, `this stops: ${t}`);
  }
});

// ---------------------------------------------------------------------------------- pins: nothing is sent, nothing is kept in the browser
const strip = (f: string) => readFileSync(web(f), "utf-8").replace(/\/\/[^\n]*/g, "");

test("pins: the packet and state modules are pure (no DOM, network, storage, clock, randomness, AI); their imports are only the model files", () => {
  for (const f of ["casebook-state.js", "casebook-packet.js"]) {
    const src = strip(f);
    for (const bad of [/\bfetch\(/, /localStorage|sessionStorage|indexedDB|caches\./, /\bdocument\./, /\bwindow\./, /\bnavigator\b/, /XMLHttpRequest|WebSocket|sendBeacon/, /anthropic|\/api\//i, /Math\.random|Date\.now|new Date|crypto\./, /innerHTML|\beval\(|new Function/]) assert.doesNotMatch(src, bad, f);
  }
  const imports = (f: string) => [...readFileSync(web(f), "utf-8").matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports("casebook-state.js"), []);
  assert.deepEqual(imports("casebook-packet.js"), ["./case-course.js", "./case-model.js", "./case-record.js", "./casebook-state.js", "./date-relative.js", "./id-guard.js"]);
});

test("pins: the Casebook screen part sends nothing over the network and keeps nothing in the browser's own storage; the packet only goes to the clipboard helper", () => {
  const ui = strip("casebook-ui.js");
  assert.doesNotMatch(ui, /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|\/api\/|api\(/);
  assert.doesNotMatch(ui, /localStorage|sessionStorage|indexedDB|caches\.|document\.cookie/);
  assert.doesNotMatch(ui, /innerHTML|insertAdjacentHTML|outerHTML|\beval\(|new Function|window\.open|createObjectURL|new Blob|navigator\.share|\bprint\(|location\./);
  assert.doesNotMatch(ui, /navigator\.clipboard/, "the clipboard is reached through the app's copyText only");
  assert.deepEqual([...readFileSync(web("casebook-ui.js"), "utf-8").matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]).sort(), ["./case-model.js", "./casebook-packet.js", "./casebook-state.js"]);
  // the record screen reaches it through initCasebook only and the record model never imports the screen
  const rui = readFileSync(web("record-ui.js"), "utf-8");
  assert.match(rui, /import \{ initCasebook \} from "\.\/casebook-ui\.js";/);
  assert.doesNotMatch(readFileSync(web("case-record.js"), "utf-8"), /casebook-ui|casebook-packet/);
});

test("pins: the screen says what is not sent and that nothing goes over the network; the real/fictional choice has no default", () => {
  const ui = readFileSync(web("casebook-ui.js"), "utf-8");
  assert.match(ui, /通信はしません/);
  assert.match(ui, /NOT_SENT/);
  assert.match(ui, /M\.synthetic === false/);
  assert.match(ui, /M\.synthetic === true/);
  assert.match(ui, /synthetic: null/, "the choice starts unmade");
  assert.ok(P.NOT_SENT.length >= 3);
  assert.deepEqual(P.SETTING_OUT.map((s: any) => s.id), ["emergency", "inpatient"], "outpatient is not offered");
});
