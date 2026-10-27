// "文章から取り込む": the parts without a screen (docs/enhancement-plan.md 8.12, 8.15).  The doctor pastes a memo; the Worker (worker/src/extract.ts) asks
// the model for proposals; this file checks them again against the flow itself and against the memo, says how heavy each is to confirm, and
// says what each would do to the answers already entered.  Pure functions: no DOM, no network, no storage, no AI.
//
// What a proposal is: a fact written in the memo (with the words it comes from), never a judgment.  A question that holds the doctor's own
// judgment (a category of a number, a clinical probability), a plan or a disposition is not offered to the model at all (`extractable`).  Nothing
// here changes an answer: the screen applies a proposal only when the doctor says so, and an answer already entered is never overwritten
// without its own confirmation.  The pure checks below are twins of worker/src/extract.ts: tests/vectors/extract.json is run against both.
import { SKIP, isAnswered, isVisible, shortLabel, valueText } from "./intake.js";

/** The longest memo taken in one request (the Worker's MAX_TEXT; worker/test/extract.test.ts keeps them equal). */
export const EXTRACT_LIMIT = 20_000;
export const MAX_FRAG = 60;
export const MAX_TEXT_VALUE = 200;

const TYPES = new Set(["choice", "multi", "number", "time", "text"]);
/** What a question may be about for the model to propose an answer: the facts of the history and the findings, the times, what was done, the conditions of a measurement. */
export const EXTRACT_ENTITIES = new Set(["context", "observation", "time", "action", "condition"]);

/**
 * Questions that look like facts but hold the doctor's own reading or decision (found by an independent review of the flows' wording): an impression
 * ("sick"), a comparison over time ("better / same / worse"), the integrated reading of the circulation, a category read from a number (a glucose
 * "low / normal / high"), the reading of a bedside test, the effect or response to a treatment, whether something was needed, a prescribing or
 * culture decision.  Not offered to the model whatever their entity says; a test checks that each exists in the imported schema (so a rename is noticed).
 */
export const JUDGMENT_IDS = new Set([
  "first", "ems_state", "re_change", "re_exam", "circ", "ems_glu", "fluid_resp", "analg_eff", "real_syncope", "hidden", "walk_spo2", "hi", "skew",
  "orth", "plr", "benzo", "second_tx", "bc", "epley_res", "antipyretic_tx", "trop2",
  // the time the doctor decided where the patient goes: part of the decision (clinical-modules declares it as the decision's `at` since 2026-10-26),
  // and a recorded time makes the decision "decided" there; a memo's time is not proposed for it
  "t_dispo",
]);
/** A question or an option that says in its own words that it is the doctor's judgment. */
const JUDGMENT_WORDS = /判断|医師の/;

/**
 * Whether the model may be asked about a question.  Not: the case's own fields (age, sex), an assessment (a category read from a number, a
 * probability, a severity), the plan (consult, disposition, handoff, goals), a reason, a question whose label or any option says it is a
 * judgment ("（医師の判断）"), and the questions of JUDGMENT_IDS.  scripts/build_extract_catalog.mjs builds the Worker's list from this one function.
 */
export const extractable = (q) =>
  !SKIP.has(q.id) && TYPES.has(q.type) && EXTRACT_ENTITIES.has(q.br?.ent) && !JUDGMENT_IDS.has(q.id) && !JUDGMENT_WORDS.test(q.label) && !(q.options ?? []).some((o) => JUDGMENT_WORDS.test(Array.isArray(o) ? o[1] : o.label));

// ---------------------------------------------------------------- the pure checks (twin of worker/src/extract.ts)
/** For matching a fragment against the memo: NFKC, no whitespace, lower case. */
export const norm = (s) => String(s ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();

/** The numbers written in a text, as numbers ("1,200" is 1200; "38.5" is 38.5). */
export function numberTokens(s) {
  const t = String(s ?? "").normalize("NFKC").replace(/(?<=\d),(?=\d{3}(?!\d))/g, "");
  return (t.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
}

/**
 * The quote of a proposal, or null: at most MAX_FRAG characters, at least two that are not punctuation or symbols (a quote of "。" or "胸" proves
 * nothing), and in the memo (NFKC, no spaces, lower case).  `hay` is norm(memo) when the caller has it.
 */
export function fragOk(frag, memo, hay = norm(memo)) {
  const f = String(frag ?? "").trim().slice(0, MAX_FRAG);
  const n = norm(f);
  if (n.replace(/[\p{P}\p{S}]/gu, "").length < 2) return null;
  return hay.includes(n) ? f : null;
}

/**
 * The clock times written in a text, as "HH:MM": 10:20, 10時20分, 10時半, 10時.  Not "10時間" or "10分前" (a length of time is not a time).  午前/AM and
 * 午後/PM written just before make a 12-hour reading (午後3時 is 15:00); without one the hour is read as written (3時 is 03:00: the model is told to
 * leave a time whose am/pm is unknown).
 */
export function timesIn(text) {
  const out = new Set();
  const t = String(text ?? "").normalize("NFKC");
  for (const m of t.matchAll(/(午前|午後|am|pm)?\s*(\d{1,2})(?::(\d{2})|時(?!間)(?:(\d{1,2})分|半)?)/gi)) {
    let h = Number(m[2]);
    const min = m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? Number(m[4]) : /半/.test(m[0]) ? 30 : 0;
    const mark = (m[1] ?? "").toLowerCase();
    if (mark === "午後" || mark === "pm") h = (h % 12) + 12;
    else if (mark === "午前" || mark === "am") h %= 12;
    if (h > 23 || min > 59) continue;
    out.add(`${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`);
  }
  return [...out];
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const NUM = /^\d+(?:\.\d+)?$/;
const optionIds = (q) => new Set((q.options ?? []).map((o) => (Array.isArray(o) ? o[0] : o.id)));

/**
 * The value a proposal may hold for a question, or null.  choice: one option id; multi: option ids (an exclusive one stands alone); number:
 * digits written in the quote; time: a time written in the quote (hour and minute; not "10分前"); text: the memo's own words that the quote holds (or is
 * held by), with the memo's numbers only.
 */
export function checkValue(q, v, frag, memo) {
  if (!Array.isArray(v) || v.length === 0 || v.length > 40 || !v.every((x) => typeof x === "string")) return null;
  const ids = optionIds(q);
  if (q.type === "choice") return v.length === 1 && ids.has(v[0]) ? v[0] : null;
  if (q.type === "multi") {
    const uniq = [...new Set(v)];
    if (!uniq.every((x) => ids.has(x))) return null;
    const ex = new Set(q.exclusive ?? []);
    if (uniq.some((x) => ex.has(x)) && uniq.length > 1) return null;
    return uniq;
  }
  if (v.length !== 1) return null;
  const s = v[0].trim();
  if (q.type === "number") {
    if (!NUM.test(s) || !Number.isFinite(Number(s))) return null;
    return numberTokens(frag).includes(Number(s)) ? s : null;
  }
  if (q.type === "time") return TIME.test(s) && timesIn(frag).includes(s) ? s : null;
  // text: the memo's own words (not reworded), short, tied to the quote, and no number the memo does not have
  if (!s || s.length > MAX_TEXT_VALUE) return null;
  const nv = norm(s);
  const nf = norm(frag);
  if (!norm(memo).includes(nv) || !(nv.includes(nf) || nf.includes(nv))) return null;
  const have = new Set(numberTokens(memo));
  return numberTokens(s).every((n) => have.has(n)) ? s : null;
}

// ---------------------------------------------------------------- the sentence around a quote
/**
 * The sentence of the memo that holds the quote (NFKC; a sentence ends at 。 ． ！ ？ ! ? or a line break; a decimal point is not an end), or the
 * quote itself when it cannot be found.  A negation or a doubt is often not inside the few words the model quotes ("胸痛" of "胸痛なし"), so the
 * weight of a confirmation is decided on the whole sentence.
 */
export function sentenceOf(memo, frag) {
  const text = String(memo ?? "").normalize("NFKC");
  const f = String(frag ?? "").normalize("NFKC").replace(/\s+/g, "");
  if (!f) return "";
  const re = new RegExp([...f].map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*"), "i");
  const m = re.exec(text);
  if (!m) return String(frag);
  const end = /[。．！？!?\n]/;
  let a = m.index;
  while (a > 0 && !end.test(text[a - 1])) a--;
  let b = m.index + m[0].length;
  while (b < text.length && !end.test(text[b])) b++;
  return text.slice(a, b).trim();
}

// ---------------------------------------------------------------- checking what came back
/**
 * The proposals of the Worker's answer, checked again: only questions the model may be asked about, a quote that is in the memo, a value the
 * question accepts, and each question once.  Returns { items, dropped } (items in the flow's order: { qid, q, value, frag, sentence }; the value is
 * what the answers hold: a number for number, an array for multi, a string otherwise).
 */
export function reviewProposals(flow, proposals, memo) {
  const items = [];
  let dropped = 0;
  const seen = new Set();
  const hay = norm(memo);
  for (const p of Array.isArray(proposals) ? proposals : []) {
    const q = p && typeof p.q === "string" ? flow.questions.find((x) => x.id === p.q) : null;
    const frag = q && typeof p.frag === "string" ? fragOk(p.frag, memo, hay) : null;
    if (!q || !extractable(q) || seen.has(q.id) || !frag) {
      dropped++;
      continue;
    }
    const raw = Array.isArray(p.v) ? p.v : typeof p.v === "string" ? [p.v] : null;
    const v = checkValue(q, raw, frag, memo);
    if (v === null) {
      dropped++;
      continue;
    }
    seen.add(q.id);
    // the sentence of the quote, and for a text answer (the memo's own words) the sentence of the answer too: a negation can be in either
    const sentence = [sentenceOf(memo, frag), q.type === "text" ? sentenceOf(memo, v) : ""].filter(Boolean).join(" ");
    items.push({ qid: q.id, q, value: q.type === "number" ? Number(v) : v, frag, sentence });
  }
  const order = new Map(flow.questions.map((x, i) => [x.id, i]));
  items.sort((a, b) => order.get(a.qid) - order.get(b.qid));
  return { items, dropped };
}

// ---------------------------------------------------------------- how heavy a proposal is to confirm
// Words in the quote that make a proposal one to look at alone: a negation (the thing negated may be another), an uncertainty, a plan or an order.
// (the lists are wide on purpose: a word that is not really a cue only moves a proposal from "together" to "one by one")
const NEGATION = /(ない|なし|無し|無い|なく|なかっ|ません|せず|られず|めず|えず|れず|ず(?=[、。,\s]|$)|否定|陰性|除外|除く|欠如|欠く|乏しい|(?:^|[：:\s（(])否(?:$|[\s）)、。])|[(（]\s*[-−－ー–±]\s*[)）]|\bno\b|\bnot\b|denies|\bneg(?:ative)?\b|absent|w\/o|without|r\/o|rule out)/i;
const CUES = [
  [NEGATION, "否定の言い方"],
  [/(疑い|疑う|疑わ|疑って|かも|かな|？|\?|不明|不詳|可能性|多分|たぶん|おそらく|思われ|と思う|と考え|らしい|ようだ|ような|そうだ|そうです|みられ|推定|はっきりしない|未評価|測定できず|測定不能|評価できず|拒否)/, "不確かな言い方"],
  [/(予定|依頼|オーダー|指示|検討|待ち|未実施|未施行|未確認|してください|して下さい|してほしい|お願い|方針|考慮|必要|希望)/, "予定・指示・結果待ちの言い方"],
  [/(約|くらい|ぐらい|程度|前後|頃|ごろ|\d+台|以上|以下|未満|超え|[~〜～])/, "概数・範囲の言い方"],
];
const NORMAL_WORDS = new RegExp(`${NEGATION.source}|正常|問題なし|異常なし|特記|良好|保たれ|\\bwnl\\b|\\bnad\\b|unremarkable|clear`, "i");
const BRIDGE_WHY = { neg: "「異常なし・陰性」の選択肢", unk: "「不明」の選択肢", unable: "「評価不能」の選択肢", wait: "「未実施・結果待ち」の選択肢", pend: "「結果待ち」の選択肢" };
const BRIDGE_WORDS = { neg: NORMAL_WORDS, unk: /(不明|不詳|わから|分から|\?|？)/, unable: /(不能|できず|できない|困難|拒否)/, wait: /(未|まだ|せず|ず|していない|待ち|不要|予定)/, pend: /(待ち|提出|保留|未)/ };
const ENTITY_WHY = { time: "時刻", action: "行った処置", condition: "測定の条件" };
/** An option that reads as "none / normal / not done / unknown / pending" by its own label, whatever the flow's classification says. */
const NONE_OPTION = /(なし|ない|無し|正常|問題なし|陰性|未|不明|不能|待ち|まだ|しない|使わない|不要|外した|いない)/;
const optionLabel = (q, id) => {
  const o = (q.options ?? []).find((x) => (Array.isArray(x) ? x[0] : x.id) === id);
  return o ? String(Array.isArray(o) ? o[1] : o.label) : "";
};

/** The 2-character pieces of a text (NFKC, no spaces, no punctuation or symbols): the smallest unit of "these words are about the same thing". */
function grams(s) {
  const t = norm(s).replace(/[\p{P}\p{S}]/gu, "");
  const g = new Set();
  for (let i = 0; i + 1 < t.length; i++) g.add(t.slice(i, i + 2));
  return g;
}

/**
 * Whether the quote shares nothing with what it is offered for: the question's own words (a number, a time, a text), or each chosen option's words that
 * the question's label does not already hold (so "乳酸 4.2" is not "乳酸の上昇" just because both say 乳酸).  It does not prove the proposal wrong;
 * a quote that has nothing to do with the question is shown to be looked at.
 */
function unrelated(q, value, frag) {
  const f = grams(frag);
  const hit = (set) => [...set].some((g) => f.has(g));
  const qg = grams(`${q.label}${q.unit ?? ""}`);
  if (q.type === "choice" || q.type === "multi") {
    for (const id of Array.isArray(value) ? value : [value]) {
      const og = grams(optionLabel(q, id));
      const own = new Set([...og].filter((g) => !qg.has(g)));
      if (!hit(own.size ? own : og)) return true;
    }
    return false;
  }
  return !hit(qg);
}

/**
 * Why a proposal is to be confirmed one by one (empty = it can be confirmed with others: a plain fact, with nothing in its wording that could turn it
 * around).  `sentence`: the sentence(s) of the memo around the quote.
 */
export function whyHigh(q, value, frag, sentence = "") {
  const why = [];
  const chosen = Array.isArray(value) ? value : q.type === "choice" ? [value] : [];
  const text = `${frag ?? ""} ${sentence ?? ""}`.normalize("NFKC"); // the quote and the sentence it is in
  for (const [key, label] of Object.entries(BRIDGE_WHY)) {
    if (!q.br?.[key]?.some((id) => chosen.includes(id))) continue;
    why.push(label);
    // a "none / unknown / pending" answer with nothing in the memo that says so is the thing to see: it is how an unmentioned finding becomes "none"
    if (!BRIDGE_WORDS[key].test(text)) why.push("引用にも前後にも、そう読める言葉がありません（書かれていないことを「なし」にしていないか）");
  }
  if (q.exclusive?.some((id) => chosen.includes(id)) && !why.length) why.push("全体を否定・限定する選択肢");
  if (chosen.some((id) => NONE_OPTION.test(optionLabel(q, id))) && !why.length) why.push("「なし・正常・未・不明」と読める選択肢");
  if (ENTITY_WHY[q.br?.ent]) why.push(ENTITY_WHY[q.br.ent]);
  else if (/処置|投与|施行|実施/.test(q.label) || /_tx$/.test(q.id)) why.push("行った処置");
  for (const [re, label] of CUES) if (re.test(text)) why.push(label);
  if (unrelated(q, value, frag)) why.push("引用が、この質問・選択肢の言葉と合っていません（取り違えていないか）");
  return [...new Set(why)];
}

const same = (a, b) => (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x) => b.includes(x)) : typeof a === "string" && typeof b === "string" ? a.trim() === b.trim() : a === b);

/**
 * What each proposal is now, against the answers entered so far and the questions the conditions show.
 *  state: "new" (nothing entered: can be taken), "same" (the same answer is entered), "differs" (another answer is entered: only an explicit
 *  overwrite takes it), "hidden" (the question is not shown now: it cannot be taken until the answers that show it are).
 *  risk: "low" (confirmed with others) or "high" (alone), with `why`.
 */
export function classify(flow, answers, ctx, items) {
  return items.map((it) => {
    const q = it.q;
    const cur = answers[it.qid];
    const why = whyHigh(q, it.value, it.frag, it.sentence);
    const state = !isVisible(flow, q, ctx) ? "hidden" : !isAnswered(cur) ? "new" : same(cur, it.value) ? "same" : "differs";
    return {
      ...it,
      label: shortLabel(q.label, 40),
      valueText: valueText(q, it.value),
      state,
      risk: why.length ? "high" : "low",
      why,
      ...(state === "differs" ? { currentText: valueText(q, cur) } : {}),
    };
  });
}
