// The notes built from a case record after the admission (docs/enhancement-plan.md 8.5, 8.14): the daily progress note (A06), the interim
// summary / transfer note (A07) and the discharge summary (A08).  Pure functions: no DOM, no network, no storage, no AI.
// Each is built from the record AS IT STOOD on that day (asOf, case-course.js): nothing recorded later is in it; a blank is "（未入力）",
// not a sentence; what the doctor chose (a trend, a plan's state, a certainty, what happened to a medication) is shown as chosen and what
// was not chosen is shown as not chosen.  The discharge summary exists only once the doctor has decided the discharge and its day.
import { CERTAINTY, refsOf, relativizeRecord } from "./case-record.js";
import { DAY_FIELDS, MED_CHANGES, TASK_KINDS, TREND, asOf, dayNo } from "./case-course.js";
import { RECORD_FILL, UNFILLED, assemble } from "./note-assemble.js";

const labelOf = (list, id) => list.find((x) => x.id === id)?.label ?? "";
const caseBlock = (source, label, text) => (String(text ?? "").trim() ? [{ kind: "case", source, label, text: String(text).trim() }] : []);
const nameOf = (p) => String(p.label ?? "").trim() || "（名前なし）";
const hasContent = (p) => String(p.label ?? "").trim() || p.assess.length || p.plan.length;

/** The record as it stood on `day`, with no calendar date in its texts. */
const viewAt = (rec, day) => asOf(relativizeRecord(rec).rec, day);

/** What the doctor chose for a problem on each day up to the view's day, oldest first: [{ day, stateLabel, note }]. */
const historyOf = (view, pid) =>
  view.course.days.flatMap((d) => {
    const t = d.trend[pid];
    return t ? [{ day: d.day, stateLabel: labelOf(TREND, t.state), note: t.note ?? "" }] : [];
  });

/**
 * Problems as the A/P block shows them on a day: those with a name or with content, with the certainty of that day.  `trend`: the latest
 * trend the doctor chose on or before the day (never one that was not chosen: no "不変", no "安定"); `history`: every trend chosen up to the
 * day (the discharge summary's course).
 */
function problemsFor(view, { trend = true, history = false } = {}) {
  return view.problems
    .map((p) => ({ p, h: history ? historyOf(view, p.id) : [] }))
    .filter(({ p, h }) => hasContent(p) || (trend && (p.trend?.state || p.trend?.note)) || h.length)
    .map(({ p, h }) => ({
      ...p,
      label: nameOf(p),
      certaintyLabel: labelOf(CERTAINTY, p.certainty),
      trend: trend && p.trend && (p.trend.state || p.trend.note) ? { day: p.trend.day, stateLabel: labelOf(TREND, p.trend.state), note: p.trend.note ?? "" } : null,
      ...(history ? { history: h } : {}),
    }));
}

/** The A/P block of the course notes: unlike the admission note (whose problem list carries them), it marks an AI-origin problem's name itself. */
const apBlock = (problems) => (problems.length ? [{ kind: "ap", label: "Problem 別 Assessment・Plan", problems, markProblems: true }] : []);

/** The days the doctor marked as turning points (up to the view's day) with what the doctor wrote on them and the trends chosen on them. */
const TURN_LABELS = { interval: "前回からのイベント", subjective: "主観的症状・変化", objective: "身体所見・検査推移", overall: "患者全体の状態" };
function turnsBlock(view) {
  const days = view.course.days
    .filter((d) => d.turning)
    .map((d) => ({
      day: d.day,
      lines: DAY_FIELDS.filter((f) => TURN_LABELS[f.key] && d[f.key]).map((f) => ({ label: TURN_LABELS[f.key], text: d[f.key] })),
      trends: view.problems.flatMap((p) => (d.trend[p.id] ? [{ problem: nameOf(p), ai: p.ai === true, stateLabel: labelOf(TREND, d.trend[p.id].state), note: d.trend[p.id].note ?? "" }] : [])),
    }));
  return days.length ? [{ kind: "turns", label: "転換点（先生がマークした日）", days }] : [];
}

/** The tasks still open on the view's day, with who and by when (a missing one is shown as not entered). */
function tasksBlock(view) {
  const open = view.course.tasks.filter((k) => k.state === "open" && k.text); // a row with no text is not a task
  if (!open.length) return [];
  const tasks = open.map((k) => {
    const p = k.problem ? view.problems.find((x) => x.id === k.problem) : null;
    return { text: k.text, kindLabel: labelOf(TASK_KINDS, k.kind), owner: k.owner, due: k.due, problem: p ? nameOf(p) : "", problemAi: p?.ai === true };
  });
  return [{ kind: "tasks", label: "未完了の課題（先生の記録）", tasks }];
}

// ---------------------------------------------------------------- A06: the progress note of a day
/** The progress note (A06) for hospital day `day` (default: the working day), from the record as of that day. */
export function progressNote(rec, today = rec.course.today) {
  const day = dayNo(today, rec.course.today);
  const view = viewAt(rec, day);
  const d = view.course.days.find((x) => x.day === day);
  const fields = {
    day_context: caseBlock("day.context", "入院経過（先生の入力）", `入院${day}日目${view.adm.route ? `。${view.adm.route}` : ""}`),
  };
  for (const f of DAY_FIELDS) fields[`day_${f.key}`] = d ? caseBlock(`day.${f.key}`, `${f.label}（先生の入力）`, d[f.key]) : [];
  const withContent = problemsFor(view).filter((p) => p.assess.length || p.plan.length || p.trend);
  fields.day_ap = apBlock(withContent);
  if (view.contingency.length) fields.day_handover = [...fields.day_handover, { kind: "contingency", label: "コンサルト・医師コールの基準（草案）", entries: view.contingency }];
  return assemble("A06", { kase: view.ed.case, items: [], board: { adm: view.adm, contingency: view.contingency, problems: view.problems, fields }, fill: RECORD_FILL.A06 });
}

// ---------------------------------------------------------------- A07: the interim summary / transfer note
/**
 * The interim summary (A07) as of hospital day `day` (default: the working day).  The course is the days the doctor marked as turning
 * points (none marked: blank); the problems are those of that day with the plan's state and the trend the doctor had recorded by then; the
 * open tasks are those open on that day.  Nothing recorded after `day` is in it.
 */
export function interimNote(rec, today = rec.course.today) {
  const day = dayNo(today, rec.course.today);
  const view = viewAt(rec, day);
  const s = view.course.summary;
  const fields = {
    sum_context: caseBlock("summary.context", "転棟先・引継ぎの理由（先生の入力）", s.context),
    sum_course: turnsBlock(view),
    sum_condition: caseBlock("summary.condition", "現時点の呼吸・循環・意識など（先生の入力）", s.condition),
    sum_ap: apBlock(problemsFor(view).filter((p) => p.assess.length || p.plan.length || p.trend)),
    sum_ongoing: caseBlock("summary.ongoing", "継続治療・デバイス（先生の入力）", s.ongoing),
    sum_pending: tasksBlock(view),
    sum_handover: caseBlock("summary.handover", "引継ぎ先・依頼・共有の状況（先生の入力）", s.handover),
  };
  return assemble("A07", { kase: view.ed.case, items: [], board: { adm: view.adm, contingency: view.contingency, problems: view.problems, fields, asOf: day }, fill: RECORD_FILL.A07 });
}

// ---------------------------------------------------------------- A08: the discharge summary
/** The problems the doctor classed as main / sub diagnosis (with the certainty chosen by the discharge day), and those not classed. */
function dxBlock(view) {
  // refList: the books' pages kept for the problem by the day (docs/enhancement-plan.md 8.16): where the doctor looked, not a statement the books support
  const ps = view.problems.filter(hasContent).map((p) => ({ ...p, label: nameOf(p), certaintyLabel: labelOf(CERTAINTY, p.certainty), refList: refsOf(p) }));
  const main = ps.filter((p) => p.dx === "main");
  const sub = ps.filter((p) => p.dx === "sub");
  if (!main.length && !sub.length) return [];
  return [{ kind: "dx", label: "主病名・副病名（先生が選んだもの）", main, sub, other: ps.filter((p) => !p.dx).map((p) => ({ label: p.label, ai: p.ai === true })) }];
}

/**
 * The discharge summary (A08), or null while the doctor has not decided the discharge: it is built as of the discharge day and only
 * when the doctor has decided (an ended stay is not a discharge, and a discharge with no day is not one).  The medications show what
 * happened to each as the doctor chose it, with the reason; a change or stop with no reason shows the reason as not entered.
 */
export function dischargeNote(rec) {
  const dc = rec.course.discharge;
  if (dc.decided !== true || !dc.day) return null;
  const view = viewAt(rec, dc.day);
  const d = view.course.discharge;
  if (d.decided !== true) return null; // (cannot happen: the day is the discharge day)
  const fields = {
    dc_context: [
      ...caseBlock("discharge.days", "入退院（先生の記録）", `入院1日目に入院、入院${dc.day}日目に退院`),
      ...caseBlock("discharge.dest", "退院先（先生の入力）", d.dest || UNFILLED),
    ],
    dc_dx: dxBlock(view),
    dc_course: [...turnsBlock(view), ...apBlock(problemsFor(view, { trend: false, history: true }))],
    dc_procedures: caseBlock("discharge.procedures", "主要な検査・処置（先生の入力）", d.procedures),
    dc_state: caseBlock("discharge.state", "退院時の状態（先生の入力）", d.state),
    dc_meds: d.meds.some((m) => m.text) ? [{ kind: "meds", label: "退院時処方（先生の入力）", meds: d.meds.filter((m) => m.text).map((m) => ({ text: m.text, changeLabel: labelOf(MED_CHANGES, m.change), change: m.change, reason: m.reason ?? "" })) }] : [],
    dc_followup: caseBlock("discharge.followup", "外来・在宅の方針（先生の入力）", d.followup),
    dc_tasks: tasksBlock(view),
  };
  return assemble("A08", { kase: view.ed.case, items: [], board: { adm: view.adm, contingency: view.contingency, problems: view.problems, fields, asOf: dc.day }, fill: RECORD_FILL.A08 });
}
