// "文章から取り込む": the screen's side without a screen (web/extract-model.js): the proposals checked again against the flow and the memo, how heavy
// each is to confirm, and what each would do to the answers already entered.  Pinned: a proposal is never a judgment, a plain fact is the only
// thing that can be confirmed with others, a negation / a time / a thing done / a measurement's condition is looked at alone, and an answer
// already entered is never overwritten by a proposal (it takes its own confirmation).  The file is pure (no DOM, no network, no storage, no AI).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO } from "./nodeDb.ts";

const web = (f: string) => join(REPO, "web", f);
const M: any = await import(web("extract-model.js"));
const I: any = await import(web("intake.js"));
const SCHEMA: any = await import(web("flow-schema.js"));

const flow = SCHEMA.FLOWS["emergency-department.dyspnea"];
const MEMO = "78歳。2時間前からの呼吸困難。病着 10:20。呼吸数28、室内気でSpO2 88%。両側でcrackles。胸痛なし。既往は特になし。体温38.5℃。酸素10Lを開始した。";
const P = (q: string, v: string[], frag: string) => ({ q, v, frag });
const ctx = (answers: any = {}) => I.contextOf(answers, { sex: "男性" });

test("extractable: facts only — not the case's fields, a judgment, a plan, a disposition, a reason, or a question that says it is a judgment", () => {
  const byId = Object.fromEntries(flow.questions.map((q: any) => [q.id, q]));
  for (const id of ["rr", "spo2", "o2", "lung_exam", "t_arrival", "hx_chest", "bp", "pmh", "airway_tx", "ems_tx"]) assert.equal(M.extractable(byId[id]), true, id);
  for (const id of ["age", "sex", "spo2_cat", "temp_cat", "stability", "pe_prob", "dispo", "consult", "handoff", "plan_text", "goals", "circ", "labs", "unable_reason", "unexplained"]) assert.equal(M.extractable(byId[id]), false, id);
  assert.equal(M.extractable({ id: "x", type: "number", label: "ふつうの数", br: { ent: "observation" } }), true);
  assert.equal(M.extractable({ id: "x", type: "number", label: "ふつうの数", br: {} }), false, "a question with no entity is not offered");
  assert.equal(M.extractable({ id: "x", type: "weird", label: "a", br: { ent: "observation" } }), false);
  assert.equal(M.extractable({ id: "x", type: "choice", label: "数値を見たうえでの判断", br: { ent: "observation" } }), false);
});

test("reviewProposals: the quote must be in the memo and the value one the question accepts; a question once; a judgment never; in the flow's order", () => {
  const r = M.reviewProposals(
    flow,
    [
      P("temp", ["38.5"], "体温38.5℃"),
      P("rr", ["28"], "呼吸数28"),
      P("spo2", ["88"], "SpO2 88%"),
      P("spo2_cat", ["low"], "SpO2 88%"), // a judgment
      P("o2", ["ra"], "室内気で"),
      P("lung_exam", ["crackles"], "両側でcrackles"),
      P("hx_chest", ["none"], "胸痛なし"),
      P("t_arrival", ["10:20"], "病着 10:20"),
      P("pmh", ["none"], "既往は特になし"),
      P("airway", ["patent"], "気道は開通"), // not in the memo
      P("rr", ["28"], "呼吸数28"), // twice
      P("nope", ["x"], "SpO2"),
      { q: "jvd", v: "none", frag: "頸静脈" }, // not in the memo either
    ],
    MEMO,
  );
  assert.deepEqual(r.items.map((i: any) => i.qid), ["t_arrival", "hx_chest", "pmh", "rr", "spo2", "o2", "lung_exam", "temp"], "the flow's order");
  assert.equal(r.dropped, 5, "the judgment, the made-up quote, the second rr, the unknown question, the other made-up quote");
  const v = Object.fromEntries(r.items.map((i: any) => [i.qid, i.value]));
  assert.deepEqual([v.rr, v.spo2, v.temp, v.o2, v.lung_exam, v.t_arrival, v.pmh], [28, 88, 38.5, "ra", ["crackles"], "10:20", ["none"]], "a number is a number, a multi an array");
  // a string for a non-multi question is taken as the one value
  assert.equal(M.reviewProposals(flow, [{ q: "o2", v: "ra", frag: "室内気" }], MEMO).items.length, 1);
  assert.deepEqual(M.reviewProposals(flow, "nothing", MEMO), { items: [], dropped: 0 });
  assert.deepEqual(M.reviewProposals(flow, [null, 3, {}], MEMO), { items: [], dropped: 3 });
});

test("whyHigh: what makes a proposal one to look at alone", () => {
  const q = (id: string) => flow.questions.find((x: any) => x.id === id);
  assert.deepEqual(M.whyHigh(q("rr"), 28, "呼吸数28"), [], "a plain number");
  assert.deepEqual(M.whyHigh(q("lung_exam"), ["crackles"], "両側でcrackles"), [], "a plain finding");
  assert.deepEqual(M.whyHigh(q("lung_exam"), ["crackles"], "両側でcracklesはない").sort(), ["否定の言い方"], "the same words turned around by the memo");
  assert.ok(M.whyHigh(q("lung_exam"), ["normal"], "聴診上は問題なし").includes("「異常なし・陰性」の選択肢"), "a normal-finding option");
  assert.ok(M.whyHigh(q("pmh"), ["none"], "既往なし").some((w: string) => /否定|選択肢/.test(w)), "none of the history");
  assert.ok(M.whyHigh(q("t_arrival"), "10:20", "病着 10:20").includes("時刻"), "a time");
  assert.ok(M.whyHigh(q("airway_tx"), ["intubate"], "挿管した").includes("行った処置"), "a thing done");
  assert.ok(M.whyHigh(q("o2"), "ra", "室内気").includes("測定の条件"), "the condition of a measurement");
  assert.ok(M.whyHigh(q("hx_chest"), "none", "胸痛なし").includes("否定の言い方"));
  assert.ok(M.whyHigh(q("hx_chest"), "pressure", "胸痛の疑い").includes("不確かな言い方"));
  assert.ok(M.whyHigh(q("resp_tx"), ["o2"], "酸素投与を依頼").includes("予定・指示・結果待ちの言い方"));
  assert.ok(M.whyHigh(q("cxr"), ["infiltrate"], "胸部X線は結果待ち").includes("予定・指示・結果待ちの言い方"));
  assert.ok(M.whyHigh(q("hx_chest"), "none", "胸痛(-)").includes("否定の言い方"), "(-)");
  assert.ok(M.whyHigh(q("hx_chest"), "none", "胸痛（－）").includes("否定の言い方"), "full-width (-)");
});

test("classify: new / same / differs / hidden against the answers entered, low or high to confirm; nothing here changes an answer", () => {
  const { items } = M.reviewProposals(flow, [P("rr", ["28"], "呼吸数28"), P("spo2", ["88"], "SpO2 88%"), P("o2", ["ra"], "室内気"), P("lung_exam", ["crackles"], "両側でcrackles"), P("hx_chest", ["none"], "胸痛なし"), P("temp", ["38.5"], "体温38.5℃"), P("preg", ["unable"], "妊娠 評価不能")], MEMO.replace("体温38.5℃", "体温38.5℃。妊娠 評価不能"));
  const answers = { rr: 28, spo2: 90, lung_exam: ["wheeze"] };
  const before = JSON.stringify(answers);
  const c = Object.fromEntries(M.classify(flow, answers, ctx(answers), items).map((i: any) => [i.qid, i]));
  assert.equal(JSON.stringify(answers), before, "the answers are not touched");
  assert.equal(c.rr.state, "same", "the same answer is entered");
  assert.equal(c.spo2.state, "differs");
  assert.equal(c.spo2.currentText, "90 %", "what is entered, in words");
  assert.equal(c.lung_exam.state, "differs");
  assert.equal(c.temp.state, "new");
  assert.equal(c.temp.risk, "low");
  assert.equal(c.temp.valueText, "38.5 ℃");
  assert.equal(c.o2.risk, "high");
  assert.equal(c.hx_chest.risk, "high");
  assert.ok(c.hx_chest.why.length >= 1);
  assert.equal(c.temp.label.length > 0, true);
  // a question the conditions do not show now is "hidden" (a female-only question for a man)
  assert.equal(c.preg.state, "hidden");
  // answering the question that shows it shows it (here: the sex of the case, through the context)
  const woman = M.classify(flow, answers, I.contextOf(answers, { sex: "女性" }), items).find((i: any) => i.qid === "preg");
  assert.equal(woman.state, "new");
  // the same set compared whatever the order
  const multi = M.reviewProposals(flow, [P("lung_exam", ["crackles", "wheeze"], "crackles、wheeze")], "crackles、wheeze").items;
  assert.equal(M.classify(flow, { lung_exam: ["wheeze", "crackles"] }, ctx(), multi)[0].state, "same");
});

test("sentenceOf and the weight of a confirmation: a negation or a doubt outside the quoted words still makes it one to look at alone", () => {
  assert.equal(M.sentenceOf("呼吸困難あり。胸痛なし。咳が出る。", "胸痛"), "胸痛なし");
  assert.equal(M.sentenceOf("体温 38.5℃で、呼吸数28。", "呼吸数28"), "体温 38.5°Cで、呼吸数28", "a comma does not end a sentence; a decimal point does not either (the text is NFKC: ℃ reads °C)");
  assert.equal(M.sentenceOf("SpO2 88%\n呼吸数28", "ｓｐｏ２ ８８"), "SpO2 88%", "width, case and spaces are not a difference");
  assert.equal(M.sentenceOf("a(b)+c。d", "(b)+"), "a(b)+c", "the quote's own characters are not a pattern");
  assert.equal(M.sentenceOf("何もない", "ない"), "何もない");
  assert.equal(M.sentenceOf("x", "別の文"), "別の文", "not found: the quote itself");
  assert.equal(M.sentenceOf("x", ""), "");
  const { items } = M.reviewProposals(flow, [P("hx_chest", ["pressure"], "胸痛")], "胸痛なし。呼吸困難。");
  assert.equal(items[0].sentence, "胸痛なし");
  const c = M.classify(flow, {}, ctx(), items)[0];
  assert.equal(c.risk, "high", "the quote alone has no negation; its sentence does");
  assert.ok(c.why.includes("否定の言い方"));
  const plain = M.classify(flow, {}, ctx(), M.reviewProposals(flow, [P("rr", ["28"], "呼吸数28")], "呼吸数28。咳はなし。").items)[0];
  assert.equal(plain.risk, "low", "another sentence's negation does not count");
  const doubt = M.classify(flow, {}, ctx(), M.reviewProposals(flow, [P("lung_exam", ["crackles"], "crackles")], "両側でcracklesかも").items)[0];
  assert.equal(doubt.risk, "high");
});

test("extractable: no option says it is the doctor's judgment, and the questions found to hold a reading or a decision are not offered (any flow)", () => {
  const present = new Set<string>();
  for (const f of Object.values(SCHEMA.FLOWS) as any[]) {
    for (const q of f.questions) {
      present.add(q.id);
      if (!M.extractable(q)) continue;
      assert.ok(!M.JUDGMENT_IDS.has(q.id), `${f.id} ${q.id}`);
      for (const o of q.options ?? []) assert.doesNotMatch(o.label, /判断|医師の/, `${f.id} ${q.id}.${o.id}: an option that is the doctor's own judgment`);
    }
  }
  for (const id of M.JUDGMENT_IDS) assert.ok(present.has(id), `${id} is in no imported flow: a renamed question is to be looked at again`);
  const f = SCHEMA.FLOWS;
  const by = (flow: string, id: string) => f[flow].questions.find((q: any) => q.id === id);
  for (const [flow, id] of [["emergency-department.gi-bleeding", "vbg_res"], ["emergency-department.nausea-vomiting", "vbg_res"], ["emergency-department.gi-bleeding", "labs_res"], ["emergency-department.shock", "skin"], ["emergency-department.consciousness", "ems_glu"], ["emergency-department.chest-pain", "circ"], ["emergency-department.dizziness", "re_change"], ["outpatient-first-visit.fever", "antipyretic_tx"]]) {
    assert.equal(M.extractable(by(flow, id)), false, `${flow} ${id}`);
  }
  assert.equal(M.extractable(by("emergency-department.abdominal-pain", "vbg_res")), true, "a blood-gas question whose options are plain findings stays (its quote is checked against the option's own words)");
});

// a negation, a doubt, a plan, an approximation or a bound in any of the wordings a Japanese note uses must not leave a proposal in the "together" group
test("whyHigh: the wordings of a negation, a doubt, a plan or an approximation (Japanese and English) are looked at alone; a plain finding is not", () => {
  const q = flow.questions.find((x: any) => x.id === "lung_exam");
  const sentences = [
    "両側でcracklesは聴取せず", "cracklesは認められず", "cracklesは見られず", "cracklesは聞こえず", "cracklesを認めず", "cracklesはなかった", "cracklesはありません", "cracklesを除外", "cracklesは乏しい",
    "crackles：否", "no crackles", "denies crackles", "crackles negative", "crackles neg", "w/o crackles", "r/o crackles", "crackles ( - )", "crackles (ー)", "crackles（－）",
    "cracklesと思う", "cracklesらしい", "cracklesのようだ", "crackles未評価", "cracklesは測定できず", "cracklesの可能性", "cracklesが疑われる",
    "cracklesを確認してほしい", "cracklesの再評価を検討", "cracklesの確認が必要", "約3か所でcrackles", "crackles程度", "100台でcrackles", "crackles前後", "crackles 以上",
  ];
  for (const t of sentences) {
    const { items } = M.reviewProposals(flow, [P("lung_exam", ["crackles"], "crackles")], t);
    assert.equal(items.length, 1, t);
    assert.equal(M.classify(flow, {}, ctx(), items)[0].risk, "high", `「${t}」 is one to look at alone`);
  }
  for (const t of ["両側でcrackles", "背部でcracklesを聴取", "crackles +", "Crackles あり"]) {
    const { items } = M.reviewProposals(flow, [P("lung_exam", ["crackles"], "crackles")], t);
    assert.equal(M.classify(flow, {}, ctx(), items)[0].risk, "low", `「${t}」 is a plain finding`);
  }
});

test("whyHigh: a quote that has nothing to do with the question or the chosen option is shown to be looked at (an unrelated number, a category read from a number)", () => {
  const run = (fid: string, qid: string, v: string[], frag: string, memo: string) => {
    const fl = SCHEMA.FLOWS[fid];
    const { items } = M.reviewProposals(fl, [P(qid, v, frag)], memo);
    assert.equal(items.length, 1, `${qid} ${frag}`);
    return M.classify(fl, {}, I.contextOf({}, { sex: "男性" }), items)[0];
  };
  const MISMATCH = /引用が、この質問・選択肢の言葉と合っていません/;
  const a = run("emergency-department.dyspnea", "hx_chest", ["pressure"], "BP 120/80", "BP 120/80、胸痛なし");
  assert.equal(a.risk, "high");
  assert.ok(a.why.some((w: string) => MISMATCH.test(w)), "a chest-pain character from a blood pressure");
  const b = run("emergency-department.dyspnea", "rr", ["80"], "BP 120/80", "BP 120/80");
  assert.ok(b.why.some((w: string) => MISMATCH.test(w)), "a respiratory rate from a blood pressure");
  const c = run("emergency-department.abdominal-pain", "vbg_res", ["lactate"], "乳酸 4.2", "乳酸 4.2 でした");
  assert.equal(c.risk, "high", "'乳酸の上昇' is not what '乳酸 4.2' says: a category read from a number");
  assert.ok(c.why.some((w: string) => MISMATCH.test(w)));
  const ok = run("emergency-department.abdominal-pain", "vbg_res", ["lactate"], "乳酸の上昇あり", "乳酸の上昇あり");
  assert.ok(!ok.why.some((w: string) => MISMATCH.test(w)), "the same words: related");
  // a "none" the memo does not say: the unmentioned finding made "none"
  const d = run("emergency-department.dyspnea", "hx_chest", ["none"], "SpO2 88%", "SpO2 88%。呼吸困難。");
  assert.ok(d.why.some((w: string) => /書かれていないことを「なし」にしていないか/.test(w)), "no word in the memo that says none");
  const e = run("emergency-department.dyspnea", "hx_chest", ["none"], "胸痛なし", "胸痛なし");
  assert.ok(!e.why.some((w: string) => /書かれていないこと/.test(w)), "the memo says none");
});

test("whyHigh: an option that reads as none / normal / not done / unknown by its own label, and what was done by a question's own words, are looked at alone", () => {
  const find = (fid: string, id: string) => SCHEMA.FLOWS[fid].questions.find((q: any) => q.id === id);
  const q = find("emergency-department.dyspnea", "ems_tx"); // EMS treatments: a list of things done, in a "context" question
  assert.ok(M.whyHigh(q, ["o2"], "酸素", "救急隊が酸素を投与").includes("行った処置"));
  const n = find("emergency-department.dyspnea", "skin");
  assert.ok(M.whyHigh(n, ["normal"], "特記なし", "皮膚は特記なし").length >= 1, "'特記なし'");
});

test("reviewProposals: a quote of one character or only punctuation is not a quote; a time must be written, with its minutes, in the quote", () => {
  const r = M.reviewProposals(flow, [P("rr", ["28"], "28"), P("o2", ["ra"], "。"), P("hx_chest", ["none"], "胸")], "呼吸数28。室内気。胸痛なし。");
  assert.deepEqual(r.items.map((i: any) => i.qid), ["rr"], "two characters that are not punctuation are the least; '28' is such a quote");
  assert.equal(r.dropped, 2);
  const t = (v: string, frag: string, memo = frag) => M.reviewProposals(flow, [P("t_arrival", [v], frag)], memo).items.length;
  assert.equal(t("10:45", "10:20"), 0, "the minutes are the quote's");
  assert.equal(t("10:30", "10分前"), 0, "a length of time is not a time");
  assert.equal(t("10:20", "病着 10:20"), 1);
});

test("web/extract-model.js is pure: no DOM, no network, no storage, no AI", () => {
  const src = readFileSync(web("extract-model.js"), "utf-8").replace(/\/\/[^\n]*/g, "");
  for (const bad of [/\bfetch\(/, /localStorage|sessionStorage|indexedDB/, /\bdocument\./, /\bwindow\./, /XMLHttpRequest|WebSocket/, /anthropic|\/api\//i]) assert.doesNotMatch(src, bad);
});
