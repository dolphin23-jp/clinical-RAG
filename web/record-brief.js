// The summary of a case record that goes with the case to the assessment/plan draft of a scene that follows a record
// (docs/enhancement-plan.md 8.16; the Worker takes it as `record_brief`, worker/src/casemode.ts).  Pure functions: no DOM, no network, no
// storage, no AI.
//
// What is in it: the record AS IT STOOD on one hospital day (asOf, case-course.js): the problems in their priority order with the certainty,
// trend and plan states the doctor had recorded by then, the open tasks, the criteria to call, and the doctor's own texts of that day.
// What is not: anything recorded later, a date, the full texts of earlier encounters, the books' pages.  A blank stays blank ("未選択",
// "未入力"); an item that came from an AI draft says so, so the model does not take it for a finding.  Nothing here judges: it counts and
// copies what the doctor chose and wrote (the tests look for judging words).
import { CERTAINTY, DX_CLASSES, PLAN_STATES, relativizeRecord } from "./case-record.js";
import { TASK_KINDS, TREND, asOf, dayNo } from "./case-course.js";
import { BRIEF_LIMIT } from "./draft-scenes.js";

export const AI_NOTE = "（AI草案を採用したもの）";
const labelOf = (list, id) => list.find((x) => x.id === id)?.label ?? "";
const flat = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const clip = (s, n) => {
  const t = flat(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const ai = (x) => (x.from === "ai" || x.ai === true ? AI_NOTE : "");

/** The day entries of the working day that are the doctor's account of what changed. */
const DAY_LINES = [
  ["interval", "前回からのイベント"],
  ["subjective", "主観的症状・変化"],
  ["objective", "身体所見・検査の推移"],
  ["overall", "患者全体の状態"],
];

/** The blocks of the summary at a clip length: [{ kind, lines }] in the order they are shown. */
function blocks(view, day, n) {
  const out = [{ kind: "head", lines: [`入院${day}日目の時点の記録（先生の記録。後日の事実は含みません）`] }];
  const named = view.problems.filter((p) => flat(p.label) || p.assess.length || p.plan.length);
  named.forEach((p, i) => {
    const dx = labelOf(DX_CLASSES, p.dx);
    const lines = [`${i + 1}. ${flat(p.label) || "（名前なし）"}${ai(p)} — 確度: ${labelOf(CERTAINTY, p.certainty) || "未選択"}${dx ? ` — ${dx}` : ""}`];
    if (p.trend && (p.trend.state || p.trend.note)) lines.push(`  推移（入院${p.trend.day}日目に先生が選んだもの）: ${labelOf(TREND, p.trend.state) || "（状態は選んでいません）"}${p.trend.note ? ` — ${clip(p.trend.note, n)}` : ""}`);
    for (const e of p.assess) lines.push(`  評価: ・${clip(e.text, n)}${ai(e)}`);
    for (const e of p.plan) lines.push(`  計画: ・${labelOf(PLAN_STATES, e.state ?? "planned")}: ${clip(e.text, n)}${e.reason ? `（理由: ${clip(e.reason, n)}）` : ""}${ai(e)}`);
    out.push({ kind: "problem", lines });
  });
  if (!named.length) out.push({ kind: "problem", lines: ["問題: 記録にはまだありません"] });
  const d = view.course.days.find((x) => x.day === day);
  const dayLines = d ? DAY_LINES.filter(([k]) => flat(d[k])).map(([k, label]) => `  ${label}: ${clip(d[k], n * 2)}`) : [];
  if (dayLines.length) out.push({ kind: "day", lines: [`入院${day}日目の先生の記録:`, ...dayLines] });
  const open = view.course.tasks.filter((k) => k.state === "open" && flat(k.text));
  if (open.length) {
    out.push({
      kind: "tasks",
      lines: ["未完了の課題（先生の記録）:", ...open.map((k) => `  ・${labelOf(TASK_KINDS, k.kind) ? `${labelOf(TASK_KINDS, k.kind)}: ` : ""}${clip(k.text, n)}（担当: ${flat(k.owner) || "未入力"}／期限: ${flat(k.due) || "未入力"}）`)],
    });
  }
  if (view.contingency.length) out.push({ kind: "contingency", lines: ["コンサルト・医師コールの基準（記録済み）:", ...view.contingency.map((e) => `  ・${clip(e.text, n)}${ai(e)}`)] });
  return out;
}

const join = (bs) => bs.map((b) => b.lines.join("\n")).join("\n");

/**
 * The summary of `rec` as of hospital day `day` (default: the working day).  Returns { text, day, problems, tasks, truncated, omitted }:
 * `truncated` when the problems at the end could not be sent whole (they are cut shorter first, then left out, and the text says how many).
 */
export function recordBrief(rec, day = rec.course.today, { limit = BRIEF_LIMIT } = {}) {
  const d = dayNo(day, rec.course.today);
  const view = asOf(relativizeRecord(rec).rec, d);
  let all = blocks(view, d, 160);
  let truncated = false;
  for (const n of [160, 80, 40]) {
    all = blocks(view, d, n);
    if (join(all).length <= limit) break;
    truncated = true;
  }
  let omitted = 0;
  // still too long at the shortest: the problems at the end are left out (the list is in priority order), and the text says so
  const note = (k) => `（長いため、優先順位の低い問題 ${k} 件は渡していません）`;
  while (join(all).length + (omitted ? note(omitted).length + 1 : 0) > limit) {
    const at = all.map((b) => b.kind).lastIndexOf("problem");
    if (at < 1 || all.filter((b) => b.kind === "problem").length <= 1) break;
    all.splice(at, 1);
    omitted++;
    truncated = true;
  }
  if (omitted) all.splice(all.map((b) => b.kind).lastIndexOf("problem") + 1, 0, { kind: "note", lines: [note(omitted)] });
  const text = join(all).slice(0, limit);
  return { text, day: d, problems: view.problems.filter((p) => flat(p.label) || p.assess.length || p.plan.length).length, tasks: view.course.tasks.filter((k) => k.state === "open" && flat(k.text)).length, truncated, omitted };
}

/** The day a scene's summary is as of: the discharge day once the doctor has decided the discharge, otherwise the working day. */
export function briefDay(rec, scene) {
  const dc = rec.course.discharge;
  return scene === "dc" && dc.decided === true && dc.day ? dayNo(dc.day, rec.course.today) : rec.course.today;
}
