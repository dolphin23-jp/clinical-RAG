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

test("web/extract-model.js is pure: no DOM, no network, no storage, no AI", () => {
  const src = readFileSync(web("extract-model.js"), "utf-8").replace(/\/\/[^\n]*/g, "");
  for (const bad of [/\bfetch\(/, /localStorage|sessionStorage|indexedDB/, /\bdocument\./, /\bwindow\./, /XMLHttpRequest|WebSocket/, /anthropic|\/api\//i]) assert.doesNotMatch(src, bad);
});
