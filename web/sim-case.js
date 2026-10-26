// The setting of a simulated fictional case (docs/enhancement-plan.md 8.21, step 1a): the hidden truth the engine (sim-engine.js) plays back, and
// the checks it must pass before it is frozen.  Pure functions over a setting and the imported flow (web/flow-schema.js): no DOM, no network,
// no storage, no clock, no random, no AI.  A twin for the Worker (the AI writes the setting once, step 2) comes with that step; the shared
// vectors are tests/vectors/simcase.json.
//
// A setting is JSON made of arrays only (a structured-output schema cannot hold a dictionary with open keys):
//   { v: 1, flow, schema, patient: {age, sex}, clock?: {start: "HH:MM"},
//     opening: [{who, text}],
//     states: [{id, facts: [{q, v, who, how}], event?: {who, text}}],        s0 first; every other state is s0's facts overlaid by its own
//     orders: [{order: "q=option", results: [q, ...]}],                      an order of the flow's action question and the result questions it returns
//     moves: [{from, to, if_done?, if_not_done?, at, basis: [sectionId]}],   at: "next" | "enter:<stage id>"; the first listed move that holds wins
//     assumed: {dx: [..], ddx: [..], key: [..], pitfall, lesson} }           the author's assumption (AI made, not confirmed by the doctor): never called "the answer"
//
// What a setting must not hold (each is an error code below):
//  - a value for the doctor's reading or act (a question whose entity is assessment / reason / none / action, or one named in `opts.readings`):
//    the case returns raw data and the doctor chooses the reading;
//  - a change of the background (entity context) after s0, a value in s0 that only makes sense after an action, a fact for a time question;
//  - a diagnosis word of `assumed.dx` in the opening, an event or a text value; an evaluation word, a date, a dose, a threshold, or something
//    that looks like an identifier, in any text;
//  - a state that cannot be reached, a state that waits for an action with no natural way out, a move after an act without a book section.
import { scanCreated } from "./case-create.js";
import { cleanAnswers, contextOf, isAnswered, isVisible } from "./intake.js";

export const SIM_VERSION = 1;
/** The four stages of the emergency course (the doctor's chart skill §2.7).  The doctor moves from one to the next. */
export const STAGES = [
  { id: "stabilize", label: "初期評価・安定化" },
  { id: "workup", label: "原因検索" },
  { id: "reassess", label: "再評価・Disposition" },
  { id: "close", label: "締め括り" },
];
/** Design limits (about the size of a setting, not clinical numbers). */
export const LIMITS = { states: 6, moves: 8, orders: 8, facts: 120, opening: 6, text: 400, basis: 4, assumed: 6 };
/** Who gave the fact, and how it was got: the screen puts what an ambulance crew measured in S and what the hospital measured in O. */
export const WHO = ["患者", "家族", "救急隊", "看護師", "検査"];
export const HOW = ["問診", "診察", "測定", "救急隊の測定", "検査"];
/** Entities of questions the case may hold a value for. */
export const FACT_ENTS = ["observation", "context", "condition"];
/** Entities of questions that are the doctor's own reading or act: no value, ever. */
export const READING_ENTS = ["assessment", "reason", "none", "action"];

const TOP_KEYS = ["v", "flow", "schema", "patient", "clock", "opening", "states", "orders", "moves", "assumed"];
const EVAL_RE = /適切|不適切|正解|誤り|間違い|べき|見逃し|遅れ|遅い|不十分|妥当|望ましい|良い対応|悪い対応/;
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const str = (x) => typeof x === "string" && x.trim() !== "";

export const questionOf = (flow, id) => (flow.questions ?? []).find((q) => q.id === id);
export const optionIds = (q) => (q?.options ?? []).map((o) => o.id);
/** Is the question the doctor's reading or act?  `readings`: ids of observation questions the flow holds as the doctor's own reading. */
export const isReading = (q, readings) => !q || READING_ENTS.includes(q.br?.ent) || !!readings?.has(q.id);
/** The names a `when` condition reads (q=a,b / q? / ! & | ( ) / $name). */
export const whenRefs = (src) => [...String(src ?? "").matchAll(/(?<![$\w])([A-Za-z0-9_]+)(?=\?|=)/g)].map((m) => m[1]);

/** The facts of a state as the engine sees them: s0's facts, overlaid by the state's own.  { q: {v, who, how} } */
export function effectiveFacts(setting, stateId) {
  const out = {};
  const put = (st) => {
    for (const f of st?.facts ?? []) out[f.q] = { v: f.v, who: f.who, how: f.how };
  };
  const states = setting?.states ?? [];
  put(states[0]);
  if (stateId && stateId !== states[0]?.id) put(states.find((s) => s.id === stateId));
  return out;
}

/** The ids of the result questions of all orders. */
export const resultIds = (setting) => new Set((setting?.orders ?? []).flatMap((o) => (Array.isArray(o?.results) ? o.results : [])));

/**
 * Checks a setting against its flow.  Returns { ok, errors: [{code, where, msg}], inferred: [move index], missing: [question id] }.
 * opts: strict (default true: every visible question the case can answer needs a value), readings (Set), preArrival (Set of time question ids
 * the setting may hold: onset times, which the engine does not make), shortCircuit (stop at the first structural error; default true).
 */
export function validateSimCase(setting, flow, opts = {}) {
  const strict = opts.strict !== false;
  const readings = opts.readings ?? new Set();
  const preArrival = opts.preArrival ?? new Set();
  const errors = [];
  const err = (code, where, msg) => errors.push({ code, where, msg });
  const done = (extra = {}) => ({ ok: errors.length === 0, errors, inferred: [], missing: [], ...extra });

  if (!isObj(setting)) return err("shape", "", "設定がオブジェクトではありません"), done();
  for (const k of Object.keys(setting)) if (!TOP_KEYS.includes(k)) err("unknown_key", k, `知らない項目 ${k}`);
  if (setting.v !== SIM_VERSION) err("version", "v", `v は ${SIM_VERSION}`);
  if (setting.flow !== flow?.id) err("flow", "flow", "フローが合いません");
  for (const k of ["opening", "states", "orders", "moves"]) if (!Array.isArray(setting[k])) err("shape", k, `${k} は配列`);
  if (errors.length) return done();

  const { states, orders, moves, opening } = setting;
  if (states.length === 0 || states.length > LIMITS.states) err("limit", "states", `状態は1〜${LIMITS.states}`);
  if (moves.length > LIMITS.moves) err("limit", "moves", `遷移は${LIMITS.moves}まで`);
  if (orders.length > LIMITS.orders) err("limit", "orders", `オーダーは${LIMITS.orders}まで`);
  if (opening.length > LIMITS.opening) err("limit", "opening", `導入は${LIMITS.opening}まで`);
  if (errors.length) return done();

  // ---- patient and clock
  const age = setting.patient?.age;
  if (!Number.isInteger(age) || age < 0 || age > 130) err("patient", "patient.age", "年齢は0〜130の整数");
  if (!["男性", "女性", "その他・不明"].includes(setting.patient?.sex)) err("patient", "patient.sex", "性別は 男性／女性／その他・不明");
  if (setting.clock !== undefined && !(isObj(setting.clock) && /^([01]\d|2[0-3]):[0-5]\d$/.test(setting.clock.start))) err("clock", "clock", "clock.start は HH:MM");

  // ---- states and facts
  const ids = states.map((s) => s?.id);
  if (ids[0] !== "s0") err("states", "states[0]", "最初の状態は s0");
  if (new Set(ids).size !== ids.length || ids.some((i) => !/^s\d{1,2}$/.test(String(i)))) err("states", "states", "状態の id は s0, s1, … で重ならない");
  const texts = []; // [where, text, kind] every free text of the setting
  const noteText = (where, t, kind) => {
    if (!str(t)) return err("text", where, "文が空です");
    if (t.length > LIMITS.text) err("limit", where, `文は${LIMITS.text}字まで`);
    texts.push([where, t, kind]);
  };
  const resultQs = resultIds(setting);
  const seenS0 = new Set();
  states.forEach((st, i) => {
    const w = `states[${i}]`;
    if (!isObj(st) || !Array.isArray(st.facts)) return err("shape", w, "状態は {id, facts, event?}");
    for (const k of Object.keys(st)) if (!["id", "facts", "event"].includes(k)) err("unknown_key", `${w}.${k}`, `知らない項目 ${k}`);
    if (st.facts.length > LIMITS.facts) err("limit", `${w}.facts`, `事実は${LIMITS.facts}まで`);
    const seen = new Set();
    st.facts.forEach((f, j) => {
      const fw = `${w}.facts[${j}]`;
      if (!isObj(f)) return err("shape", fw, "事実は {q, v, who, how}");
      for (const k of Object.keys(f)) if (!["q", "v", "who", "how"].includes(k)) err("unknown_key", `${fw}.${k}`, `知らない項目 ${k}`);
      const q = questionOf(flow, f.q);
      if (!q) return err("unknown_q", fw, `質問 ${f.q} がフローにありません`);
      if (seen.has(f.q)) err("duplicate", fw, `同じ状態に ${f.q} が2つ`);
      seen.add(f.q);
      if (!WHO.includes(f.who)) err("who", fw, `who は ${WHO.join("・")}`);
      if (!HOW.includes(f.how)) err("how", fw, `how は ${HOW.join("・")}`);
      const ent = q.br?.ent;
      if (isReading(q, readings)) return err("reading_value", fw, `${f.q} は先生の読み・行為の質問です。値を持たせません`);
      if (ent === "time") {
        if (!preArrival.has(f.q)) err("time_fact", fw, `${f.q} は時刻の質問です。設定は持ちません`);
      } else if (!FACT_ENTS.includes(ent)) err("reading_value", fw, `${f.q} は事実の質問ではありません`);
      if (ent === "context" && i > 0) err("background_changes", fw, `${f.q} は背景です。s0 のあとで変えません`);
      if (i === 0) seenS0.add(f.q);
      // the value must be one the question takes
      const cleaned = cleanAnswers(flow, { [f.q]: f.v });
      const same = JSON.stringify(cleaned.answers[f.q]) === JSON.stringify(typeof f.v === "string" && q.type === "text" ? f.v.trim().slice(0, 600) : f.v);
      if (cleaned.dropped || !same) err("bad_value", fw, `${f.q} の値がこの質問の受け付ける形ではありません`);
      if (q.type === "text" && str(f.v)) noteText(`${fw}.v`, f.v, "fact");
      // a value that only makes sense after an act belongs to the state the act leads to, not to s0 (a result of an order is not that)
      if (i === 0 && !resultQs.has(f.q) && whenRefs(q.when).some((r) => questionOf(flow, r)?.br?.ent === "action")) {
        err("after_action_in_s0", fw, `${f.q} は行為のあとにだけ意味があります。s0 に置きません`);
      }
    });
    if (st.event !== undefined) {
      if (!isObj(st.event) || !WHO.includes(st.event.who)) err("event", `${w}.event`, `event は {who, text}`);
      else noteText(`${w}.event.text`, st.event.text, "event");
    }
  });
  opening.forEach((o, i) => {
    if (!isObj(o) || !WHO.includes(o.who)) return err("opening", `opening[${i}]`, "導入は {who, text}");
    noteText(`opening[${i}].text`, o.text, "opening");
  });

  // ---- orders
  orders.forEach((o, i) => {
    const w = `orders[${i}]`;
    const m = /^([A-Za-z0-9_]+)=([A-Za-z0-9_]+)$/.exec(String(o?.order));
    const q = m && questionOf(flow, m[1]);
    if (!q || q.br?.ent !== "action" || !optionIds(q).includes(m[2])) return err("order", w, "order は、フローの行為の質問と選択肢（q=選択肢）");
    if (!Array.isArray(o.results) || o.results.length === 0) return err("order", w, "results が空です");
    for (const r of o.results) {
      const rq = questionOf(flow, r);
      if (!rq || !FACT_ENTS.includes(rq.br?.ent) || isReading(rq, readings)) err("order", w, `結果の質問 ${r} は事実の質問にします`);
    }
  });

  // ---- moves
  const stageIds = STAGES.map((s) => s.id);
  const inferred = [];
  const actionKeys = new Set(
    (flow.questions ?? []).filter((q) => q.br?.ent === "action").flatMap((q) => optionIds(q).map((o) => `${q.id}=${o}`)),
  );
  moves.forEach((mv, i) => {
    const w = `moves[${i}]`;
    if (!isObj(mv)) return err("move", w, "遷移はオブジェクト");
    for (const k of Object.keys(mv)) if (!["from", "to", "if_done", "if_not_done", "at", "basis"].includes(k)) err("unknown_key", `${w}.${k}`, `知らない項目 ${k}`);
    if (!ids.includes(mv.from) || !ids.includes(mv.to) || mv.from === mv.to) err("move", w, "from と to は、別々の既存の状態");
    if (mv.at !== "next" && !(typeof mv.at === "string" && mv.at.startsWith("enter:") && stageIds.includes(mv.at.slice(6)))) err("move", w, 'at は "next" か "enter:<段>"');
    for (const k of ["if_done", "if_not_done"]) {
      if (mv[k] !== undefined && !(actionKeys.has(mv[k]) || (orders ?? []).some((o) => o.order === mv[k]))) err("move", `${w}.${k}`, `${mv[k]} はフローの行為（q=選択肢）ではありません`);
    }
    if (mv.if_done !== undefined && mv.if_not_done !== undefined) err("move", w, "if_done と if_not_done は同時に書きません");
    const basis = Array.isArray(mv.basis) ? mv.basis : null;
    if (!basis || basis.length > LIMITS.basis || basis.some((b) => !str(b))) err("basis", `${w}.basis`, `basis は節の id の配列（${LIMITS.basis}まで。なければ空）`);
    else if (mv.if_done !== undefined && basis.length === 0) err("basis_missing", w, "行為で分かれる遷移は、書籍の節（basis）が要ります");
    else if (basis.length === 0) inferred.push(i);
  });

  // ---- reachability, and a way out without any act
  if (!errors.some((e) => e.code === "move" || e.code === "states")) {
    const reach = new Set(["s0"]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const mv of moves) if (reach.has(mv.from) && !reach.has(mv.to)) (reach.add(mv.to), (grew = true));
    }
    for (const id of ids) if (!reach.has(id)) err("unreachable", id, `状態 ${id} に s0 から届きません`);
    for (const id of ids) {
      const out = moves.filter((m) => m.from === id);
      if (out.length && !out.some((m) => m.if_done === undefined)) err("no_natural_move", id, `状態 ${id} は行為がないと進めません。自然経過の遷移が1つ要ります`);
    }
  }

  // ---- texts: identifiers, dates, doses, thresholds, evaluation words, the diagnosis
  const dx = Array.isArray(setting.assumed?.dx) ? setting.assumed.dx.filter((w) => str(w) && w.trim().length >= 2).map((w) => w.trim()) : [];
  if (!isObj(setting.assumed)) err("assumed", "assumed", "assumed（設定の想定）が要ります");
  else {
    for (const k of ["dx", "ddx", "key"]) if (!Array.isArray(setting.assumed[k]) || setting.assumed[k].length > LIMITS.assumed || !setting.assumed[k].every(str)) err("assumed", `assumed.${k}`, `${k} は文の配列（${LIMITS.assumed}まで）`);
    for (const k of ["pitfall", "lesson"]) if (!str(setting.assumed[k]) || setting.assumed[k].length > LIMITS.text) err("assumed", `assumed.${k}`, `${k} は文（${LIMITS.text}字まで）`);
    for (const k of ["dx", "ddx", "key"]) for (const t of Array.isArray(setting.assumed[k]) ? setting.assumed[k] : []) if (str(t)) texts.push([`assumed.${k}`, t, "assumed"]);
    for (const k of ["pitfall", "lesson"]) if (str(setting.assumed[k])) texts.push([`assumed.${k}`, setting.assumed[k], "assumed"]);
  }
  for (const [where, t, kind] of texts) {
    const hit = scanCreated(t);
    if (hit.ids.length) err("identifier", where, "識別情報らしい文字があります");
    if (hit.dates.length) err("date", where, "日付らしい文字があります");
    if (hit.doses.length) err("dose", where, "用量らしい数値があります");
    if (hit.thresholds.length) err("threshold", where, "閾値らしい比較があります");
    if (kind !== "assumed" && EVAL_RE.test(t)) err("eval_word", where, "評価の語があります");
    if (kind !== "assumed" && dx.some((w) => t.includes(w))) err("leak_dx", where, "診断名が、導入・出来事・答えに出ています");
  }

  // ---- coverage: every visible question the case can answer has a value, so which items the author thought important is not told by a reply
  const missing = [];
  if (strict && !errors.some((e) => e.code === "shape" || e.code === "states" || e.code === "unknown_q")) {
    for (const st of states) {
      const facts = effectiveFacts(setting, st.id);
      const answers = Object.fromEntries(Object.entries(facts).map(([q, f]) => [q, f.v]));
      const ctx = contextOf(answers, { sex: setting.patient?.sex });
      for (const q of flow.questions ?? []) {
        const ent = q.br?.ent;
        if (!FACT_ENTS.includes(ent) || isReading(q, readings) || ["age", "sex"].includes(q.id)) continue;
        if (!isVisible(flow, q, ctx) && !resultQs.has(q.id)) continue;
        if (!(q.id in facts) && !isAnswered(facts[q.id]?.v) && !missing.includes(q.id)) missing.push(q.id);
      }
    }
    for (const q of missing) err("coverage", q, `${q} に値がありません`);
  }
  return done({ inferred, missing });
}
