// The summary of a case record that goes with the case to the assessment/plan draft of a scene that follows a record
// (docs/enhancement-plan.md 8.16; the Worker takes it as `record_brief`, worker/src/casemode.ts).  Pure functions: no DOM, no network, no
// storage, no AI.
//
// What is in it: the record AS IT STOOD on one hospital day (asOf, case-course.js): the problems with the certainty, the trend and the plan
// states the doctor had recorded by then, the open tasks, the criteria to call, the doctor's own texts of that day, and, for the interim
// and the discharge scenes, what those scenes are about (the turning-point days, the doctor's summary texts, each problem's trends).
// What is not: anything dated after the day, a calendar date, the full texts of earlier encounters, the books' pages.
// What is NOT dated (and the head line says so): the problems' names, the texts of an assessment or a plan, and the order of the problems
// are as they are now; the class "main / sub diagnosis" is the doctor's choice for the discharge summary and is sent for that scene only.
// A blank stays blank ("未選択", "未入力"), a row with no text is not a line, and an item that came from an AI draft says so, so the model does
// not take it for a finding.  Nothing here judges: it copies what the doctor chose and wrote (the tests look for judging words).
import { CERTAINTY, DX_CLASSES, PLAN_STATES, relativizeRecord } from "./case-record.js";
import { SUMMARY_FIELDS, TASK_KINDS, TREND, asOf, dayNo } from "./case-course.js";
import { BRIEF_LIMIT } from "./draft-scenes.js";

/** The mark on a line an AI draft wrote (twin of AI_NOTE in worker/src/casemode.ts: the Worker leaves these lines out of the doctor's own numbers). */
export const AI_NOTE = "（AI草案を採用したもの）";
const labelOf = (list, id) => list.find((x) => x.id === id)?.label ?? "";
const flat = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const clip = (s, n) => {
  const t = flat(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const ai = (x) => (x.from === "ai" || x.ai === true ? AI_NOTE : "");
/** An entry with words in it (an empty row the doctor added and left is not a line of anything). */
const live = (e) => !!flat(e.text);

/** The day entries of the working day that are the doctor's account of what changed. */
const DAY_LINES = [
  ["interval", "前回からのイベント"],
  ["subjective", "主観的症状・変化"],
  ["objective", "身体所見・検査の推移"],
  ["overall", "患者全体の状態"],
];

/** What a scene's summary has besides the problems, the day, the tasks and the criteria to call. */
const scenePart = (scene) => ({ dx: scene === "dc", history: scene === "interim" || scene === "dc", turning: scene === "interim" || scene === "dc", own: scene === "interim" });

const trendWords = (state, note, n) => `${labelOf(TREND, state) || "（状態は選んでいません）"}${note ? ` — ${clip(note, n)}` : ""}`;

/** The blocks of the summary at a clip length: [{ kind, lines }] in the order they are shown. */
function blocks(view, day, n, part) {
  const out = [{ kind: "head", lines: [`入院${day}日目の時点の記録（確度・計画の状態・推移・課題の完了は、その日までに先生が記録したもの。問題名・評価と計画の文・問題の順序は、いまの記録のまま）`] }];
  const named = view.problems.filter((p) => flat(p.label) || p.assess.some(live) || p.plan.some(live));
  named.forEach((p, i) => {
    const dx = part.dx ? labelOf(DX_CLASSES, p.dx) : "";
    const lines = [`${i + 1}. ${flat(p.label) || "（名前なし）"}${ai(p)} — 確度: ${labelOf(CERTAINTY, p.certainty) || "未選択"}${dx ? ` — ${dx}` : ""}`];
    if (part.history) {
      // every trend the doctor chose up to the day, oldest first
      const h = view.course.days.flatMap((d) => (d.trend?.[p.id] && (d.trend[p.id].state || d.trend[p.id].note) ? [`入院${d.day}日目 ${trendWords(d.trend[p.id].state, d.trend[p.id].note, n)}`] : []));
      if (h.length) lines.push(`  推移の記録: ${h.join("／")}`);
    } else if (p.trend && (p.trend.state || p.trend.note)) lines.push(`  推移（入院${p.trend.day}日目に先生が選んだもの）: ${trendWords(p.trend.state, p.trend.note, n)}`);
    for (const e of p.assess.filter(live)) lines.push(`  評価: ・${clip(e.text, n)}${ai(e)}`);
    for (const e of p.plan.filter(live)) lines.push(`  計画: ・${labelOf(PLAN_STATES, e.state ?? "planned")}: ${clip(e.text, n)}${e.reason ? `（理由: ${clip(e.reason, n)}）` : ""}${ai(e)}`);
    out.push({ kind: "problem", lines, name: flat(p.label) || "（名前なし）" });
  });
  if (!named.length) out.push({ kind: "problem", lines: ["問題: 記録にはまだありません"] });
  const d = view.course.days.find((x) => x.day === day);
  const dayLines = d ? DAY_LINES.filter(([k]) => flat(d[k])).map(([k, label]) => `  ${label}: ${clip(d[k], n * 2)}`) : [];
  if (dayLines.length) out.push({ kind: "day", lines: [`入院${day}日目の先生の記録:`, ...dayLines] });
  if (part.turning) {
    // the days the doctor marked as turning points, with what the doctor wrote on them (the course that the interim and discharge drafts are about)
    const turns = view.course.days.filter((x) => x.turning);
    if (turns.length) {
      out.push({
        kind: "turning",
        lines: [
          "転換点（先生がマークした日）:",
          ...turns.map((x) => {
            const parts = DAY_LINES.filter(([k]) => flat(x[k])).map(([k, label]) => `${label}: ${clip(x[k], n)}`);
            return `  入院${x.day}日目: ${parts.length ? parts.join("／") : "（文の記録なし）"}`;
          }),
        ],
      });
    }
  }
  if (part.own) {
    const own = SUMMARY_FIELDS.filter((f) => flat(view.course.summary?.[f.key]));
    if (own.length) out.push({ kind: "own", lines: ["中間サマリー・転棟の先生の入力:", ...own.map((f) => `  ${f.label}: ${clip(view.course.summary[f.key], n * 2)}`)] });
  }
  const open = view.course.tasks.filter((k) => k.state === "open" && flat(k.text));
  if (open.length) {
    out.push({
      kind: "tasks",
      lines: ["未完了の課題（先生の記録）:", ...open.map((k) => `  ・${labelOf(TASK_KINDS, k.kind) ? `${labelOf(TASK_KINDS, k.kind)}: ` : ""}${clip(k.text, n)}（担当: ${flat(k.owner) || "未入力"}／期限: ${flat(k.due) || "未入力"}）`)],
    });
  }
  const calls = view.contingency.filter(live);
  if (calls.length) out.push({ kind: "contingency", lines: ["コンサルト・医師コールの基準（記録済み）:", ...calls.map((e) => `  ・${clip(e.text, n)}${ai(e)}`)] });
  return out;
}

const join = (bs) => bs.map((b) => b.lines.join("\n")).join("\n");

/**
 * The summary of `rec` as of hospital day `day` (default: the working day) for a scene (the scene decides what else goes in).  Returns
 * { text, day, problems, tasks, names, truncated, omitted, omittedLines }: `truncated` when it did not fit (the texts are cut shorter first,
 * then the problems at the end are left out, then the last lines; the text says what was left out, and `omitted` / `omittedLines` count them).
 * `names`: the first problems' names, for the doctor to see whose record it is before it is sent.
 */
export function recordBrief(rec, day = rec.course.today, { limit = BRIEF_LIMIT, scene = "" } = {}) {
  const d = dayNo(day, rec.course.today);
  const view = asOf(relativizeRecord(rec).rec, d);
  const part = scenePart(scene);
  let all = blocks(view, d, 160, part);
  let truncated = false;
  for (const n of [160, 80, 40]) {
    all = blocks(view, d, n, part);
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
  let text = join(all);
  let omittedLines = 0;
  if (text.length > limit) {
    // still too long: the last lines go, whole, and the last line says how many
    const lines = text.split("\n");
    const tail = (k) => `（長いため、末尾の ${k} 行は渡していません）`;
    let kept = lines.length;
    while (kept > 1 && lines.slice(0, kept).join("\n").length + 1 + tail(lines.length - kept).length > limit) kept--;
    omittedLines = lines.length - kept;
    text = [...lines.slice(0, kept), tail(omittedLines)].join("\n");
    truncated = true;
  }
  const problems = view.problems.filter((p) => flat(p.label) || p.assess.some(live) || p.plan.some(live));
  return {
    text,
    day: d,
    problems: problems.length,
    tasks: view.course.tasks.filter((k) => k.state === "open" && flat(k.text)).length,
    names: problems.slice(0, 3).map((p) => flat(p.label) || "（名前なし）"),
    truncated,
    omitted,
    omittedLines,
  };
}

/**
 * The day a scene's summary is as of: the admission scene is the admission day (the admission note is built as of day 1), the discharge summary
 * the discharge day once the doctor has decided the discharge, the others the working day.
 */
export function briefDay(rec, scene) {
  if (scene === "adm") return 1;
  const dc = rec.course.discharge;
  return scene === "dc" && dc.decided === true && dc.day ? dayNo(dc.day, rec.course.today) : rec.course.today;
}
