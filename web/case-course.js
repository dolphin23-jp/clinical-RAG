// The course of an admission inside a case record (docs/enhancement-plan.md 8.5, 8.6, 8.14; docs/clinical-use.md 1e): what is added after the
// admission note — one entry per hospital day ("入院N日目"), the doctor's reading of how each problem is going, the tasks that are still
// open — and the one function that keeps the later notes honest: asOf(rec, N), the record as it stood at the end of day N.
//
// Pure functions over a record (no DOM, no network, no storage, no AI); every change returns a new record.  The record's own helpers live
// in case-record.js, which imports this file (so this file imports nothing from it).
//
// The rules (8.6) as they are kept here:
//  - A blank stays blank: a problem's trend is improved / unchanged / worse only when the doctor chose one; no choice is "not assessed"
//    and is never written as "unchanged" or "stable".
//  - Nothing later is written: every problem, entry and task carries the day it was added (`added`), a judgement that changes (a
//    problem's certainty, a plan's state) is logged with its day, and asOf() shows only what was there on that day.  A note for day 3
//    written on day 8 does not show a certainty confirmed on day 6.
//  - A plan is "planned" until the doctor records done / changed / stopped (with the day it was recorded).
//  - Time is relative: a day is a number (the admission day is 1); there is no calendar date anywhere.
//  - What a day's free texts say is the doctor's words, edited in place; the judgements above are the part with a history.

export const TREND = [
  { id: "improved", label: "改善" },
  { id: "unchanged", label: "不変" },
  { id: "worse", label: "悪化" },
];
export const TASK_KINDS = [
  { id: "result", label: "結果待ち" },
  { id: "consult", label: "コンサルトの返事" },
  { id: "followup", label: "フォロー" },
  { id: "other", label: "その他" },
];
/** The doctor's own texts of one day, in the order of the progress note (A06). */
export const DAY_FIELDS = [
  { key: "interval", label: "前回からのイベント", max: 1000, note: "A06 の「前回からのイベント」" },
  { key: "subjective", label: "主観的症状・変化", max: 600, note: "A06 の「主観的症状・変化」" },
  { key: "objective", label: "身体所見・検査の推移（記録するだけ）", max: 1500, note: "A06 の「身体所見・検査推移」" },
  { key: "overall", label: "患者全体の状態", max: 600, note: "A06 の「患者全体の状態」" },
  { key: "general", label: "栄養・活動・デバイス・退院調整", max: 800, note: "A06 の「栄養・活動・デバイス・退院調整」" },
  { key: "handover", label: "翌日の確認・再評価・コール条件", max: 800, note: "A06 の「翌日確認・再評価・コール条件」" },
];
/** What the doctor writes for an interim summary / transfer note (A07); built around the days marked as turning points. */
export const SUMMARY_FIELDS = [
  { key: "context", label: "転棟先・引継ぎの理由", max: 800, note: "A07 の「転棟先・引継ぎ理由」" },
  { key: "condition", label: "現時点の呼吸・循環・意識など（記録するだけ）", max: 800, note: "A07 の「現時点の呼吸・循環・意識等」" },
  { key: "ongoing", label: "継続治療・デバイス", max: 800, note: "A07 の「継続治療・デバイス」" },
  { key: "handover", label: "引継ぎ先・依頼・共有の状況", max: 800, note: "A07 の「引継ぎ先・依頼・共有の状況」" },
];
/** What the doctor writes for the discharge summary (A08), besides the decision, the medications and what the record already holds. */
export const DISCHARGE_FIELDS = [
  { key: "dest", label: "退院先", max: 200, note: "A08 の「入退院日・退院先」" },
  { key: "procedures", label: "主要な検査・処置", max: 1000, note: "A08 の「主要検査・処置」" },
  { key: "state", label: "退院時の状態（記録するだけ）", max: 1000, note: "A08 の「退院時状態・残存課題」" },
  { key: "followup", label: "外来・在宅の方針", max: 1000, note: "A08 の「外来・在宅の方針」" },
];
/** What happened to a medication at discharge.  A change or a stop needs a reason (the check counts those without one). */
export const MED_CHANGES = [
  { id: "new", label: "新規" },
  { id: "changed", label: "変更" },
  { id: "stopped", label: "中止" },
  { id: "continued", label: "継続" },
];
export const COURSE_LIMITS = { days: 60, tasks: 40, maxDay: 365, text: 600, trendNote: 400, owner: 60, due: 60, log: 20, meds: 40, medText: 300 };

const TREND_IDS = new Set(TREND.map((t) => t.id));
const MED_IDS = new Set(MED_CHANGES.map((m) => m.id));
const MID = /^m\d{1,4}$/;
const KIND_IDS = new Set(TASK_KINDS.map((t) => t.id));
const PID = /^p\d{1,4}$/;
const KID = /^k\d{1,4}$/;
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v, max) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim().slice(0, max) : "");
const clone = (o) => structuredClone(o);
/** A day number: a whole number from 1 (the admission day) to maxDay, or the fallback. */
export const dayNo = (v, fallback = 1) => (Number.isInteger(v) && v >= 1 && v <= COURSE_LIMITS.maxDay ? v : fallback);

// ---------------------------------------------------------------- the history of a judgement
/** The item a log gives on day n: the last one with day <= n, or undefined. */
export const logAt = (log, n) => {
  let at;
  for (const l of log ?? []) if (l.day <= n && (!at || l.day >= at.day)) at = l;
  return at;
};

/** A log of a judgement that changed: [{ day, ...}] one item per day (the last one wins), by day, at most COURSE_LIMITS.log. */
export function cleanLog(raw, ok, pick) {
  const byDay = new Map();
  for (const l of Array.isArray(raw) ? raw : []) if (isObj(l) && dayNo(l.day, 0) && ok(l)) byDay.set(l.day, { day: l.day, ...pick(l) });
  return [...byDay.values()].sort((a, b) => a.day - b.day).slice(-COURSE_LIMITS.log);
}

/**
 * Writes a judgement into its log (what the doctor decided, and from which day).  The day is the working day, but never earlier than the day
 * the thing was added or than the last item already in the log: the log's last item is always the current value, so the notes of the latest
 * days agree with the board even when the doctor went back to an earlier day to edit (the edit then counts from the last day already
 * recorded).  `seed`: the items to start from when the log is empty and the thing already had a non-default value (a record made before the
 * log existed): that value is kept as it stood from the day the thing was added.
 */
export function stampLog(log, { today, added = 1, item, seed = [] }) {
  const base = log?.length ? log : seed;
  const day = Math.max(today, added, ...base.map((l) => l.day));
  return [...base.filter((l) => l.day !== day), { day, ...item }].sort((a, b) => a.day - b.day).slice(-COURSE_LIMITS.log);
}

export const emptyDischarge = () => ({ decided: false, day: null, ...Object.fromEntries(DISCHARGE_FIELDS.map((f) => [f.key, ""])), meds: [] });
export const emptyCourse = () => ({ today: 1, days: [], tasks: [], summary: Object.fromEntries(SUMMARY_FIELDS.map((f) => [f.key, ""])), discharge: emptyDischarge() });

// ---------------------------------------------------------------- shape (an untrusted course read back from the server)
/** `problemIds`: the ids of the record's problems (a trend or task that names another is dropped). */
export function cleanCourse(raw, problemIds) {
  const out = emptyCourse();
  if (!isObj(raw)) return out;
  out.today = dayNo(raw.today);
  const seen = new Set();
  for (const d of (Array.isArray(raw.days) ? raw.days : []).slice(0, COURSE_LIMITS.days)) {
    if (!isObj(d) || !Number.isInteger(d.day) || dayNo(d.day, 0) === 0 || seen.has(d.day)) continue;
    seen.add(d.day);
    const day = { day: d.day };
    for (const f of DAY_FIELDS) day[f.key] = str(d[f.key], f.max);
    day.turning = d.turning === true;
    day.trend = {};
    for (const [pid, t] of isObj(d.trend) ? Object.entries(d.trend) : []) {
      if (!PID.test(pid) || !problemIds.includes(pid) || !isObj(t)) continue;
      const state = TREND_IDS.has(t.state) ? t.state : "";
      const note = str(t.note, COURSE_LIMITS.trendNote);
      if (state || note) day.trend[pid] = { state, ...(note ? { note } : {}) };
    }
    out.days.push(day);
  }
  out.days.sort((a, b) => a.day - b.day);
  const kseen = new Set();
  for (const k of (Array.isArray(raw.tasks) ? raw.tasks : []).slice(0, COURSE_LIMITS.tasks)) {
    if (!isObj(k) || typeof k.id !== "string" || !KID.test(k.id) || kseen.has(k.id)) continue;
    const text = str(k.text, COURSE_LIMITS.text);
    if (!text) continue;
    kseen.add(k.id);
    const task = {
      id: k.id,
      text,
      kind: KIND_IDS.has(k.kind) ? k.kind : "", // a kind the doctor did not choose stays blank (it is not "結果待ち")
      owner: str(k.owner, COURSE_LIMITS.owner),
      due: str(k.due, COURSE_LIMITS.due),
      added: dayNo(k.added),
      state: k.state === "done" ? "done" : "open",
    };
    if (typeof k.problem === "string" && problemIds.includes(k.problem)) task.problem = k.problem;
    if (task.state === "done") task.closed = Math.max(task.added, dayNo(k.closed, task.added));
    const log = cleanLog(k.log, (l) => l.state === "open" || l.state === "done", (l) => ({ state: l.state }));
    if (log.length) {
      // the log is the history: the task's state is its last item
      task.log = log;
      task.state = log.at(-1).state;
      if (task.state === "done") task.closed = log.at(-1).day;
      else delete task.closed;
    }
    out.tasks.push(task);
  }
  for (const f of SUMMARY_FIELDS) out.summary[f.key] = str(isObj(raw.summary) ? raw.summary[f.key] : "", f.max);
  const dc = isObj(raw.discharge) ? raw.discharge : {};
  for (const f of DISCHARGE_FIELDS) out.discharge[f.key] = str(dc[f.key], f.max);
  // a discharge is decided only when the doctor said so AND gave the day (an ended stay is not a discharge)
  out.discharge.decided = dc.decided === true && dayNo(dc.day, 0) > 0;
  out.discharge.day = dayNo(dc.day, 0) > 0 ? dc.day : null;
  const mseen = new Set();
  for (const m of (Array.isArray(dc.meds) ? dc.meds : []).slice(0, COURSE_LIMITS.meds)) {
    if (!isObj(m) || typeof m.id !== "string" || !MID.test(m.id) || mseen.has(m.id)) continue;
    const text = str(m.text, COURSE_LIMITS.medText);
    if (!text) continue;
    mseen.add(m.id);
    const reason = str(m.reason, COURSE_LIMITS.medText);
    out.discharge.meds.push({ id: m.id, text, change: MED_IDS.has(m.change) ? m.change : "", ...(reason ? { reason } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------- the working day
/** The day the doctor is working in: what is added now is stamped with it. */
export function setToday(rec, n) {
  const next = clone(rec);
  next.course.today = dayNo(n, next.course.today);
  return next;
}

/** The day after the last day that has an entry, or after today (the larger): "次の日へ". */
export const nextDay = (rec) => Math.min(COURSE_LIMITS.maxDay, Math.max(rec.course.today, ...rec.course.days.map((d) => d.day)) + 1);

const emptyDay = (n) => ({ day: n, ...Object.fromEntries(DAY_FIELDS.map((f) => [f.key, ""])), turning: false, trend: {} });

function dayOf(next, n, create = true) {
  let d = next.course.days.find((x) => x.day === n);
  if (!d && create && next.course.days.length < COURSE_LIMITS.days) {
    d = emptyDay(n);
    next.course.days.push(d);
    next.course.days.sort((a, b) => a.day - b.day);
  }
  return d ?? null;
}

/** Whether something can be written for day n: it already has an entry, or there is room for one (COURSE_LIMITS.days). */
export const canWriteDay = (rec, n) => dayNo(n, 0) > 0 && (rec.course.days.some((d) => d.day === n) || rec.course.days.length < COURSE_LIMITS.days);

const isEmptyDay = (d) => DAY_FIELDS.every((f) => !d[f.key]) && !d.turning && !Object.keys(d.trend).length;
/** A day that holds nothing (no text, no trend, no mark) is not kept: it would only use up the room for days. */
const pruneDay = (next, d) => {
  if (d && isEmptyDay(d)) next.course.days = next.course.days.filter((x) => x !== d);
};

/** Removes the days that hold nothing (after something they held was taken away). */
export function dropEmptyDays(next) {
  next.course.days = next.course.days.filter((d) => !isEmptyDay(d));
}

/** Sets one of a day's texts (DAY_FIELDS).  The day is made when it has none; a day left with nothing is removed. */
export function setDayField(rec, n, key, text) {
  const next = clone(rec);
  const f = DAY_FIELDS.find((x) => x.key === key);
  const t = f ? str(text, f.max) : "";
  const d = f && dayNo(n, 0) ? dayOf(next, n, !!t) : null;
  if (d) {
    d[key] = t;
    pruneDay(next, d);
  }
  return next;
}

/** Marks a day as a turning point of the course (the doctor's mark; the interim and discharge summaries are built around such days). */
export function setDayTurning(rec, n, on) {
  const next = clone(rec);
  const d = dayNo(n, 0) ? dayOf(next, n, !!on) : null;
  if (!d) return next;
  d.turning = !!on;
  pruneDay(next, d);
  return next;
}

/** Removes a day's entry (its texts, its trends and its mark). */
export function removeDay(rec, n) {
  const next = clone(rec);
  next.course.days = next.course.days.filter((d) => d.day !== n);
  return next;
}

/** The doctor's reading of how a problem is going on a day: "improved" / "unchanged" / "worse"; "" is not assessed (blank), with or without a note. */
export function setTrend(rec, n, problemId, state, note) {
  const next = clone(rec);
  if (!next.problems.some((p) => p.id === problemId) || !dayNo(n, 0)) return next;
  const d = dayOf(next, n, !(state === "" && !note)); // clearing a trend of a day that has no entry makes no entry
  if (!d) return next;
  const prev = d.trend[problemId] ?? { state: "" };
  const s = state === undefined ? prev.state : TREND_IDS.has(state) ? state : "";
  const nt = note === undefined ? prev.note ?? "" : str(note, COURSE_LIMITS.trendNote);
  if (!s && !nt) delete d.trend[problemId];
  else d.trend[problemId] = { state: s, ...(nt ? { note: nt } : {}) };
  pruneDay(next, d);
  return next;
}

// ---------------------------------------------------------------- tasks (what is still open: results, replies, follow-up)
/** A task of the doctor's: text, kind, who, by when (relative text), and optionally the problem it belongs to.  Stamped with today. */
export function addTask(rec, fields = {}) {
  const next = clone(rec);
  if (next.course.tasks.length >= COURSE_LIMITS.tasks) return { rec: next, id: null };
  next.seq.k = (next.seq.k ?? 0) + 1;
  const id = `k${next.seq.k}`;
  const task = {
    id,
    text: str(fields.text, COURSE_LIMITS.text),
    kind: KIND_IDS.has(fields.kind) ? fields.kind : "", // not chosen: blank (never 結果待ち unless the doctor chose it)
    owner: str(fields.owner, COURSE_LIMITS.owner),
    due: str(fields.due, COURSE_LIMITS.due),
    added: next.course.today,
    state: "open",
  };
  if (typeof fields.problem === "string" && next.problems.some((p) => p.id === fields.problem)) task.problem = fields.problem;
  next.course.tasks.push(task);
  return { rec: next, id };
}

/** Changes a task.  Done is the doctor's: it stamps the day it was closed; nothing closes a task by itself (a reply received is not a task done). */
export function setTask(rec, id, patch) {
  const next = clone(rec);
  const t = next.course.tasks.find((x) => x.id === id);
  if (!t) return next;
  if ("text" in patch) t.text = str(patch.text, COURSE_LIMITS.text);
  if ("kind" in patch) t.kind = KIND_IDS.has(patch.kind) ? patch.kind : "";
  if ("owner" in patch) t.owner = str(patch.owner, COURSE_LIMITS.owner);
  if ("due" in patch) t.due = str(patch.due, COURSE_LIMITS.due);
  if ("problem" in patch) {
    if (typeof patch.problem === "string" && next.problems.some((p) => p.id === patch.problem)) t.problem = patch.problem;
    else delete t.problem;
  }
  if ("state" in patch && (patch.state === "done" || patch.state === "open") && patch.state !== t.state) {
    // closing and reopening are logged with the day: a note of an earlier day shows what it was then (a reopened task was closed before)
    const seed = t.state === "done" ? [{ day: t.added, state: "open" }, { day: t.closed ?? t.added, state: "done" }] : [];
    t.log = stampLog(t.log, { today: next.course.today, added: t.added, item: { state: patch.state }, seed });
    t.state = patch.state;
    if (t.state === "done") t.closed = t.log.at(-1).day;
    else delete t.closed;
  }
  return next;
}

export function removeTask(rec, id) {
  const next = clone(rec);
  next.course.tasks = next.course.tasks.filter((x) => x.id !== id);
  return next;
}

// ---------------------------------------------------------------- the interim summary and the discharge
/** One of the doctor's texts of the interim summary (SUMMARY_FIELDS). */
export function setSummary(rec, key, text) {
  const next = clone(rec);
  const f = SUMMARY_FIELDS.find((x) => x.key === key);
  if (f) next.course.summary[key] = str(text, f.max);
  return next;
}

/**
 * The discharge: `decided` is the doctor's decision, with the day it was made (an ended stay is not a discharge, and a discharge with
 * no day is not one); `patch` may hold decided, day, and the texts of DISCHARGE_FIELDS.  Deciding without a day uses the working day.
 */
export function setDischarge(rec, patch) {
  const next = clone(rec);
  const dc = next.course.discharge;
  for (const f of DISCHARGE_FIELDS) if (f.key in patch) dc[f.key] = str(patch[f.key], f.max);
  if ("day" in patch) dc.day = dayNo(patch.day, 0) > 0 ? patch.day : null;
  if ("decided" in patch) {
    // deciding with a day that is not a day is not a decision (it is not turned into today)
    dc.decided = patch.decided === true && !("day" in patch && !dc.day);
    if (dc.decided && !dc.day) dc.day = next.course.today;
  }
  if (dc.decided && !dc.day) dc.decided = false;
  return next;
}

/** A medication at discharge: its words, what happened to it, why.  "" is not decided (blank). */
export function addMed(rec, fields = {}) {
  const next = clone(rec);
  if (next.course.discharge.meds.length >= COURSE_LIMITS.meds) return { rec: next, id: null };
  next.seq.m = (next.seq.m ?? 0) + 1;
  const id = `m${next.seq.m}`;
  const reason = str(fields.reason, COURSE_LIMITS.medText);
  next.course.discharge.meds.push({ id, text: str(fields.text, COURSE_LIMITS.medText), change: MED_IDS.has(fields.change) ? fields.change : "", ...(reason ? { reason } : {}) });
  return { rec: next, id };
}

export function setMed(rec, id, patch) {
  const next = clone(rec);
  const m = next.course.discharge.meds.find((x) => x.id === id);
  if (!m) return next;
  if ("text" in patch) m.text = str(patch.text, COURSE_LIMITS.medText);
  if ("change" in patch) m.change = MED_IDS.has(patch.change) ? patch.change : "";
  if ("reason" in patch) {
    const r = str(patch.reason, COURSE_LIMITS.medText);
    if (r) m.reason = r;
    else delete m.reason;
  }
  return next;
}

export function removeMed(rec, id) {
  const next = clone(rec);
  next.course.discharge.meds = next.course.discharge.meds.filter((x) => x.id !== id);
  return next;
}

// ---------------------------------------------------------------- the record as it stood on day N
/** The latest trend a problem had on or before day n: { day, state, note } or null. */
export function trendAt(rec, problemId, n) {
  let found = null;
  for (const d of rec.course.days) {
    const t = d.trend[problemId];
    if (d.day <= n && t && (!found || d.day >= found.day)) found = { day: d.day, state: t.state, ...(t.note ? { note: t.note } : {}) };
  }
  return found;
}

/** A task as it stood on day n: its state is the last item of its log up to then (a task with no log: done on its `closed` day, open before). */
function taskAt(k, n) {
  const items = k.log?.length ? k.log : k.state === "done" ? [{ day: k.added, state: "open" }, { day: k.closed ?? k.added, state: "done" }] : [];
  const at = logAt(items, n);
  const { closed, ...rest } = k;
  return at?.state === "done" ? { ...rest, state: "done", closed: at.day } : { ...rest, state: "open" };
}

/**
 * The record as it stood at the end of day n (a copy; the input is not touched): problems, entries, tasks and day entries added later are
 * not there; a problem's certainty, a plan's state and a task's state are the ones the doctor had recorded by then; each problem carries
 * its `trend` for that day (the latest one on or before it, with its day).  Everything a later note shows about "then" comes through here.
 */
export function asOf(rec, n) {
  const next = clone(rec);
  const day = dayNo(n, next.course.today);
  next.course.today = Math.min(next.course.today, day);
  next.course.days = next.course.days.filter((d) => d.day <= day);
  next.course.tasks = next.course.tasks.filter((k) => k.added <= day).map((k) => taskAt(k, day));
  next.problems = next.problems.filter((p) => (p.added ?? 1) <= day);
  for (const p of next.problems) {
    const c = logAt(p.cert_log, day);
    p.certainty = c ? c.certainty : p.cert_log?.length ? "" : p.certainty;
    for (const which of ["assess", "plan"]) p[which] = p[which].filter((e) => (e.added ?? 1) <= day);
    if (p.refs) {
      // a book's page the doctor left after day n was not there on day n
      p.refs = p.refs.filter((r) => (r.added ?? 1) <= day);
      if (!p.refs.length) delete p.refs;
    }
    for (const e of p.plan) {
      const s = logAt(e.log, day);
      if (s) {
        e.state = s.state;
        if (s.reason) e.reason = s.reason;
        else delete e.reason;
      } else if (e.log?.length) {
        e.state = "planned";
        delete e.reason;
      }
    }
    p.trend = trendAt(rec, p.id, day);
  }
  next.contingency = next.contingency.filter((e) => (e.added ?? 1) <= day);
  // a task linked (later) to a problem that did not exist on day n is not linked on day n
  for (const k of next.course.tasks) if (k.problem && !next.problems.some((p) => p.id === k.problem)) delete k.problem;
  // a discharge decided after day n is not known on day n
  if (next.course.discharge.decided === true && next.course.discharge.day > day) next.course.discharge = emptyDischarge();
  return next;
}

// ---------------------------------------------------------------- checks: what is blank or not decided (notes, not judgements)
/**
 * Counts what the course leaves blank or undecided on the working day.  Each is { id, text, items: [string] }; none is a verdict (no
 * "normal", "abnormal", "late").  An empty list means nothing of that kind is blank, not that the care is right.
 */
export function courseChecks(rec) {
  const v = asOf(rec, rec.course.today);
  const today = v.course.today;
  const out = [];
  const add = (id, text, items = []) => out.push({ id, text, items });
  const name = (p) => p.label || "（名前なし）";
  const planned = [];
  const reasonless = [];
  for (const p of v.problems) {
    for (const e of p.plan) {
      if (e.state === "planned" && (e.added ?? 1) < today) planned.push(`${name(p)}: ${e.text.slice(0, 30)}`);
      if ((e.state === "changed" || e.state === "stopped") && !e.reason) reasonless.push(`${name(p)}: ${e.text.slice(0, 30)}`);
    }
  }
  if (planned.length) add("plan_unrecorded", `前の日までに立てた計画のうち、実施・変更・中止のどれも記録していないものが ${planned.length} 件（予定のまま）`, planned);
  if (reasonless.length) add("plan_reason", `変更・中止の理由を書いていない計画が ${reasonless.length} 件`, reasonless);
  const day = v.course.days.find((d) => d.day === today);
  if (day) {
    const untrended = v.problems.filter((p) => (p.label || p.assess.length || p.plan.length) && !(day.trend[p.id]?.state));
    if (untrended.length) add("trend_missing", `入院${today}日目の推移（改善・不変・悪化）を選んでいない問題が ${untrended.length} 件（選ばなければ「未評価」です）`, untrended.map(name));
  }
  const open = v.course.tasks.filter((k) => k.state === "open" && k.text);
  if (open.length) add("tasks_open", `未完了の課題が ${open.length} 件`, open.map((k) => `${TASK_KINDS.find((x) => x.id === k.kind)?.label ? `${TASK_KINDS.find((x) => x.id === k.kind).label}: ` : ""}${k.text.slice(0, 30)}`));
  const loose = open.filter((k) => !k.owner || !k.due);
  if (loose.length) add("tasks_incomplete", `${v.course.discharge.decided ? "退院時サマリーの「未解決」に載る課題のうち、" : ""}担当者または期限が未入力の課題が ${loose.length} 件`, loose.map((k) => `${k.text.slice(0, 30)}（${k.owner ? "" : "担当者"}${!k.owner && !k.due ? "・" : ""}${k.due ? "" : "期限"}）`));
  const meds = rec.course.discharge.meds.filter((m) => m.text && (m.change === "changed" || m.change === "stopped") && !m.reason);
  if (meds.length) add("meds_reason", `変更・中止の理由を書いていない退院時の処方が ${meds.length} 件`, meds.map((m) => m.text.slice(0, 30)));
  const unset = rec.course.discharge.meds.filter((m) => m.text && !m.change);
  if (unset.length) add("meds_unset", `新規・変更・中止・継続のどれかを選んでいない退院時の処方が ${unset.length} 件（選ばなければ「未記入」です）`, unset.map((m) => m.text.slice(0, 30)));
  return out;
}
