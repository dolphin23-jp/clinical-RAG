// Routes a scene x symptom flow's answers to the fields of a chart-note type (docs/enhancement-plan.md 8.18):
//   question --(its `cat`, web/flow-schema.js, from the bridge declaration in clinical-modules)--> category
//   category + entity --(NOTE_ROUTES, web/note-types.js, from clinical-modules' ROUTES)--> field of the type
// Pure functions: no DOM, no network, no storage, no AI.  Nothing is decided here: a question has the category clinical-modules declared for it, a
// category goes where ROUTES says, and an answer that cannot be placed is KEPT and counted, never dropped and never turned into a normal finding.
//
// An answer is placed only when the doctor answered it (a blank is never an answer, never "none", never normal: intake.js).  A question whose
// category is "pending" (not classified yet) or that is not a chart item (ent "none": the doctor's decisions, preparation) goes to `rest`, with the
// reason.  A time (`at`) or measurement condition (`cond`) answer has no category of its own: it belongs to the question that declares it, and goes
// right after that question's line, to the same place (the SpO2 and "on room air" stay together).  One that no answered question declares (the
// arrival time of every emergency flow) goes to `rest`.  If the stored answers cannot be read back into exactly the text that was sent (an older
// form, a changed question list), nothing is routed and all of the text is `rest`.
import { byPhase, contextOf, isAnswered, isVisible, lineText, renderStructured } from "./intake.js";
import { NOTE_ROUTES } from "./note-types.js";

/** The types whose flow answers are routed.  A01 (outpatient first visit) is not: its output fields are provisional upstream and it waits for them. */
export const ROUTED = ["A04"];

export const ROUTED_LABEL = "場面・症候の入力（フローの質問への答え）";
export const REST_LABEL = "欄に結びつかなかった場面・症候の入力";
export const REST_NOTE = "（フローの質問への答えのうち、記載の欄に振り分けられなかったものです。ここにない項目は未確認で、陰性・正常を意味しません）";

/** Why an answer did not go to a field (shown as a count on the screen). */
export const REST_WHY = {
  pending: "カテゴリ未分類",
  aux: "どの質問にも付かない時刻・測定条件・理由",
  none: "記載の項目にしない質問",
  stale: "質問の定義にカテゴリがない・ROUTES に欄がない（取り込みが古い）",
  text: "質問ごとの答えを読めなかったので、文のまま",
};

/** The flow's answered lines in the form the model and the note get: the scene line, then `［phase］` and the answers (the notes meant for the model out). */
export function answeredText(structured) {
  const out = [];
  for (const l of String(structured ?? "").split("\n")) {
    if (l.startsWith("未入力の中核項目")) continue;
    const m = /^場面・症候: (.+?)（/.exec(l);
    out.push(m ? `【${m[1]}】` : l);
  }
  return out.join("\n").trim();
}

/** The fields of `typeId` that take (entity, category): { "entity:category": field }, from NOTE_ROUTES ("*" is a wildcard no flow category uses). */
function indexOf(typeId) {
  const index = new Map();
  for (const [field, rules] of Object.entries(NOTE_ROUTES[typeId] ?? {})) {
    for (const [entity, cats] of Object.entries(rules)) for (const c of cats) if (c !== "*") index.set(`${entity}:${c}`, field);
  }
  return index;
}

/** Where one question's answer goes: { field } or { why }. */
export function placeOf(flow, q, typeId, index = indexOf(typeId)) {
  const br = q.br;
  const entity = flow.cat?.entity?.[br?.ent];
  if (!br) return { why: "stale" };
  if (!entity) return { why: br.ent === "none" ? "none" : "aux" };
  if (!br.cat) return { why: "stale" };
  if (br.cat === flow.cat.pending) return { why: "pending" };
  const field = index.get(`${entity}:${br.cat}`);
  return field ? { field } : { why: "stale" };
}

/**
 * The answers of a flow, routed.  kase: the typed case with `structured` (what was sent) and `intake` ({flow, answers}, kept by the screen).
 * Returns null when the type does not route (ROUTED) or there are no answers.  Otherwise
 *   { routed: { [field]: [line] }, rest: [{ phase, line, why }], answered, placed, reasons: { [why]: n }, fromText }
 * `fromText`: the answers could not be read question by question; `rest` is then the answered lines of the text, in order.
 */
export function routeAnswers(typeId, { flow = null, kase = {} } = {}) {
  if (!ROUTED.includes(typeId) || !NOTE_ROUTES[typeId]) return null;
  const text = answeredText(kase.structured);
  if (!text) return null;
  const answers = kase.intake?.answers;
  const readable =
    flow && answers && kase.intake.flow === flow.id && flow.cat?.note === typeId && answeredText(renderStructured(flow, answers, kase)) === text;
  if (!readable) return fromText(text);
  const index = indexOf(typeId);
  const routed = {};
  const rest = [];
  const reasons = {};
  const ctx = contextOf(answers, kase);
  // the answered, visible questions in the flow's order
  const rows = [];
  for (const { phase, questions } of byPhase(flow)) {
    for (const q of questions) {
      if (isVisible(flow, q, ctx) && isAnswered(answers[q.id])) rows.push({ q, phase: phase.short ?? phase.name, line: lineText(q, answers[q.id]) });
    }
  }
  const byId = new Map(rows.map((r) => [r.q.id, r]));
  const isAux = (q) => q.br?.ent === "time" || q.br?.ent === "condition";
  // a time / condition answer follows the first answered question (in the flow's order) that declares it with `at` / `cond`
  const taken = new Map(); // aux question id -> the row it follows
  const followers = new Map(); // row -> [aux rows]
  for (const r of rows) {
    if (isAux(r.q)) continue;
    for (const k of ["at", "cond"]) {
      const a = byId.get(r.q.br?.[k]);
      if (a && isAux(a.q) && !taken.has(a.q.id)) {
        taken.set(a.q.id, r);
        followers.set(r, [...(followers.get(r) ?? []), a]);
      }
    }
  }
  const put = (r, p, phase) => {
    if (p.field) (routed[p.field] ??= []).push(r.line);
    else {
      rest.push({ phase, line: r.line, why: p.why });
      reasons[p.why] = (reasons[p.why] ?? 0) + 1;
    }
  };
  for (const r of rows) {
    if (taken.has(r.q.id)) continue; // written with its question
    const p = isAux(r.q) ? { why: "aux" } : placeOf(flow, r.q, typeId, index);
    put(r, p, r.phase);
    for (const a of followers.get(r) ?? []) put(a, p, r.phase);
  }
  const placed = Object.values(routed).reduce((n, l) => n + l.length, 0);
  return { routed, rest, answered: placed + rest.length, placed, reasons, fromText: false, scene: text.split("\n")[0] };
}

function fromText(text) {
  const rest = text
    .split("\n")
    .filter((l) => l.trim() && !/^【.*】$/.test(l) && !/^［.*］$/.test(l))
    .map((line) => ({ phase: "", line, why: "text" }));
  return { routed: {}, rest, answered: rest.length, placed: 0, reasons: rest.length ? { text: rest.length } : {}, fromText: true, scene: text.split("\n")[0] };
}

/** The unplaced answers as one block of text: the scene line, then each phase's answers under its heading (a text that could not be split is kept as it was). */
export function restText(routing) {
  if (!routing?.rest.length) return "";
  const out = routing.scene.startsWith("【") ? [routing.scene] : [];
  let last = null;
  for (const r of routing.rest) {
    if (r.phase && r.phase !== last) out.push(`［${r.phase}］`);
    last = r.phase;
    out.push(r.line);
  }
  return out.join("\n");
}

/** A short sentence for the screen: how many answers there are, how many went to a field, and why the others did not. */
export function routingSummary(routing) {
  if (!routing) return "";
  const why = Object.entries(routing.reasons)
    .filter(([, n]) => n)
    .map(([k, n]) => `${REST_WHY[k]} ${n}`)
    .join("・");
  const rest = routing.rest.length;
  return `場面・症候の入力 ${routing.answered} 件のうち、${routing.placed} 件を ROUTES の欄に振り分けました。${rest ? `${rest} 件は欄に結びつかず（${why}）、末尾のブロックに残しています。` : ""}`;
}
