// What the screen of a simulated fictional case (web/sim-ui.js) shows and keeps, as pure functions (docs/enhancement-plan.md 8.21, step 1b).
// No DOM, no network, no storage, no clock, no random, no AI.  The engine (sim-engine.js) says what the case told; this module turns that into
// lines of the running memo, rows of the tray (what the doctor may take into the answers), the doctor's own entries, and the debrief.
//
// The tray: what the case told is not an answer until the doctor takes it in (like a proposal of the memo import).  Nothing is preselected; a
// negative / unknown / not assessable / waiting answer and a time are taken one at a time; an answer the doctor already has is never overwritten.
import { STAGES, isReading, optionIds, questionOf, validateSimCase } from "./sim-case.js";
import { NO_DATA, SAY_TYPES, clockAt } from "./sim-engine.js";
import { byPhase, contextOf, isAnswered, isVisible, renderStructured, setAnswer, valueText } from "./intake.js";

/** Put above every copy of the simulation's note: it cannot be taken off. */
export const SIM_HEADER = "【架空症例（模擬）・実在の患者ではありません】";
export const SIM_MARK = "架空症例（模擬）";
/** One segment of time is this many minutes (the doctor chooses; shown only, it never moves the case). */
export const SEGMENT_CHOICES = [5, 10, 15, 30];
export const SAY_LABELS = { explain: "説明", consult: "相談", disposition: "行き先" };
/**
 * Questions of RAG's JUDGMENT_IDS that are raw bedside data in a simulation (the case returns them; the doctor reads them): the extraction holds
 * them back from the model because the doctor reads them, but a simulated case has to be able to show what was seen.  The author's proposal
 * (docs/enhancement-plan.md 8.21); the doctor may move a question across.
 */
export const SIM_RAW = new Set(["hi", "skew", "orth", "plr", "walk_spo2", "trop2", "re_exam", "ems_state", "ems_glu", "hidden"]);
/** The doctor's readings in a simulation: JUDGMENT_IDS without the raw bedside data. */
export const simReadings = (judgmentIds) => new Set([...judgmentIds].filter((id) => !SIM_RAW.has(id)));
export const isEmergencyFlow = (id) => typeof id === "string" && id.startsWith("emergency-department.");

const plain = (s) => String(s ?? "").replace(/^★\d+\s*/, "").trim();
const REFUSED = {
  act: "その操作はできません。",
  unknown_q: "その項目はこのフローにありません。",
  not_a_fact: "その項目は症例が答える項目ではありません。",
  reading: "その項目は先生が選ぶ項目です（症例は答えません）。",
  hidden: "その項目は、いまの情報ではまだ聞けません。",
  not_ready: "結果はまだ出ていません（待つと、次の区切りで返ります）。",
  unknown_key: "その行為はこのフローにありません。",
  bad_say: "説明・相談・行き先は、400字までの文で記録します。",
  bad_stage: "その段はありません。",
  stage_back: "前の段には戻れません。",
};

/** Reads a pasted setting: { ok, setting, flow, report, error }.  Only an emergency flow of the imported schema (A04 routes its answers). */
export function parseSetting(text, FLOWS, readings, { strict = false } = {}) {
  let setting;
  try {
    setting = JSON.parse(String(text ?? ""));
  } catch {
    return { ok: false, error: "JSON として読めません。" };
  }
  const flow = FLOWS?.[setting?.flow];
  if (!flow) return { ok: false, error: "設定のフロー（flow）が、取り込んだフローにありません。" };
  if (!isEmergencyFlow(flow.id)) return { ok: false, error: "いまは救急外来のフローだけを模擬できます。" };
  const report = validateSimCase(setting, flow, { strict, readings });
  return report.ok ? { ok: true, setting, flow, report } : { ok: false, setting, flow, report, error: "設定が検査を通りません。" };
}

/** "<label>は、<value>。" (the type of sentence Modules' simulated patient uses); the role is shown in front by the screen. */
export function sentence(flow, q, value) {
  const qq = questionOf(flow, q);
  return `${plain(qq?.label ?? q)}は、${valueText(qq ?? { type: "text" }, value)}。`;
}

/** The running memo: one line per record, in order, with the shown clock. */
export function memoLines(setting, flow, records, minutes) {
  const at = (t) => clockAt(setting, t, minutes) || `区切り${t}`;
  const out = [];
  for (const r of records) {
    const head = { seq: r.seq, t: r.t, clock: at(r.t), kind: r.kind };
    if (r.kind === "answer") out.push({ ...head, who: r.who, text: sentence(flow, r.q, r.value) });
    else if (r.kind === "nodata") out.push({ ...head, who: "", text: `${plain(questionOf(flow, r.q)?.label ?? r.q)}: ${NO_DATA}` });
    else if (r.kind === "result") {
      for (const it of r.items) out.push({ ...head, who: "検査", text: it.nodata ? `${plain(questionOf(flow, it.q)?.label ?? it.q)}: ${NO_DATA}` : sentence(flow, it.q, it.value) });
    } else if (r.kind === "event") out.push({ ...head, who: r.who, text: r.text });
    else if (r.kind === "do") out.push({ ...head, who: "先生", text: `記録: ${actText(flow, r.key)}` });
    else if (r.kind === "say") out.push({ ...head, who: "先生", text: `${SAY_LABELS[r.type] ?? r.type}: ${r.text}` });
    else if (r.kind === "boundary") out.push({ ...head, who: "", text: r.to ? `── ${STAGES.find((s) => s.id === r.to)?.label ?? r.to} へ（時間が進む）` : "── 待つ（時間が進む）" });
    else if (r.kind === "refused") out.push({ ...head, who: "", text: REFUSED[r.reason] ?? "その操作はできません。" });
  }
  return out;
}

/** "出した検査：血液ガス" for an act key q=option. */
export function actText(flow, key) {
  const [qid, oid] = String(key).split("=");
  const q = questionOf(flow, qid);
  const o = (q?.options ?? []).find((x) => x.id === oid);
  return `${plain(q?.label ?? qid)}：${o ? o.short || o.label : oid}`;
}

const carefulOption = (q, v) => {
  const br = q?.br ?? {};
  const ids = Array.isArray(v) ? v : [v];
  return ["neg", "unk", "unable", "wait", "pend"].some((k) => Array.isArray(br[k]) && ids.some((id) => br[k].includes(id)));
};

/**
 * The tray: one row per answer the case gave (and per item of a result), newest last.  { id, q, value, who, text, careful, filled }
 * careful: a negative / unknown / not assessable / waiting answer or a time (taken one at a time); filled: the doctor already has an answer.
 */
export function trayRows(flow, records, answers) {
  const rows = [];
  for (const r of records) {
    const items = r.kind === "answer" ? [{ q: r.q, value: r.value, who: r.who }] : r.kind === "result" ? r.items.filter((x) => !x.nodata).map((x) => ({ ...x, who: "検査" })) : [];
    for (const it of items) {
      const q = questionOf(flow, it.q);
      rows.push({ id: `${r.seq}:${r.kind}:${it.q}`, q: it.q, value: it.value, who: it.who, text: sentence(flow, it.q, it.value), careful: q?.type === "time" || carefulOption(q, it.value), filled: isAnswered(answers?.[it.q]) });
    }
  }
  return rows;
}

/** Takes rows into the answers: an answer the doctor already has stays (never overwritten). */
export function takeRows(flow, answers, rows) {
  let next = { ...answers };
  for (const r of rows) if (!isAnswered(next[r.q])) next = setAnswer(flow, next, r.q, r.value);
  return next;
}

/** The doctor's act as an answer: the option is added (multi) or chosen (choice); the act's time question gets the shown clock if it is empty. */
export function applyAct(flow, answers, key, hm) {
  const [qid, oid] = String(key).split("=");
  const q = questionOf(flow, qid);
  if (!q || q.br?.ent !== "action" || !optionIds(q).includes(oid)) return answers;
  let next = setAnswer(flow, answers, qid, q.type === "multi" ? [...(Array.isArray(answers[qid]) ? answers[qid] : []), oid] : oid);
  const at = q.br?.at;
  if (at && hm && !isAnswered(next[at])) next = setAnswer(flow, next, at, hm);
  return next;
}

/** The action questions of the flow (the board: the same for every case of the flow, so the list itself is no hint). */
export const boardQuestions = (flow) => (flow.questions ?? []).filter((q) => q.br?.ent === "action" && (q.options ?? []).length);

/**
 * What the doctor fills in directly: readings and decisions (assessment / reason / none, and the simulation's reading questions), visible by the
 * doctor's own answers, by phase.  [{ phase, questions }]
 */
export function doctorQuestions(flow, answers, sex, readings) {
  const ctx = contextOf(answers ?? {}, { sex });
  return byPhase(flow)
    .map(({ phase, questions }) => ({
      phase,
      questions: questions.filter((q) => (["assessment", "reason", "none"].includes(q.br?.ent) || readings?.has(q.id)) && q.type !== "time" && isVisible(flow, q, ctx)),
    }))
    .filter((g) => g.questions.length);
}

/** The case for the note: the setting's age and sex, the doctor's answers and own A/P (nothing of the hidden setting). */
export function simKase(setting, flow, answers, own = "") {
  const base = { age: String(setting.patient.age), sex: setting.patient.sex, setting: "救急", own: String(own ?? "").trim() };
  return { ...base, structured: renderStructured(flow, answers, base), intake: { flow: flow.id, answers } };
}

/**
 * The debrief: laid side by side, nothing judged.  The key items of the setting's assumption, asked before / after the doctor recorded a
 * disposition, or not asked (the way Modules' drill review sorts the core questions).  { assumed, key: [{ q, label, status }], dispoSeq }
 */
export function debrief(setting, flow, records) {
  const dispo = records.find((r) => r.kind === "say" && r.type === "disposition");
  const dispoSeq = dispo ? dispo.seq : Infinity;
  const firstAsk = (q) => records.find((r) => (r.kind === "answer" || r.kind === "nodata") && r.q === q) ?? records.find((r) => r.kind === "result" && r.items.some((x) => x.q === q));
  const key = (setting.assumed?.key ?? []).map((q) => {
    const r = firstAsk(q);
    return { q, label: plain(questionOf(flow, q)?.label ?? q), status: !r ? "never" : r.seq > dispoSeq ? "after" : "before" };
  });
  return { assumed: setting.assumed ?? {}, key, dispoSeq: Number.isFinite(dispoSeq) ? dispoSeq : null };
}
export const KEY_STATUS = { before: "行き先を記録する前に聞いた", after: "行き先を記録した後に聞いた", never: "聞かなかった" };
export { SAY_TYPES, isReading };
