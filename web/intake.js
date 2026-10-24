// Structured intake from a scene x symptom flow of clinical-modules (docs/enhancement-plan.md 8; the doctor's decisions in
// docs/clinical-use.md 1e).  Pure functions over the imported question structure (web/flow-schema.js): which questions are visible,
// which core questions are still unanswered, how the answers read as text.  No AI, no DOM, no network, no storage.
//
// A question is answered only when the doctor answered it.  A blank is never an answer, never "none", never normal: the unanswered
// core questions are listed as "未入力（未確認。陰性ではない）".  The flows' rules, differentials and axes are not here (not imported).
import { relativizeDates } from "./date-relative.js";

/** Questions the case's own fields already hold: the exact age is not entered (the case has an age band), the sex is its select. */
export const SKIP = new Set(["age", "sex"]);
const SEX = { 男性: "m", 女性: "f", "その他・不明": "unk" };
/** The most characters of the structured text sent with a case (the Worker accepts the same number). */
export const STRUCTURED_LIMIT = 6000;

// ---------------------------------------------------------------- conditions: q=a,b  q?  ! & | ( )  always  $name
const TOKEN = /\s*(\(|\)|!|&|\||\$[A-Za-z0-9_]+|[A-Za-z0-9_]+(?:\?|=[A-Za-z0-9_,]+)?)/y;

function tokens(src) {
  const out = [];
  TOKEN.lastIndex = 0;
  let m;
  while (TOKEN.lastIndex < src.length && (m = TOKEN.exec(src))) out.push(m[1]);
  return out;
}

/** Compiles a condition into a function (ctx, defs) -> boolean.  An unknown name is false; a malformed condition is false. */
export function compileWhen(src) {
  const t = tokens(String(src ?? ""));
  let i = 0;
  const atom = () => {
    const x = t[i++];
    if (x === "(") {
      const f = or();
      i++; // ")"
      return f;
    }
    if (x === "!") {
      const f = atom();
      return (c, d) => !f(c, d);
    }
    if (x === undefined) return () => false;
    if (x === "always") return () => true;
    if (x.startsWith("$")) {
      const name = x.slice(1);
      return (c, d) => (d?.[name] !== undefined ? compileCached(d[name])(c, d) : false);
    }
    if (x.endsWith("?")) {
      const q = x.slice(0, -1);
      return (c) => isAnswered(c[q]);
    }
    const [q, list] = x.split("=");
    const want = (list ?? "").split(",");
    return (c) => {
      const v = c[q];
      return Array.isArray(v) ? v.some((y) => want.includes(y)) : typeof v === "string" && want.includes(v);
    };
  };
  const and = () => {
    let f = atom();
    while (t[i] === "&") {
      i++;
      const g = atom();
      const a = f;
      f = (c, d) => a(c, d) && g(c, d);
    }
    return f;
  };
  const or = () => {
    let f = and();
    while (t[i] === "|") {
      i++;
      const g = and();
      const a = f;
      f = (c, d) => a(c, d) || g(c, d);
    }
    return f;
  };
  return or();
}
const cache = new Map();
const compileCached = (src) => {
  let f = cache.get(src);
  if (!f) cache.set(src, (f = compileWhen(src)));
  return f;
};

export const isAnswered = (v) => (Array.isArray(v) ? v.length > 0 : typeof v === "number" ? Number.isFinite(v) : typeof v === "string" && v.trim() !== "");

/** The values the conditions read: the answers, and the sex from the case's own select. */
export const contextOf = (answers, kase) => ({ ...answers, ...(kase?.sex && SEX[kase.sex] ? { sex: SEX[kase.sex] } : {}) });

export const isVisible = (flow, q, ctx) => !q.when || compileCached(q.when)(ctx, flow.defs);

/** The flow's questions the intake offers, by phase: [{ phase, questions }].  Questions the case already holds are left out. */
export function byPhase(flow) {
  return flow.phases.map((phase) => ({ phase, questions: flow.questions.filter((q) => phase.slots.includes(q.slot) && !SKIP.has(q.id)) }));
}

const plainLabel = (s) => String(s).replace(/^★\d+\s*/, "").trim();

/** The visible core questions that have no answer: [{ id, label, phase }] in the flow's order. */
export function coreMissing(flow, answers, kase) {
  const ctx = contextOf(answers, kase);
  const out = [];
  for (const { phase, questions } of byPhase(flow)) {
    for (const q of questions) if (q.core && isVisible(flow, q, ctx) && !isAnswered(answers[q.id])) out.push({ id: q.id, label: plainLabel(q.label), phase: phase.short ?? phase.name });
  }
  return out;
}

/** How many visible core questions there are, and how many are answered. */
export function coreCount(flow, answers, kase) {
  const ctx = contextOf(answers, kase);
  let all = 0;
  let done = 0;
  for (const { questions } of byPhase(flow)) {
    for (const q of questions) {
      if (!q.core || !isVisible(flow, q, ctx)) continue;
      all++;
      if (isAnswered(answers[q.id])) done++;
    }
  }
  return { all, done };
}

const optText = (o) => o.short ?? o.label;

/** An answer as words: the option's short form (or label), the number with its unit, the time, the text. */
export function valueText(q, v) {
  if (!isAnswered(v)) return "";
  if (q.type === "choice") return optText(q.options.find((o) => o.id === v) ?? { label: String(v) });
  if (q.type === "multi") return v.map((id) => optText(q.options.find((o) => o.id === id) ?? { label: String(id) })).join("、");
  if (q.type === "number") return `${v}${q.unit ? ` ${q.unit}` : ""}`;
  return String(v).trim();
}

/** Sets one answer.  Choosing "none" in a multi question (its `exclusive` options) clears the others, and choosing another clears "none". */
export function setAnswer(flow, answers, qid, value) {
  const q = flow.questions.find((x) => x.id === qid);
  const next = { ...answers };
  if (!q || !isAnswered(value)) {
    delete next[qid];
    return next;
  }
  if (q.type === "multi") {
    const ex = new Set(q.exclusive ?? []);
    const picked = value.filter((id) => q.options.some((o) => o.id === id));
    const last = picked.at(-1);
    next[qid] = ex.has(last) ? [last] : picked.filter((id) => !ex.has(id));
    if (!next[qid].length) delete next[qid];
  } else next[qid] = value;
  return next;
}

/**
 * Answers read back from a saved conversation (or any untrusted shape): only questions the flow has, values the question accepts.
 * Returns { answers, dropped } (dropped: how many entries were not kept).
 */
export function cleanAnswers(flow, raw) {
  const answers = {};
  let dropped = 0;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { answers, dropped };
  for (const [id, v] of Object.entries(raw)) {
    const q = flow.questions.find((x) => x.id === id);
    let ok = null;
    if (q && !SKIP.has(id)) {
      if (q.type === "choice" && typeof v === "string" && q.options.some((o) => o.id === v)) ok = v;
      else if (q.type === "multi" && Array.isArray(v)) {
        const ids = v.filter((x) => typeof x === "string" && q.options.some((o) => o.id === x));
        if (ids.length) ok = setAnswer(flow, {}, id, ids)[id];
      } else if (q.type === "number" && typeof v === "number" && Number.isFinite(v)) ok = v;
      else if (q.type === "time" && typeof v === "string" && /^\d{2}:\d{2}$/.test(v)) ok = v;
      else if (q.type === "text" && typeof v === "string" && v.trim()) ok = v.trim().slice(0, 600);
    }
    if (ok === null) dropped++;
    else answers[id] = ok;
  }
  return { answers, dropped };
}

/** One answer as a line in the flow's own wording (`line`, with {value}), or "label：value".  A date in a text answer is made relative. */
export function lineText(q, value, { now = new Date() } = {}) {
  let v = valueText(q, value);
  if (q.type === "text") v = relativizeDates(v, { now }).text;
  return q.line?.includes("{value}") ? q.line.replace("{value}", v) : `${plainLabel(q.label)}：${v}`;
}

/** The label of a question without its ★n marker and its bracketed explanation, cut for a list. */
export const shortLabel = (label, n = 22) => clip((plainLabel(label).split(/[（(]/)[0].trim() || plainLabel(label)).trim(), n);

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * The structured answers as text for the model and the note: the flow, then the answered visible questions by phase in the flow's own
 * wording (`line`), then the core questions still unanswered ("未確認。陰性ではない").  Dates in a text answer are made relative.
 * Returns "" when nothing is answered.
 */
export function renderStructured(flow, answers, kase, { now = new Date() } = {}) {
  const ctx = contextOf(answers, kase);
  const lines = [];
  for (const { phase, questions } of byPhase(flow)) {
    const mine = [];
    for (const q of questions) {
      if (!isVisible(flow, q, ctx) || !isAnswered(answers[q.id])) continue;
      mine.push(lineText(q, answers[q.id], { now }));
    }
    if (mine.length) lines.push(`［${phase.short ?? phase.name}］`, ...mine);
  }
  if (!lines.length) return "";
  const missing = coreMissing(flow, answers, kase);
  const out = [`場面・症候: ${flow.title}（clinical-modules のフローの質問への答え。未入力の項目は未確認で、陰性ではありません）`, ...lines];
  if (missing.length) {
    const shown = missing.slice(0, 40).map((m) => shortLabel(m.label));
    out.push(`未入力の中核項目（${missing.length}件。未確認）: ${shown.join("、")}${missing.length > shown.length ? `、ほか${missing.length - shown.length}件` : ""}`);
  }
  let text = out.join("\n");
  if (text.length > STRUCTURED_LIMIT) text = `${text.slice(0, STRUCTURED_LIMIT - 1)}…`;
  return text;
}

/** Flows to offer, grouped by scene: [{ scene, flows: [{ id, title }] }] (titles are "救急外来 × 胸痛"). */
export function flowChoices(FLOWS) {
  const groups = new Map();
  for (const f of Object.values(FLOWS)) {
    const scene = f.title.split("×")[0].trim();
    if (!groups.has(scene)) groups.set(scene, []);
    groups.get(scene).push({ id: f.id, title: f.title });
  }
  return [...groups].map(([scene, flows]) => ({ scene, flows }));
}
