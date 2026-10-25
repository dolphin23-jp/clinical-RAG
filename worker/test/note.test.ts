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
const FLOW = [
  "場面・症候: 救急外来 × 腹痛（clinical-modules のフローの質問への答え。未入力の項目は未確認で、陰性ではありません）",
  "［受け入れ］",
  "第一印象：sick",
  "病着：21:40",
  "［初期評価］",
  "体温：38.4 ℃",
  "［病歴・診察］",
  "随伴症状：嘔気",
  "未入力の中核項目（3件。未確認）: 血圧、脈拍、SpO2",
].join("\n");
const sectionKeys = (n: any) => n.sections.map((s: any) => s.key);

test("A04: the flow's answers are a block of their own after the fields, not in the physical-exam field; the findings stay where they were", () => {
  const note = A.assemble("A04", { kase: { ...KASE, structured: FLOW } });
  const exam = note.sections.find((s: any) => s.key === "exam");
  assert.deepEqual(exam.blocks.map((b: any) => b.source), ["findings"]);
  assert.ok(!JSON.stringify(note.sections).includes("第一印象") && !JSON.stringify(note.sections).includes("38.4"), "no answer reached a field");
  assert.equal(note.extras.length, 1);
  assert.equal(note.extras[0].label, "場面・症候の入力");
  const text = A.toText(note);
  assert.match(text, /■身体診察\n［身体所見・検査・画像・心電図］\nCr 2\.4 mg\/dL, K 5\.8 mEq\/L\n\n■重症度/);
  // after every field, under its own heading, with the scene and symptom first and the answers in the order the flow asked
  const order = [...text.matchAll(/^■(.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(order, ["来院情報", "現病歴", "患者背景", "初期評価・ABCDE", "身体診察", "重症度・第一仮説・鑑別", "帰宅・入院・転院と根拠", "場面・症候の入力"]);
  assert.match(text, /■場面・症候の入力\n（フローの質問への答えです。記載の欄には振り分けていません。ここにない項目は未確認で、陰性・正常を意味しません）\n【救急外来 × 腹痛】\n［受け入れ］\n第一印象：sick\n病着：21:40\n［初期評価］\n体温：38.4 ℃\n［病歴・診察］\n随伴症状：嘔気$/);
});

test("A04: every other field is exactly as without the flow's answers; the block is not a field, so it is never （未入力） or counted as unfilled", () => {
  const without = A.assemble("A04", { kase: KASE, items: [item("problems", "急性腎障害の疑い"), item("plan", "輸液の反応を見る")] });
  const withFlow = A.assemble("A04", { kase: { ...KASE, structured: FLOW }, items: [item("problems", "急性腎障害の疑い"), item("plan", "輸液の反応を見る")] });
  assert.deepEqual(withFlow.sections, without.sections);
  assert.deepEqual([withFlow.unfilled, withFlow.omitted, withFlow.adopted, withFlow.unplaced], [without.unfilled, without.omitted, without.adopted, without.unplaced]);
  assert.deepEqual(without.extras, []);
  assert.ok(!A.toText(without).includes("場面・症候の入力"), "no answers, no block (and no heading made up)");
  // a case with nothing but the flow's answers: the exam field is （未入力）, it is not pretended to hold them
  const only = A.assemble("A04", { kase: { structured: FLOW } });
  const exam = only.sections.find((s: any) => s.key === "exam");
  assert.ok(exam.empty && only.unfilled.includes("exam"));
  assert.match(A.toText(only), /■身体診察\n（未入力）\n/);
  assert.equal(only.extras.length, 1);
});

test("A04: the block holds the answered lines only: nothing is added that reads as negative or normal, and the notes meant for the model stay out", () => {
  const note = A.assemble("A04", { kase: { structured: FLOW } });
  const lines = note.extras[0].text.split("\n");
  const answered = FLOW.split("\n").filter((l) => !l.startsWith("未入力の中核項目") && !l.startsWith("場面・症候: "));
  assert.deepEqual(lines, ["【救急外来 × 腹痛】", ...answered]);
  const text = A.toText(note);
  assert.ok(!text.includes("未入力の中核項目") && !text.includes("clinical-modules") && !text.includes("陰性ではありません"));
  // the one sentence the assembly adds says the absent items are unchecked
  assert.match(A.INPUT_BLOCK_NOTE, /ここにない項目は未確認で、陰性・正常を意味しません/);
  assert.doesNotMatch(text.replace(A.INPUT_BLOCK_NOTE, ""), /異常なし|正常|陰性|なし/);
});

test("A04: the block is the doctor's own input, so dropping the AI mark and the source marks does not touch it", () => {
  const note = A.assemble("A04", { kase: { ...KASE, structured: FLOW }, items: [item("plan", "輸液の反応を見る [標準・出典未確認]", [BOOK])] });
  for (const opts of [{}, { aiMark: false }, { sourceMarks: false }, { aiMark: false, sourceMarks: false }]) {
    const t = A.toText(note, opts);
    assert.match(t, /■場面・症候の入力\n.*\n【救急外来 × 腹痛】\n［受け入れ］\n第一印象：sick/, JSON.stringify(opts));
    assert.ok(!t.includes("AI草案〕第一印象") && !t.includes("［書籍］"), JSON.stringify(opts));
  }
  // the AI source list still comes last
  const full = A.toText(note);
  assert.ok(full.indexOf("■場面・症候の入力") < full.indexOf("■AI草案の出典（採用した項目）"));
});

test("scope: only A04 keeps the answers apart; A01 and the other types place them as before (docs/enhancement-plan.md 8.18)", () => {
  assert.deepEqual(A.INPUT_BLOCK, { A04: ["structured"] });
  for (const id of Object.keys(A.INPUT_BLOCK)) assert.ok(A.ENABLED.includes(id));
  for (const [field, parts] of Object.entries<string[]>(A.FILL.A04)) assert.ok(!parts.includes("structured"), `A04.${field} still names the flow's answers`);
  assert.deepEqual(A.FILL.A01.exam, ["findings", "structured"]);
  for (const id of A.ENABLED.filter((t: string) => t !== "A04")) {
    const note = A.assemble(id, { kase: { ...KASE, structured: FLOW } });
    assert.deepEqual(note.extras, [], id);
    assert.ok(JSON.stringify(note.sections).includes("第一印象：sick"), `${id} still carries the answers in a field`);
    assert.ok(!A.toText(note).includes("■場面・症候の入力"), id);
  }
  assert.match(A.toText(A.assemble("A01", { kase: { ...KASE, structured: FLOW } })), /■身体診察\n［身体所見・検査・画像・心電図］\nCr 2\.4 mg\/dL, K 5\.8 mEq\/L\n［場面・症候の入力（フローの質問への答え）］\n【救急外来 × 腹痛】\n［受け入れ］/);
  // the sections of A04 are still the type's own, in its order, with and without the answers
  assert.deepEqual(sectionKeys(A.assemble("A04", { kase: { structured: FLOW } })), sectionKeys(A.assemble("A04", { kase: {} })));
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
  for (const f of ["note-assemble.js", "note-ui.js", "note-types.js", "draft-scenes.js"]) {
    const code = readFileSync(web(f), "utf-8").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(code, forbidden, f);
  }
  // nothing from the AI side is imported by the assembly: it is deterministic
  const asm = readFileSync(web("note-assemble.js"), "utf-8");
  assert.deepEqual([...asm.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]), ["./case-model.js", "./draft-scenes.js", "./note-types.js"]);
  // the scenes' headings are plain data: they import nothing at all (docs/enhancement-plan.md 8.16)
  assert.deepEqual([...readFileSync(web("draft-scenes.js"), "utf-8").matchAll(/^import /gm)], []);
  const ui = readFileSync(web("note-ui.js"), "utf-8");
  assert.deepEqual([...ui.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]).sort(), ["./note-assemble.js", "./note-types.js"]);
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
