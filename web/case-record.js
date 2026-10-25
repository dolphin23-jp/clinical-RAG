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
import { TEXT_KEYS, caseKey, cleanCase, caseSummary, isEmptyCase } from "./case-model.js";
import { DAY_FIELDS, DISCHARGE_FIELDS, SUMMARY_FIELDS, asOf, cleanCourse, cleanLog, courseChecks, dayNo, dropEmptyDays, emptyCourse, stampLog } from "./case-course.js";
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
/** The doctor's designation of a problem in the discharge summary (a blank means not designated: it is listed as "not classed"). */
export const DX_CLASSES = [
  { id: "main", label: "主病名" },
  { id: "sub", label: "副病名" },
];
/** What the doctor can record for a plan entry.  "done" is the doctor's record of an action; nothing sets it by itself. */
export const PLAN_STATES = [
  { id: "planned", label: "予定・検討" },
  { id: "done", label: "実施（医師の記録）" },
  { id: "changed", label: "変更" },
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

/** The largest record the server keeps (worker/src/recordstore.ts MAX_RECORD_PAYLOAD; a test keeps the two equal), in characters of its JSON. */
export const RECORD_BUDGET = 400_000;
export const LIMITS = { title: 80, label: 120, text: 600, reason: 300, adm: 1500, heading: 80, cite: 200, problems: 20, entries: 12, adopted: 60, cites: 6, seen: 12, reading: 40, refs: 8, page: 40, section: 100 };

/** Time questions that ask when the problem began (before the arrival, as a rule).  Every other time question is something done in the emergency room. */
export const PRE_ARRIVAL = new Set(["t_sz", "t_onset", "t_bleed"]);
const READINGS = new Set(["after", "before"]);
const QID = /^[a-z][a-z0-9_]{0,40}$/;
const hasRole = (r) => typeof r === "string" && Object.hasOwn(ROLES, r);
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

// ---------------------------------------------------------------- the books' pages kept for a problem (docs/enhancement-plan.md 8.16)
// A problem keeps the pages the doctor chose to leave for it (found by a search, `refs`) and the pages an adopted AI item cited (the
// `cites` of its entries, kept since stage 2).  Only where to look is kept: a book's title, the page, the section's name; never a
// line of the book's text.  A page left for a problem says the doctor looked at it, not that the book supports anything written
// about the problem.  Each carries the day it was added, so a note of an earlier day does not show it (asOf).
const REF_VIA = new Set(["found"]);
const cleanTitle = (t) => String(t ?? "").replace(/(\s*［[^］]*］)+\s*$/, "").trim();
/** The identity of a page: the book's title (without the flags at its end) and the page.  The same page is one page. */
export const refKey = (r) => `${cleanTitle(r?.title)}|${String(r?.page ?? "").trim()}`;

/** The pages kept for a problem, read back (untrusted shape): known keys, cut to the limits, one per page, at most LIMITS.refs. */
export function cleanRefs(raw) {
  const out = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    if (!isObj(r) || out.length >= LIMITS.refs) continue;
    const title = str(cleanTitle(r.title), LIMITS.cite);
    const page = str(r.page, LIMITS.page);
    if (!title || !page || out.some((x) => refKey(x) === refKey({ title, page }))) continue;
    const section = str(r.section, LIMITS.section);
    out.push({ title, page, ...(section ? { section } : {}), via: REF_VIA.has(r.via) ? r.via : "found", added: dayNo(r.added) });
  }
  return out;
}

/**
 * Every book page a problem has, once each: the pages the doctor left (`pinned`, first) and the pages cited by the AI items it carries
 * (the problem's own, from an adopted problem-list item, and its assessment and plan entries'), with the day each came.  A web citation is not
 * a book and is not listed.  Returns [{ title, page, section?, via: "found" | "cited", added, pinned }].
 */
export function refsOf(p) {
  const out = [];
  const add = (c, via, added, pinned) => {
    if (!isObj(c) || c.kind === "web") return;
    const title = str(cleanTitle(c.title), LIMITS.cite);
    const page = str(c.page, LIMITS.page);
    if (!title || !page || out.some((x) => refKey(x) === refKey({ title, page }))) return;
    out.push({ title, page, ...(c.section ? { section: str(c.section, LIMITS.section) } : {}), via, added: dayNo(added), pinned });
  };
  for (const r of p.refs ?? []) add(r, "found", r.added, true);
  if (p.ai === true) for (const c of p.cites ?? []) add(c, "cited", p.added, false);
  for (const e of [...(p.assess ?? []), ...(p.plan ?? [])]) if (e.from === "ai") for (const c of e.cites ?? []) add(c, "cited", e.added, false);
  return out;
}

function cleanEntry(raw, isPlan, used) {
  if (!isObj(raw)) return null;
  const text = str(raw.text, LIMITS.text);
  if (!text || typeof raw.id !== "string" || !ID.i.test(raw.id) || used.has(raw.id)) return null;
  used.add(raw.id);
  const e = { id: raw.id, text, from: ["typed", "ai", "ed"].includes(raw.from) ? raw.from : "typed", added: dayNo(raw.added) };
  const cites = cleanCites(raw.cites);
  if (cites.length) e.cites = cites;
  if (isPlan) {
    e.state = STATE_IDS.has(raw.state) ? raw.state : "planned";
    const reason = str(raw.reason, LIMITS.reason);
    if (reason) e.reason = reason;
    const log = cleanLog(raw.log, (l) => STATE_IDS.has(l.state), (l) => ({ state: l.state, ...(str(l.reason, LIMITS.reason) ? { reason: str(l.reason, LIMITS.reason) } : {}) }));
    if (log.length) e.log = log;
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
    k: Math.max(num(given?.k), top(rec.course.tasks.map((k) => k.id), /^k\d{1,4}$/)),
    m: Math.max(num(given?.m), top(rec.course.discharge.meds.map((m) => m.id), /^m\d{1,4}$/)),
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
      added: dayNo(p.added),
      ...(p.dx === "main" || p.dx === "sub" ? { dx: p.dx } : {}),
      ...(cleanLog(p.cert_log, (l) => l.certainty === "" || CERT_IDS.has(l.certainty), (l) => ({ certainty: l.certainty })).length ? { cert_log: cleanLog(p.cert_log, (l) => l.certainty === "" || CERT_IDS.has(l.certainty), (l) => ({ certainty: l.certainty })) } : {}),
      ...(p.ai === true ? { ai: true } : {}),
      ...(p.ai === true && cleanCites(p.cites).length ? { cites: cleanCites(p.cites) } : {}),
      ...(cleanRefs(p.refs).length ? { refs: cleanRefs(p.refs) } : {}),
      assess: (Array.isArray(p.assess) ? p.assess : []).slice(0, LIMITS.entries).map((e) => cleanEntry(e, false, used)).filter(Boolean),
      plan: (Array.isArray(p.plan) ? p.plan : []).slice(0, LIMITS.entries).map((e) => cleanEntry(e, true, used)).filter(Boolean),
    });
  }
  const contingency = (Array.isArray(raw.contingency) ? raw.contingency : []).slice(0, LIMITS.entries).map((e) => cleanEntry(e, false, used)).filter(Boolean);
  const adopted = [];
  for (const a of (Array.isArray(raw.ed.adopted) ? raw.ed.adopted : []).slice(0, LIMITS.adopted)) {
    if (!isObj(a) || typeof a.id !== "string" || !ID.a.test(a.id) || adopted.some((x) => x.id === a.id) || !hasRole(a.role)) continue;
    const text = str(a.text, LIMITS.text);
    if (!text) continue;
    const to = a.to === "none" || a.to === "outlook" || problems.some((p) => p.id === a.to) ? a.to : "";
    const item = { id: a.id, role: a.role, heading: str(a.heading, LIMITS.heading), text, cites: cleanCites(a.cites), to };
    if (to && typeof a.entry === "string" && used.has(a.entry)) item.entry = a.entry;
    if (typeof a.made === "string" && problems.some((p) => p.id === a.made)) item.made = a.made;
    adopted.push(item);
  }
  const adm = {};
  for (const f of ADM_FIELDS) adm[f.key] = str(isObj(raw.adm) ? raw.adm[f.key] : "", LIMITS.adm);
  // the versions of the case this record has had (short hashes), so an answer asked with an earlier version is still this case's
  const seen = (Array.isArray(raw.ed.seen) ? raw.ed.seen : []).filter((h) => typeof h === "string" && /^[0-9a-z]{1,10}$/.test(h)).slice(-LIMITS.seen);
  if (!seen.includes(caseHash(kase))) seen.push(caseHash(kase));
  const reading = {};
  for (const [k, v] of isObj(raw.ed.reading) ? Object.entries(raw.ed.reading).slice(0, LIMITS.reading) : []) if (QID.test(k) && READINGS.has(v)) reading[k] = v;
  const course = cleanCourse(raw.course, problems.map((p) => p.id));
  const rec = { v: RECORD_VERSION, title: str(raw.title, LIMITS.title) || recordTitle(kase), ed: { case: kase, adopted, seen: seen.slice(-LIMITS.seen), reading }, adm, problems, contingency, course, seq: { p: 0, i: 0, a: 0, k: 0, m: 0 } };
  rec.seq = seqOf(rec, raw.seq);
  return rec;
}

/** The title shown in the list: the case's one-line summary (no date). */
export function recordTitle(kase) {
  return (caseSummary(kase) || "症例").slice(0, LIMITS.title);
}

/** A short fingerprint of a case (the hash of its text): stored instead of the text, to tell whether a turn was asked with this record's case. */
export function caseHash(kase) {
  let h = 0x811c9dc5;
  for (const ch of caseKey(kase)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Whether a case is one this record has had (the current one or an earlier version of it).  Not proof of the same patient: a hint to ask. */
export const isRecordCase = (rec, kase) => rec.ed.seen.includes(caseHash(cleanCase(kase)));

export function newRecord(kase) {
  const c = cleanCase(kase);
  return cleanRecord({ v: RECORD_VERSION, title: recordTitle(c), ed: { case: c, adopted: [], seen: [], reading: {} }, adm: {}, problems: [], contingency: [], course: emptyCourse(), seq: {} });
}

// ---------------------------------------------------------------- no calendar date is kept
/**
 * Makes every date in the record's free texts relative ("N日前", "入院N日目"; web/date-relative.js) so none is saved.  The screen does this when
 * something is pasted and when a field is left; this is the last pass before saving.  Returns { rec, changes } (rec is the same object when
 * nothing changed).
 */
export function relativizeRecord(rec, { now = new Date() } = {}) {
  // the notes, the checks and the save each ask for it on the same record object (records are never changed in place: every edit returns a
  // new one), so the answer is kept for that object for the day it was computed on
  const day = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const hit = RELATIVE_CACHE.get(rec);
  if (hit?.day === day) return hit.value;
  const value = relativize(rec, now);
  RELATIVE_CACHE.set(rec, { day, value });
  return value;
}
const RELATIVE_CACHE = new WeakMap();

function relativize(rec, now) {
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
      for (const l of e.log ?? []) fix(l, "reason"); // the history of a plan's state carries the reason too
    }
  }
  for (const e of next.contingency) fix(e, "text");
  for (const a of next.ed.adopted) fix(a, "text");
  for (const d of next.course.days) {
    for (const f of DAY_FIELDS) fix(d, f.key);
    for (const t of Object.values(d.trend)) fix(t, "note");
  }
  for (const k of next.course.tasks) for (const key of ["text", "owner", "due"]) fix(k, key);
  for (const f of SUMMARY_FIELDS) fix(next.course.summary, f.key);
  for (const f of DISCHARGE_FIELDS) fix(next.course.discharge, f.key);
  for (const m of next.course.discharge.meds) {
    fix(m, "text");
    fix(m, "reason");
  }
  return { rec: changes.length ? next : rec, changes };
}

// ---------------------------------------------------------------- the emergency encounter
/** Replaces the case (the doctor edited the pinned case): the title follows it; problems, carried items and the admission text stay. */
export function setCase(rec, kase) {
  const next = clone(rec);
  next.ed.case = cleanCase(kase);
  next.title = recordTitle(next.ed.case);
  const h = caseHash(next.ed.case);
  next.ed.seen = [...next.ed.seen.filter((x) => x !== h), h].slice(-LIMITS.seen);
  return next;
}

/** Takes in adopted draft items [{ role, heading, text, cites }]: an item already taken (same role and text) is not added twice. Returns { rec, added }. */
export function addAdopted(rec, items) {
  const next = clone(rec);
  let added = 0;
  for (const it of Array.isArray(items) ? items : []) {
    if (!isObj(it) || !hasRole(it.role)) continue;
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
  next.problems.push({ id, label: str(label, LIMITS.label), certainty: "", from: from === "ed" ? "ed" : "typed", added: next.course.today, assess: [], plan: [] });
  return { rec: next, id };
}

/** Removes a problem.  Its id is not used again.  Carried items that pointed at it go back to "not decided". */
export function removeProblem(rec, id) {
  const next = clone(rec);
  next.problems = next.problems.filter((p) => p.id !== id);
  for (const a of next.ed.adopted) {
    if (a.to === id) {
      a.to = "";
      delete a.entry;
    }
    if (a.made === id) delete a.made;
  }
  for (const k of next.course.tasks) if (k.problem === id) delete k.problem;
  for (const d of next.course.days) delete d.trend[id];
  dropEmptyDays(next);
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
  if ("label" in patch) {
    const label = str(patch.label, LIMITS.label);
    if (label !== p.label) {
      // once the doctor changes the words, they are the doctor's (the AI mark and its citations no longer apply)
      delete p.ai;
      delete p.cites;
    }
    p.label = label;
  }
  if ("dx" in patch) {
    // the doctor's designation of the diagnosis for the discharge summary (主病名 / 副病名); blank when not designated
    if (patch.dx === "main" || patch.dx === "sub") p.dx = patch.dx;
    else delete p.dx;
  }
  if ("certainty" in patch) {
    const c = CERT_IDS.has(patch.certainty) ? patch.certainty : "";
    // the certainty is a judgement with a history: what it was on each day stays (a note for an earlier day does not show a later one).
    // A record made before the log existed starts its log from the certainty it had (from the day the problem was added).
    if (c !== p.certainty) p.cert_log = stampLog(p.cert_log, { today: next.course.today, added: p.added ?? 1, item: { certainty: c }, seed: p.certainty ? [{ day: p.added ?? 1, certainty: p.certainty }] : [] });
    p.certainty = c;
  }
  return next;
}

/**
 * Leaves a book's page for a problem (the doctor's act: a search result chosen, or a page the doctor typed in).  `ref`: { title, page, section? }.
 * The same page is not added twice (also when an adopted item already cites it); a problem keeps at most LIMITS.refs.
 * Returns { rec, ok, reason }: reason is "bad" (no title or page), "duplicate", "full" or "missing" (no such problem) when ok is false.
 */
export function pinRef(rec, problemId, ref) {
  const next = clone(rec);
  const p = findProblem(next, problemId);
  if (!p) return { rec, ok: false, reason: "missing" };
  const title = str(cleanTitle(ref?.title), LIMITS.cite);
  const page = str(ref?.page, LIMITS.page);
  if (!title || !page) return { rec, ok: false, reason: "bad" };
  if (refsOf(p).some((x) => refKey(x) === refKey({ title, page }))) return { rec, ok: false, reason: "duplicate" };
  if ((p.refs ?? []).length >= LIMITS.refs) return { rec, ok: false, reason: "full" };
  const section = str(ref?.section, LIMITS.section);
  (p.refs ??= []).push({ title, page, ...(section ? { section } : {}), via: "found", added: next.course.today });
  return { rec: next, ok: true, reason: "" };
}

/** Takes back a page the doctor left for a problem (by its key).  A page that an adopted item cites goes with that item, not from here. */
export function unpinRef(rec, problemId, key) {
  const next = clone(rec);
  const p = findProblem(next, problemId);
  if (!p?.refs) return next;
  p.refs = p.refs.filter((r) => refKey(r) !== key);
  if (!p.refs.length) delete p.refs;
  return next;
}

const listOf = (p, which) => (which === "plan" ? p.plan : p.assess);

/** Adds an entry the doctor typed to a problem's `assess` or `plan` list.  A plan entry starts as "planned". */
export function addEntry(rec, problemId, which, text = "") {
  const next = clone(rec);
  const p = findProblem(next, problemId);
  if (!p || listOf(p, which).length >= LIMITS.entries) return { rec: next, id: null };
  const id = nextId(next, "i");
  const e = { id, text: str(text, LIMITS.text), from: "typed", added: next.course.today };
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
    const was = e.state ?? "planned";
    const why = e.reason ?? "";
    if ("state" in patch && STATE_IDS.has(patch.state)) e.state = patch.state;
    if ("reason" in patch) {
      const r = str(patch.reason, LIMITS.reason);
      if (r) e.reason = r;
      else delete e.reason;
    }
    // what the doctor recorded about the plan (done, changed, stopped, why) is logged with the day: the notes of earlier days do not show it
    if ((e.state ?? "planned") !== was || (e.reason ?? "") !== why) {
      const seed = was !== "planned" || why ? [{ day: e.added ?? 1, state: was, ...(why ? { reason: why } : {}) }] : []; // a record made before the log existed
      e.log = stampLog(e.log, { today: next.course.today, added: e.added ?? 1, item: { state: e.state ?? "planned", ...(e.reason ? { reason: e.reason } : {}) }, seed });
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
/** A problem's name from an item's text: one line, cut to the limit with "…" so the cut is visible. */
const clipLabel = (text) => {
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > LIMITS.label ? `${t.slice(0, LIMITS.label - 1)}…` : t;
};

/** Where an entry is now: { list, entry } over the problems' lists and the criteria to call, or null. */
function locate(rec, entryId) {
  if (!entryId) return null;
  for (const list of [...rec.problems.flatMap((p) => [p.assess, p.plan]), rec.contingency]) {
    const entry = list.find((e) => e.id === entryId);
    if (entry) return { list, entry };
  }
  return null;
}

/** True when the doctor changed the entry an adopted item made (its words, a plan state, a reason): taking it back would lose that. */
export function entryModified(rec, adoptedId) {
  const a = rec.ed.adopted.find((x) => x.id === adoptedId);
  const at = a && locate(rec, a.entry);
  if (!at) return false;
  return at.entry.text !== a.text || (at.entry.state ?? "planned") !== "planned" || !!at.entry.reason;
}

/**
 * Carries one adopted item: target = a problem id, "new" (a new problem; only for an item of the problem list), "outlook" (only for
 * criteria to call or consult), "none" (not carried: decided) or "" (back to not decided).
 * The carried entry keeps its AI origin (`from: "ai"`) and its citations; a plan item arrives as "planned".
 * Choosing again MOVES the entry (what the doctor changed in it goes with it); only "", "none" and "new" take it back.
 * A problem that "new" made, and that the doctor has not touched, goes when the item is taken back.  Returns { rec, ok }.
 */
export function attach(rec, adoptedId, target) {
  const next = clone(rec);
  const a = next.ed.adopted.find((x) => x.id === adoptedId);
  if (!a) return { rec, ok: false };
  const isPlan = a.role === "plan";
  const fits =
    target === "" || target === "none" ||
    (target === "new" && a.role === "problems") ||
    (target === "outlook" && a.role === "contingency") ||
    (target !== "new" && target !== "outlook" && next.problems.some((p) => p.id === target));
  if (!fits) return { rec, ok: false };
  if (target === a.to) return { rec: next, ok: true }; // the same choice again changes nothing

  // take the entry out of where it is now (it is kept, to be moved)
  const at = locate(next, a.entry);
  let moved = null;
  if (at) {
    at.list.splice(at.list.indexOf(at.entry), 1);
    moved = at.entry;
  }
  delete a.entry;
  const made = a.made ? next.problems.find((p) => p.id === a.made) : null;
  a.to = "";

  const mk = (plan) => {
    const e = { id: nextId(next, "i"), text: a.text, from: "ai", added: next.course.today };
    if (a.cites?.length) e.cites = clone(a.cites);
    if (plan) e.state = "planned";
    return e;
  };
  const place = (list, plan) => {
    if (list.length >= LIMITS.entries) return false;
    const e = moved ?? mk(plan);
    if (!plan) delete e.state; // an assessment has no state
    else e.state ??= "planned";
    list.push(e);
    a.entry = e.id;
    return true;
  };
  const dropMade = () => {
    // a problem this item made, left as it was made, goes with the item; one the doctor has worked on stays
    if (made && made.label === clipLabel(a.text) && made.ai && !made.assess.length && !made.plan.length) {
      next.problems = next.problems.filter((p) => p.id !== made.id);
      delete a.made;
    }
  };

  if (target === "" || target === "none") {
    dropMade();
    a.to = target;
    return { rec: next, ok: true };
  }
  if (target === "new") {
    // one problem per item: choosing "new" again while the problem it made is still there points at it
    if (made) {
      a.to = made.id;
      return { rec: next, ok: true };
    }
    const made2 = addProblem(next, "", "ed");
    if (!made2.id) return { rec, ok: false };
    Object.assign(next, made2.rec);
    const na = next.ed.adopted.find((x) => x.id === adoptedId);
    const p = next.problems.find((x) => x.id === made2.id);
    p.label = clipLabel(a.text);
    p.ai = true;
    if (a.cites?.length) p.cites = clone(a.cites);
    na.to = p.id;
    na.made = p.id;
    return { rec: next, ok: true };
  }
  if (target === "outlook") {
    dropMade();
    if (!place(next.contingency, false)) return { rec, ok: false };
    a.to = "outlook";
    return { rec: next, ok: true };
  }
  const p = next.problems.find((x) => x.id === target);
  if (!place(isPlan ? p.plan : p.assess, isPlan)) return { rec, ok: false };
  if (made && made.id !== p.id) dropMade();
  a.to = p.id;
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
 * the flow's own origin (the arrival).  A clock time has no date, so a time the order of the clock contradicts is a reading, not a fact:
 * a time earlier than the arrival is read as the next day (it is something done in the emergency room), and a "when it began" time
 * (PRE_ARRIVAL) later than the arrival as the day before.  Such rows say so (`assumed`), and the doctor can flip the reading
 * (`reading`: { questionId: "after" | "before" }).  No judgement of how long anything took; the observations hung on a time (the
 * bridge's `at`) are listed under it as typed.
 * Returns { origin: { label, time } | null, originMissing, rows: [{ id, time, label, min, reading, assumed, isOrigin, details }] }.
 */
export function timeline(flow, answers, kase, reading = {}) {
  const ctx = contextOf(answers, kase);
  const originQ = flow.origin?.q;
  const originTime = originQ && minutesOf(answers[originQ]) !== null ? answers[originQ] : null;
  const rows = [];
  flow.questions.forEach((q, order) => {
    if (q.type !== "time" || minutesOf(answers[q.id]) === null || !isVisible(flow, q, ctx)) return;
    const time = answers[q.id];
    let min = null;
    let read = "after";
    let assumed = false;
    if (originTime && q.id !== originQ) {
      const delta = minutesOf(time) - minutesOf(originTime);
      const pre = PRE_ARRIVAL.has(q.id);
      // the default reading of the question; ambiguous when the clock says the opposite
      const dflt = pre ? "before" : "after";
      read = READINGS.has(reading[q.id]) ? reading[q.id] : dflt;
      assumed = pre ? delta > 0 : delta < 0;
      if (read === "after") min = delta < 0 ? delta + 1440 : delta;
      else min = delta > 0 ? delta - 1440 : delta;
    } else if (originTime) min = 0;
    rows.push({ id: q.id, time, label: timeLabel(q), min, reading: read, assumed, isOrigin: q.id === originQ, details: flow.questions.filter((x) => x.br?.at === q.id && isAnswered(answers[x.id]) && isVisible(flow, x, ctx)).map((x) => lineText(x, answers[x.id])), order });
  });
  rows.sort((a, b) => (a.min ?? minutesOf(a.time)) - (b.min ?? minutesOf(b.time)) || a.order - b.order);
  return { origin: originTime ? { label: flow.origin.label, time: originTime } : null, originMissing: !!originQ && !originTime, rows: rows.map(({ order, ...r }) => r) };
}

/** Sets how an ambiguous clock time is read ("after" the arrival or "before" it); "" goes back to the default reading. */
export function setReading(rec, questionId, value) {
  const next = clone(rec);
  if (!QID.test(String(questionId))) return next;
  if (READINGS.has(value)) {
    if (!(questionId in next.ed.reading) && Object.keys(next.ed.reading).length >= LIMITS.reading) return next;
    next.ed.reading[questionId] = value;
  } else delete next.ed.reading[questionId];
  return next;
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
  // the admission note has no trend line (a trend belongs to the course notes, which build their own problems)
  problems: rec.problems.map(({ trend, ...p }) => ({ ...clone(p), certaintyLabel: CERTAINTY.find((c) => c.id === p.certainty)?.label ?? "" })),
});

/** The admission note (A05) as assemble() builds it: the case as typed, and the board.  Adopted items reach it only through the board. */
export function admissionNote(rec) {
  const r = asOf(relativizeRecord(rec).rec, 1); // what is shown has no calendar date even before the next save, and nothing later than the admission day
  return assemble("A05", { kase: r.ed.case, items: [], board: boardOf(r) });
}

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
    if (wait.length) add("waiting", `「結果待ち」または「未実施」を選んだ項目が ${wait.length} 件（どちらかは区別していません）`, wait.map((x) => x.label));
    const guessed = timeline(fa.flow, fa.answers, rec.ed.case, rec.ed.reading).rows.filter((r) => r.assumed);
    if (guessed.length) add("assumed_times", `時刻だけでは決められず、仮の読み方をした時刻が ${guessed.length} 件（時間軸で読み方を選べます）`, guessed.map((r) => r.label));
  }
  const undecided = rec.ed.adopted.filter((a) => !a.to);
  if (undecided.length) add("undecided", `救急で採用した項目のうち、入院時へ持ってくるか決めていないものが ${undecided.length} 件`, undecided.map((a) => `${ROLE_LABEL[a.role] ?? a.role}: ${a.text.slice(0, 30)}`));
  const unnamed = rec.problems.filter((p) => !p.label);
  if (unnamed.length) add("unnamed", `名前のない問題が ${unnamed.length} 件（評価・計画のある問題は、記載には「（名前なし）」として入ります）`, []);
  const noCert = rec.problems.filter((p) => p.label && !p.certainty);
  if (noCert.length) add("no_certainty", `診断の確度を選んでいない問題が ${noCert.length} 件`, noCert.map((p) => p.label));
  const noAssess = rec.problems.filter((p) => p.label && !p.assess.length);
  if (noAssess.length) add("no_assessment", `評価を書いていない問題が ${noAssess.length} 件`, noAssess.map((p) => p.label));
  const noPlan = rec.problems.filter((p) => p.label && !p.plan.length);
  if (noPlan.length) add("no_plan", `計画を書いていない問題が ${noPlan.length} 件`, noPlan.map((p) => p.label));
  if (!rec.problems.length) add("no_problems", "問題がまだありません（入院時の記載の「Problem List」は未入力になります）");
  out.push(...courseChecks(rec)); // what the course leaves blank or undecided on the working day (case-course.js)
  const size = JSON.stringify(rec).length;
  if (size >= RECORD_BUDGET * 0.7) add("size", `この記録の大きさは、保存できる上限の ${Math.round((size / RECORD_BUDGET) * 100)}% です（上限を超えると保存できません。古い日の記録や、使わない課題・処方を消すと小さくなります）`);
  const note = admissionNote(rec);
  if (note.unfilled.length) add("unfilled", `入院時の記載の必須欄が「（未入力）」のまま: ${note.unfilled.length} 個`, note.sections.filter((s) => s.empty && s.requirement === "required").map((s) => s.label));
  return out;
}
