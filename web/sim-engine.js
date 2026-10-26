// Plays a simulated fictional case back from its setting (web/sim-case.js) and the doctor's acts (docs/enhancement-plan.md 8.21, step 1a).
// A pure fold: replay(setting, flow, log) -> what the doctor has been told so far.  No DOM, no network, no storage, no clock, no random, no AI:
// the same setting and the same log always give the same records, and the records of a shorter log are the start of the records of a longer one.
//
// The log is a list of the doctor's acts (the engine never invents one):
//   { act: "ask", q }                     ask / examine / measure an item the case can answer
//   { act: "do", key: "q=option" }        record an act of the flow's action question (an order, a treatment); an order the setting lists returns
//                                         its results at the next boundary, with the values of the state it was ordered in
//   { act: "say", type, text }            explanation | consult | disposition, in the doctor's own words (kept as written)
//   { act: "wait" }                       a boundary (a segment of time passes)
//   { act: "stage", to }                  a boundary that also enters the next stage (stabilize -> workup -> reassess -> close)
// Time moves only at a boundary ("wait", "stage").  Asking and examining take no time, so the careful doctor is not the one who loses.  A move of
// the setting is looked at at a boundary only: the first move of the current state that holds is taken (one per boundary).
//
// What is told: a fact the case holds, the doctor's reading or act never (a refusal), an item the setting does not hold ("nodata", never a
// normal and never a negative).  An item asked again answers with the value of the state the case is in now, as a new record: an earlier
// record is never rewritten.  The state id and the setting's assumption are in `internal`, never in `records`.
import { STAGES, effectiveFacts, isReading, questionOf, resultIds } from "./sim-case.js";
import { contextOf, isVisible } from "./intake.js";

export const SAY_TYPES = ["explain", "consult", "disposition"];
export const SAY_LIMIT = 400;
export const NO_DATA = "その項目は、この症例に設定がありません（未確認のまま。陰性ではありません）。";

/** "HH:MM" of segment `t` when the setting has a clock and one segment is `minutesPerSegment` minutes (shown only: it never moves the case). */
export function clockAt(setting, t, minutesPerSegment) {
  const m = /^(\d{2}):(\d{2})$/.exec(setting?.clock?.start ?? "");
  if (!m || !Number.isInteger(minutesPerSegment) || minutesPerSegment < 0) return "";
  const total = (Number(m[1]) * 60 + Number(m[2]) + t * minutesPerSegment) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * replay(setting, flow, log, { readings }) -> { records, t, stage, pending, internal: { state } }
 * records: [{ seq, t, kind, … }] in the order they happened; seq is the number of the act (1-based) that made the record.
 *  answer  { q, value, who, how }       nodata { q }          refused { act, reason }
 *  do      { key }                      result { key, items: [{ q, value, who, how } | { q, nodata: true }] }
 *  event   { who, text }                say    { type, text }  boundary { to? }  (every "wait" and "stage": the time passes)
 * refusal reasons: act | unknown_q | not_a_fact | reading | hidden | not_ready | unknown_key | bad_say | bad_stage | stage_back
 */
export function replay(setting, flow, log, opts = {}) {
  const readings = opts.readings ?? new Set();
  const records = [];
  const resultQs = resultIds(setting);
  const orderKeys = new Set((setting.orders ?? []).map((o) => o.order));
  const results = Object.fromEntries((setting.orders ?? []).map((o) => [o.order, o.results]));
  const delivered = {}; // result question -> {v, who, how} as it was when the order was made
  const done = {}; // the doctor's acts as answers of the action questions: { q: [option, …] }
  const doneKeys = new Set();
  let pending = []; // orders waiting for the next boundary: { key, state }
  let state = "s0";
  let t = 0;
  let stageIdx = 0;
  let seq = 0;
  const push = (r) => records.push({ seq, t, ...r });
  const refuse = (act, reason) => push({ kind: "refused", act, reason });
  const ctx = () => {
    const answers = Object.fromEntries(Object.entries(effectiveFacts(setting, state)).map(([q, f]) => [q, f.v]));
    for (const [q, opts_] of Object.entries(done)) answers[q] = questionOf(flow, q)?.type === "multi" ? [...opts_] : opts_[opts_.length - 1];
    return contextOf(answers, { sex: setting.patient?.sex });
  };
  const factOf = (facts, q) => (q in facts ? { value: facts[q].v, who: facts[q].who, how: facts[q].how } : null);

  const boundary = (toStage) => {
    t += 1;
    push({ kind: "boundary", ...(toStage ? { to: toStage } : {}) });
    for (const p of pending) {
      const facts = effectiveFacts(setting, p.state);
      const items = (results[p.key] ?? []).map((q) => {
        const f = factOf(facts, q);
        if (f) delivered[q] = facts[q];
        return f ? { q, ...f } : { q, nodata: true };
      });
      push({ kind: "result", key: p.key, items });
    }
    pending = [];
    const holds = (m) => (m.if_done !== undefined ? doneKeys.has(m.if_done) : m.if_not_done !== undefined ? !doneKeys.has(m.if_not_done) : true);
    const move = (setting.moves ?? []).find((m) => m.from === state && (m.at === "next" || (toStage && m.at === `enter:${toStage}`)) && holds(m));
    if (move) {
      state = move.to;
      const ev = (setting.states ?? []).find((s) => s.id === state)?.event;
      if (ev) push({ kind: "event", who: ev.who, text: ev.text });
    }
  };

  (Array.isArray(log) ? log : []).forEach((act, i) => {
    seq = i + 1;
    const name = typeof act?.act === "string" ? act.act : "";
    if (name === "ask") {
      const q = questionOf(flow, act.q);
      if (!q) return refuse(name, "unknown_q");
      if (isReading(q, readings)) return refuse(name, "reading");
      if (!["observation", "context", "condition"].includes(q.br?.ent)) return refuse(name, "not_a_fact");
      if (!isVisible(flow, q, ctx())) return refuse(name, "hidden");
      if (resultQs.has(q.id)) {
        const f = delivered[q.id];
        return f ? push({ kind: "answer", q: q.id, value: f.v, who: f.who, how: f.how }) : refuse(name, "not_ready");
      }
      const f = factOf(effectiveFacts(setting, state), q.id);
      return f ? push({ kind: "answer", q: q.id, ...f }) : push({ kind: "nodata", q: q.id });
    }
    if (name === "do") {
      const m = /^([A-Za-z0-9_]+)=([A-Za-z0-9_]+)$/.exec(String(act.key));
      const q = m && questionOf(flow, m[1]);
      if (!q || q.br?.ent !== "action" || !(q.options ?? []).some((o) => o.id === m[2])) return refuse(name, "unknown_key");
      push({ kind: "do", key: act.key });
      (done[q.id] ??= []).push(m[2]);
      doneKeys.add(act.key);
      if (orderKeys.has(act.key)) pending.push({ key: act.key, state });
      return;
    }
    if (name === "say") {
      const text = typeof act.text === "string" ? act.text.trim() : "";
      if (!SAY_TYPES.includes(act.type) || !text || text.length > SAY_LIMIT) return refuse(name, "bad_say");
      return push({ kind: "say", type: act.type, text });
    }
    if (name === "wait") {
      boundary(null);
      return;
    }
    if (name === "stage") {
      const to = STAGES.findIndex((s) => s.id === act.to);
      if (to < 0) return refuse(name, "bad_stage");
      if (to <= stageIdx) return refuse(name, "stage_back");
      stageIdx = to;
      boundary(act.to);
      return;
    }
    refuse(name || "?", "act");
  });
  return {
    records,
    t,
    stage: STAGES[stageIdx].id,
    pending: pending.map((p) => p.key),
    internal: { state },
  };
}
