// The case record (docs/enhancement-plan.md 8; the doctor's decision of 2026-10-24, docs/clinical-use.md 1e): a case that builds up
// across encounters, as one document kept on the server (Worker: recordstore.ts).  Stage 2: the emergency encounter (the case as typed,
// the AI-draft items the doctor adopted) and the admission note built from it (problems with stable ids, what the doctor carried over).
// Pure functions: no DOM, no network, no storage, no AI.  Every change returns a new record (the input is not touched).
//
// What the rules of enhancement-plan 8.6 become here:
//  1. Carrying over is the doctor's act: an adopted item reaches a problem only through attach(); nothing is copied by itself.
//  2. A blank stays blank: an unanswered question is never turned into "none" (see intake.js); a problem without a certainty has none.
//  3. A plan stays a plan: an entry is "planned" until the doctor records "done" or "stopped"; an AI item is never made "done".
//  4. A problem has a stable id (p1, p2 ...) that is never used again, even after the problem is removed.
//  8. No date: the time axis is minutes from the arrival (or the clock time of the encounter); "入院N日目" comes with the later encounters.
// Checks (checks()) count what is blank or undecided; they are notes, not judgements.
import { TEXT_KEYS, cleanCase, caseSummary, isEmptyCase } from "./case-model.js";
import { relativizeDates } from "./date-relative.js";
import { contextOf, coreMissing, cleanAnswers, isAnswered, isVisible, lineText, shortLabel } from "./intake.js";
import { ROLES, assemble } from "./note-assemble.js";

export const RECORD_VERSION = 1;

/** The doctor's choices for a problem's diagnostic certainty (a blank means not chosen). */
export const CERTAINTY = [
  { id: "suspected", label: "疑い" },
  { id: "likely", label: "可能性が高い" },
  { id: "confirmed", label: "確定" },
  { id: "ruled_out", label: "除外" },
];
/** What the doctor can record for a plan entry.  "done" is the doctor's record of an action; nothing sets it by itself. */
export const PLAN_STATES = [
  { id: "planned", label: "予定・検討" },
  { id: "done", label: "実施（医師の記録）" },
  { id: "stopped", label: "中止・しない" },
];
/** The free-text parts of the admission note that only the doctor writes. */
export const ADM_FIELDS = [
  { key: "route", label: "入院の経路・目的", note: "A05 の「入院経路・目的」" },
  { key: "summary", label: "Clinical Summary（全体の要約）", note: "A05 の「Clinical Summary」" },
  { key: "baseline", label: "ベースライン（臓器機能・ADL など）", note: "A05 の「ベースライン」" },
  { key: "general", label: "全身管理・治療目標・予防", note: "A05 の「全身管理・治療目標・予防」" },
  { key: "outlook", label: "再評価の予定・退院の条件・申し送り", note: "A05 の「再評価予定・退院条件・申し送り」" },
];

export const LIMITS = { title: 80, label: 120, text: 600, reason: 300, adm: 1500, heading: 80, cite: 200, problems: 20, entries: 12, adopted: 60, cites: 6 };
const ID = { p: /^p\d{1,4}$/, i: /^i\d{1,4}$/, a: /^a\d{1,4}$/ };
const CERT_IDS = new Set(CERTAINTY.map((c) => c.id));
const STATE_IDS = new Set(PLAN_STATES.map((c) => c.id));

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v, max) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim().slice(0, max) : "");
const clone = (o) => structuredClone(o);

// ---------------------------------------------------------------- shape
const cleanCites = (raw) =>
  (Array.isArray(raw) ? raw : [])
    .slice(0, LIMITS.cites)
    .filter(isObj)
    .map((c) => {
      const o = {};
      for (const k of ["kind", "title", "page", "url"]) if (typeof c[k] === "string" && c[k]) o[k] = c[k].slice(0, LIMITS.cite);
      return o;
    })
    .filter((o) => o.title || o.url || o.page);

function cleanEntry(raw, isPlan, used) {
  if (!isObj(raw)) return null;
  const text = str(raw.text, LIMITS.text);
  if (!text || typeof raw.id !== "string" || !ID.i.test(raw.id) || used.has(raw.id)) return null;
  used.add(raw.id);
  const e = { id: raw.id, text, from: ["typed", "ai", "ed"].includes(raw.from) ? raw.from : "typed" };
  const cites = cleanCites(raw.cites);
  if (cites.length) e.cites = cites;
  if (isPlan) {
    e.state = STATE_IDS.has(raw.state) ? raw.state : "planned";
    const reason = str(raw.reason, LIMITS.reason);
    if (reason) e.reason = reason;
  }
  return e;
}

/** Counters for the next ids: past every id in use, and never lower than what the record said (an id is not reused). */
function seqOf(rec, given) {
  const top = (list, re) => list.reduce((m, id) => (re.test(id) ? Math.max(m, Number(id.slice(1))) : m), 0);
  const entries = [...rec.problems.flatMap((p) => [...p.assess, ...p.plan]), ...rec.contingency].map((e) => e.id);
  const num = (v) => (Number.isInteger(v) && v >= 0 && v < 10000 ? v : 0);
  return {
    p: Math.max(num(given?.p), top(rec.problems.map((p) => p.id), ID.p)),
    i: Math.max(num(given?.i), top(entries, ID.i)),
    a: Math.max(num(given?.a), top(rec.ed.adopted.map((a) => a.id), ID.a)),
  };
}

/** A record read back from the server (or any untrusted shape): known keys only, values checked, texts cut.  null when it is not a record. */
export function cleanRecord(raw) {
  if (!isObj(raw) || raw.v !== RECORD_VERSION || !isObj(raw.ed)) return null;
  const kase = cleanCase(raw.ed.case);
  if (isEmptyCase(kase)) return null;
  const used = new Set();
  const problems = [];
  for (const p of (Array.isArray(raw.problems) ? raw.problems : []).slice(0, LIMITS.problems)) {
    if (!isObj(p) || typeof p.id !== "string" || !ID.p.test(p.id) || problems.some((x) => x.id === p.id)) continue;
    problems.push({
      id: p.id,
      label: str(p.label, LIMITS.label),
      certainty: CERT_IDS.has(p.certainty) ? p.certainty : "",
      from: p.from === "ed" ? "ed" : "typed",
      assess: (Array.isArray(p.assess) ? p.assess : []).slice(0, LIMITS.entries).map((e) => cleanEntry(e, false, used)).filter(Boolean),
      plan: (Array.isArray(p.plan) ? p.plan : []).slice(0, LIMITS.entries).map((e) => cleanEntry(e, true, used)).filter(Boolean),
    });
  }
  const contingency = (Array.isArray(raw.contingency) ? raw.contingency : []).slice(0, LIMITS.entries).map((e) => cleanEntry(e, false, used)).filter(Boolean);
  const adopted = [];
  for (const a of (Array.isArray(raw.ed.adopted) ? raw.ed.adopted : []).slice(0, LIMITS.adopted)) {
    if (!isObj(a) || typeof a.id !== "string" || !ID.a.test(a.id) || adopted.some((x) => x.id === a.id) || !ROLES[a.role]) continue;
    const text = str(a.text, LIMITS.text);
    if (!text) continue;
    const to = a.to === "none" || a.to === "outlook" || problems.some((p) => p.id === a.to) ? a.to : "";
    const item = { id: a.id, role: a.role, heading: str(a.heading, LIMITS.heading), text, cites: cleanCites(a.cites), to };
    if (to && typeof a.entry === "string" && used.has(a.entry)) item.entry = a.entry;
    adopted.push(item);
  }
  const adm = {};
  for (const f of ADM_FIELDS) adm[f.key] = str(isObj(raw.adm) ? raw.adm[f.key] : "", LIMITS.adm);
  const rec = { v: RECORD_VERSION, title: str(raw.title, LIMITS.title) || recordTitle(kase), ed: { case: kase, adopted }, adm, problems, contingency, seq: { p: 0, i: 0, a: 0 } };
  rec.seq = seqOf(rec, raw.seq);
  return rec;
}

/** The title shown in the list: the case's one-line summary (no date). */
export function recordTitle(kase) {
  return (caseSummary(kase) || "症例").slice(0, LIMITS.title);
}

export function newRecord(kase) {
  const c = cleanCase(kase);
  return cleanRecord({ v: RECORD_VERSION, title: recordTitle(c), ed: { case: c, adopted: [] }, adm: {}, problems: [], contingency: [], seq: {} });
}

// ---------------------------------------------------------------- no calendar date is kept
/**
 * Makes every date in the record's free texts relative ("N日前", "入院N日目"; web/date-relative.js) so none is saved.  The screen does this when
 * something is pasted and when a field is left; this is the last pass before saving.  Returns { rec, changes } (rec is the same object when
 * nothing changed).
 */
export function relativizeRecord(rec, { now = new Date() } = {}) {
  const changes = [];
  const next = clone(rec);
  const fix = (o, k) => {
    if (typeof o[k] !== "string" || !o[k]) return;
    const r = relativizeDates(o[k], { now });
    if (r.changes.length) {
      o[k] = r.text;
      changes.push(...r.changes);
    }
  };
  fix(next, "title");
  for (const k of TEXT_KEYS) fix(next.ed.case, k);
  for (const f of ADM_FIELDS) fix(next.adm, f.key);
  for (const p of next.problems) {
    fix(p, "label");
    for (const e of [...p.assess, ...p.plan]) {
      fix(e, "text");
      fix(e, "reason");
    }
  }
  for (const e of next.contingency) fix(e, "text");
  return { rec: changes.length ? next : rec, changes };
}

// ---------------------------------------------------------------- the emergency encounter
/** Replaces the case (the doctor edited the pinned case): the title follows it; problems, carried items and the admission text stay. */
export function setCase(rec, kase) {
  const next = clone(rec);
  next.ed.case = cleanCase(kase);
  next.title = recordTitle(next.ed.case);
  return next;
}

/** Takes in adopted draft items [{ role, heading, text, cites }]: an item already taken (same role and text) is not added twice. Returns { rec, added }. */
export function addAdopted(rec, items) {
  const next = clone(rec);
  let added = 0;
  for (const it of Array.isArray(items) ? items : []) {
    if (!isObj(it) || !ROLES[it.role]) continue;
    const text = str(it.text, LIMITS.text);
    if (!text || next.ed.adopted.some((a) => a.role === it.role && a.text === text) || next.ed.adopted.length >= LIMITS.adopted) continue;
    next.seq.a += 1;
    next.ed.adopted.push({ id: `a${next.seq.a}`, role: it.role, heading: str(it.heading, LIMITS.heading), text, cites: cleanCites(it.cites), to: "" });
    added++;
  }
  return { rec: next, added };
}

// ---------------------------------------------------------------- the problem board
const findProblem = (rec, id) => rec.problems.find((p) => p.id === id);
const nextId = (rec, k) => `${k}${(rec.seq[k] += 1)}`;

/** A new problem at the end (lowest priority).  `from`: "typed" (the doctor wrote it) or "ed" (carried from the emergency encounter). */
export function addProblem(rec, label = "", from = "typed") {
  const next = clone(rec);
  if (next.problems.length >= LIMITS.problems) return { rec: next, id: null };
  const id = nextId(next, "p");
  next.problems.push({ id, label: str(label, LIMITS.label), certainty: "", from: from === "ed" ? "ed" : "typed", assess: [], plan: [] });
  return { rec: next, id };
}

/** Removes a problem.  Its id is not used again.  Carried items that pointed at it go back to "not decided". */
export function removeProblem(rec, id) {
  const next = clone(rec);
  next.problems = next.problems.filter((p) => p.id !== id);
  for (const a of next.ed.adopted) if (a.to === id) {
    a.to = "";
    delete a.entry;
  }
  return next;
}

/** Moves a problem up (-1) or down (+1) in the priority order. */
export function moveProblem(rec, id, dir) {
  const next = clone(rec);
  const i = next.problems.findIndex((p) => p.id === id);
  const j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= next.problems.length) return next;
  [next.problems[i], next.problems[j]] = [next.problems[j], next.problems[i]];
  return next;
}

/** Sets a problem's label and/or certainty (the doctor's choice; "" = not chosen). */
export function setProblem(rec, id, patch) {
  const next = clone(rec);
  const p = findProblem(next, id);
  if (!p) return next;
  if ("label" in patch) p.label = str(patch.label, LIMITS.label);
  if ("certainty" in patch) p.certainty = CERT_IDS.has(patch.certainty) ? patch.certainty : "";
  return next;
}

const listOf = (p, which) => (which === "plan" ? p.plan : p.assess);

/** Adds an entry the doctor typed to a problem's `assess` or `plan` list.  A plan entry starts as "planned". */
export function addEntry(rec, problemId, which, text = "") {
  const next = clone(rec);
  const p = findProblem(next, problemId);
  if (!p || listOf(p, which).length >= LIMITS.entries) return { rec: next, id: null };
  const id = nextId(next, "i");
  const e = { id, text: str(text, LIMITS.text), from: "typed" };
  if (which === "plan") e.state = "planned";
  listOf(p, which).push(e);
  return { rec: next, id };
}

/** Changes an entry's text, and for a plan entry its state and reason.  A state other than the three is ignored. */
export function setEntry(rec, problemId, which, entryId, patch) {
  const next = clone(rec);
  const e = listOf(findProblem(next, problemId) ?? { assess: [], plan: [] }, which).find((x) => x.id === entryId);
  if (!e) return next;
  if ("text" in patch) e.text = str(patch.text, LIMITS.text);
  if (which === "plan") {
    if ("state" in patch && STATE_IDS.has(patch.state)) e.state = patch.state;
    if ("reason" in patch) {
      const r = str(patch.reason, LIMITS.reason);
      if (r) e.reason = r;
      else delete e.reason;
    }
  }
  return next;
}

export function removeEntry(rec, problemId, which, entryId) {
  const next = clone(rec);
  const p = findProblem(next, problemId);
  if (!p) return next;
  p[which === "plan" ? "plan" : "assess"] = listOf(p, which).filter((e) => e.id !== entryId);
  for (const a of next.ed.adopted) if (a.entry === entryId) {
    a.to = "";
    delete a.entry;
  }
  return next;
}

/** Sets one of the doctor's own admission texts (ADM_FIELDS). */
export function setAdm(rec, key, text) {
  const next = clone(rec);
  if (ADM_FIELDS.some((f) => f.key === key)) next.adm[key] = str(text, LIMITS.adm);
  return next;
}

// ---------------------------------------------------------------- carrying over: the doctor's act
/**
 * Carries one adopted item: target = a problem id, "new" (a new problem; only for an item of the problem list), "outlook" (only for
 * criteria to call or consult), "none" (not carried: decided) or "" (back to not decided: the entry it made is removed).
 * The carried entry keeps its AI origin (`from: "ai"`) and its citations; a plan item arrives as "planned".  Returns { rec, ok }.
 */
export function attach(rec, adoptedId, target) {
  let next = clone(rec);
  const a = next.ed.adopted.find((x) => x.id === adoptedId);
  if (!a) return { rec: next, ok: false };
  // undo what an earlier choice made
  if (a.entry) {
    for (const p of next.problems) {
      p.assess = p.assess.filter((e) => e.id !== a.entry);
      p.plan = p.plan.filter((e) => e.id !== a.entry);
    }
    next.contingency = next.contingency.filter((e) => e.id !== a.entry);
    delete a.entry;
  }
  a.to = "";
  if (!target) return { rec: next, ok: true };
  if (target === "none") {
    a.to = "none";
    return { rec: next, ok: true };
  }
  const entry = (isPlan) => {
    const e = { id: nextId(next, "i"), text: a.text, from: "ai" };
    if (a.cites?.length) e.cites = clone(a.cites);
    if (isPlan) e.state = "planned";
    return e;
  };
  if (target === "outlook") {
    if (a.role !== "contingency" || next.contingency.length >= LIMITS.entries) return { rec, ok: false };
    const e = entry(false);
    next.contingency.push(e);
    a.to = "outlook";
    a.entry = e.id;
    return { rec: next, ok: true };
  }
  if (target === "new") {
    if (a.role !== "problems") return { rec, ok: false };
    const made = addProblem(next, a.text, "ed");
    if (!made.id) return { rec, ok: false };
    next = made.rec;
    const na = next.ed.adopted.find((x) => x.id === adoptedId);
    na.to = made.id; // the new problem is named by the item's own words: the doctor edits it
    delete na.entry;
    next.problems.find((p) => p.id === made.id).from = "ed";
    return { rec: next, ok: true };
  }
  const p = findProblem(next, target);
  if (!p) return { rec, ok: false };
  const isPlan = a.role === "plan";
  const list = isPlan ? p.plan : p.assess;
  if (list.length >= LIMITS.entries) return { rec, ok: false };
  const e = entry(isPlan);
  list.push(e);
  a.to = p.id;
  a.entry = e.id;
  return { rec: next, ok: true };
}

// ---------------------------------------------------------------- the emergency time axis
/** "HH:MM" -> minutes of the day, or null. */
export function minutesOf(t) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(t ?? ""));
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** The name of a time question for the axis: its `line` without "（{value}）" ("12誘導ECG（{value}）" -> "12誘導ECG"), else its label without "時刻". */
export function timeLabel(q) {
  const fromLine = q.line?.includes("{value}") ? q.line.replace(/[（(：:]?\s*\{value\}\s*[）)]?.*$/, "").trim() : "";
  return fromLine || shortLabel(q.label).replace(/の?時刻$/, "") || q.id;
}

/**
 * The time axis of an emergency encounter from the flow's answers: every answered time question, in time order, with the minutes from
 * the flow's own origin (the arrival).  A time earlier than the origin is read as the next day and says so.  No judgement of how long
 * anything took; the observations hung on a time (the bridge's `at`) are listed under it as typed.
 * Returns { origin: { label, time } | null, originMissing, rows: [{ id, time, label, min, wrapped, isOrigin, details }] }.
 */
export function timeline(flow, answers, kase) {
  const ctx = contextOf(answers, kase);
  const originQ = flow.origin?.q;
  const originTime = originQ && minutesOf(answers[originQ]) !== null ? answers[originQ] : null;
  const rows = [];
  flow.questions.forEach((q, order) => {
    if (q.type !== "time" || minutesOf(answers[q.id]) === null || !isVisible(flow, q, ctx)) return;
    const time = answers[q.id];
    let min = null;
    let wrapped = false;
    if (originTime) {
      min = minutesOf(time) - minutesOf(originTime);
      if (min < 0) {
        min += 1440;
        wrapped = true;
      }
    }
    const details = flow.questions.filter((x) => x.br?.at === q.id && isAnswered(answers[x.id]) && isVisible(flow, x, ctx)).map((x) => lineText(x, answers[x.id]));
    rows.push({ id: q.id, time, label: timeLabel(q), min, wrapped, isOrigin: q.id === originQ, details, order });
  });
  rows.sort((a, b) => (a.min ?? minutesOf(a.time)) - (b.min ?? minutesOf(b.time)) || a.order - b.order);
  return { origin: originTime ? { label: flow.origin.label, time: originTime } : null, originMissing: !!originQ && !originTime, rows: rows.map(({ order, ...r }) => r) };
}

// ---------------------------------------------------------------- the flow of an encounter
/** The flow the emergency case was entered in, and its answers read through the flow (what the form would restore), or null. */
export function flowOf(rec, FLOWS) {
  const intake = rec.ed.case.intake;
  const flow = intake ? FLOWS?.[intake.flow] : null;
  return flow ? { flow, answers: cleanAnswers(flow, intake.answers).answers } : null;
}

/** Items of a flow's answers that the bridge classes as waiting: [{ id, label, kind: "pend" | "wait" }].  Only what the doctor chose. */
export function waiting(flow, answers, kase) {
  const ctx = contextOf(answers, kase);
  const out = [];
  for (const q of flow.questions) {
    const br = q.br;
    if (!br || (!br.pend && !br.wait) || !isAnswered(answers[q.id]) || !isVisible(flow, q, ctx)) continue;
    const chosen = Array.isArray(answers[q.id]) ? answers[q.id] : [answers[q.id]];
    if (br.pend?.some((o) => chosen.includes(o))) out.push({ id: q.id, label: shortLabel(q.label, 40), kind: "pend" });
    else if (br.wait?.some((o) => chosen.includes(o))) out.push({ id: q.id, label: shortLabel(q.label, 40), kind: "wait" });
  }
  return out;
}

// ---------------------------------------------------------------- the admission note, projected from the record
/** The parts of the record that fill the admission note (note-assemble.js reads this as `board`). */
export const boardOf = (rec) => ({
  adm: { ...rec.adm },
  contingency: clone(rec.contingency),
  problems: rec.problems.map((p) => ({ ...clone(p), certaintyLabel: CERTAINTY.find((c) => c.id === p.certainty)?.label ?? "" })),
});

/** The admission note (A05) as assemble() builds it: the case as typed, and the board.  Adopted items reach it only through the board. */
export const admissionNote = (rec) => assemble("A05", { kase: rec.ed.case, items: [], board: boardOf(rec) });

// ---------------------------------------------------------------- checks: what is blank or undecided (notes, not judgements)
const ROLE_LABEL = { problems: "問題リスト", assessment: "各問題の評価", plan: "初期プラン", contingency: "コンサルト・医師コールの基準" };

/**
 * Counts what is blank or not decided yet.  Each is { id, text, items: [string] }.  This is the state of the input, not a verdict:
 * an empty list means nothing of that kind is blank, not that the care is right.  `FLOWS` is the imported schema (or null).
 */
export function checks(rec, FLOWS) {
  const out = [];
  const add = (id, text, items = []) => out.push({ id, text, items });
  const fa = flowOf(rec, FLOWS);
  if (fa) {
    const miss = coreMissing(fa.flow, fa.answers, rec.ed.case);
    if (miss.length) add("core_missing", `救急の中核の質問のうち、未入力（未確認。陰性ではありません）が ${miss.length} 件`, miss.map((m) => shortLabel(m.label)));
    const w = waiting(fa.flow, fa.answers, rec.ed.case);
    const pend = w.filter((x) => x.kind === "pend");
    const wait = w.filter((x) => x.kind === "wait");
    if (pend.length) add("pending", `「結果待ち」を選んだ項目（未完了の課題）が ${pend.length} 件`, pend.map((x) => x.label));
    if (wait.length) add("waiting", `結果待ちか未実施か区別できない項目が ${wait.length} 件`, wait.map((x) => x.label));
  }
  const undecided = rec.ed.adopted.filter((a) => !a.to);
  if (undecided.length) add("undecided", `救急で採用した項目のうち、入院時へ持ってくるか決めていないものが ${undecided.length} 件`, undecided.map((a) => `${ROLE_LABEL[a.role] ?? a.role}: ${a.text.slice(0, 30)}`));
  const unnamed = rec.problems.filter((p) => !p.label);
  if (unnamed.length) add("unnamed", `名前のない問題が ${unnamed.length} 件`, []);
  const noCert = rec.problems.filter((p) => p.label && !p.certainty);
  if (noCert.length) add("no_certainty", `診断の確度を選んでいない問題が ${noCert.length} 件`, noCert.map((p) => p.label));
  const noAssess = rec.problems.filter((p) => p.label && !p.assess.length);
  if (noAssess.length) add("no_assessment", `評価を書いていない問題が ${noAssess.length} 件`, noAssess.map((p) => p.label));
  const noPlan = rec.problems.filter((p) => p.label && !p.plan.length);
  if (noPlan.length) add("no_plan", `計画を書いていない問題が ${noPlan.length} 件`, noPlan.map((p) => p.label));
  if (!rec.problems.length) add("no_problems", "問題がまだありません（入院時の記載の「Problem List」は未入力になります）");
  const note = admissionNote(rec);
  if (note.unfilled.length) add("unfilled", `入院時の記載の必須欄が「（未入力）」のまま: ${note.unfilled.length} 個`, note.sections.filter((s) => s.empty && s.requirement === "required").map((s) => s.label));
  return out;
}
