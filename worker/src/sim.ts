// The simulation of a fictional case, step 2 (docs/enhancement-plan.md 8.21; the doctor's decisions D4 c, D3 c, D7, D8 a of 2026-10-26).
// /api/sim asks the AI for the hidden setting of an emergency case (op "author"), for what happens over the next segment of time after the
// doctor's acts (op "next"), for values of items the state has none for yet (op "fill"), for the next acts as an example (op "suggest", and
// with author / next: D10, always shown, taken only when the doctor picks one), and for an S/O/A/P draft of what the doctor has been told
// (op "soap": D12; it is given what the screen showed the doctor, never the hidden setting).  The AI writes values of the flow's questions
// only; this file checks their shape against the flow's catalog (sim-catalog.ts) and drops what does not fit, and the screen runs the full
// check of a setting (web/sim-case.js) before anything is used.
//
// Nothing is kept: the request and the answer are not stored or logged.  The books are used as grounds the AI names by section id; text the
// AI copied from them (MIN_OVERLAP characters in a row) is reported, and the screen does not use such an answer.  The call counts against the
// daily cap like /api/ask (D8 a) and is not counted in the daily answer counts (F4; D7).
import { postMessages, messageText, ExtractUpstreamError, type ExtractDeps } from "./extract.ts";
import { findOverlaps, type OverlapFinding } from "./overlap.ts";
import { SIM_AUTHOR_RULES, SIM_FILL_RULES, SIM_NEXT_RULES, SIM_RULES, SIM_SOAP_RULES, SIM_SUGGEST_RULES } from "./prompt.ts";
import { SIM_CATALOG, SIM_CATALOG_SOURCE, type SimFlow, type SimQuestion } from "./sim-catalog.ts";
import type { Db } from "./db.ts";
import { getParent, searchParents, type ParentResult } from "./search.ts";
import { pageLabel } from "./format.ts";

export const SIM_OPS = ["author", "next", "fill", "suggest", "soap"] as const;
export type SimOp = (typeof SIM_OPS)[number];
/** Twins of web/sim-model.js LEVELS / THEME_LIMIT and web/sim-case.js WHO / HOW / STAGES (pinned equal by worker/test/simapi.test.ts). */
export const LEVELS = ["易", "標準", "難"];
export const THEME_LIMIT = 200;
export const WHO = ["患者", "家族", "救急隊", "看護師", "検査"];
export const HOW = ["問診", "診察", "測定", "救急隊の測定", "検査"];
export const SEXES = ["男性", "女性", "その他・不明"];
export const STAGES: [string, string][] = [
  ["stabilize", "初期評価・安定化"],
  ["workup", "原因検索"],
  ["reassess", "再評価・Disposition"],
  ["close", "締め括り"],
];
const SAY_LABELS: Record<string, string> = { explain: "説明", consult: "相談", disposition: "行き先" };
/** Bounds of a request (about size, not clinical numbers). */
export const SIM_LIMITS = { log: 400, setting: 300_000, fill: 20, sources: 12, errors: 40, text: 400, books: 6, bookChars: 1500, assumed: 6, suggest: 5, why: 200, told: 300, answers: 6000, own: 2000, soapItems: 20 };
/** The kinds of a plan item of the S/O/A/P draft (the chart skill's P: Dx / Tx / Ex). */
export const PLAN_KINDS = ["Dx", "Tx", "Ex"];

export class SimInputError extends Error {
  code: string;
  status: number;
  constructor(message: string, code = "bad_request", status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type SimAct = { act: "ask"; q: string } | { act: "do"; key: string } | { act: "say"; type: string; text: string } | { act: "wait" } | { act: "stage"; to: string };

export interface SimRequest {
  op: SimOp;
  flow: SimFlow;
  theme: string;
  level: string;
  repair: { setting: unknown; errors: { code: string; where: string; msg: string }[] } | null;
  setting: any;
  log: SimAct[];
  state: string;
  t: number;
  stage: string;
  qs: string[];
  sources: string[];
  /** op soap: what the screen showed the doctor (the memo's lines), the doctor's answers as text, the doctor's own A/P */
  told: string[];
  answers: string;
  own: string;
}

const isObj = (x: unknown): x is Record<string, any> => x !== null && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown, max: number): string => (typeof x === "string" ? x.trim().slice(0, max) : "");
const factIds = (flow: SimFlow) => flow.questions.filter((q) => q.kind === "fact").map((q) => q.id);
const qOf = (flow: SimFlow, id: string) => flow.questions.find((q) => q.id === id);
const actionKeys = (flow: SimFlow) => flow.questions.filter((q) => q.kind === "action").flatMap((q) => (q.options ?? []).map(([o]) => `${q.id}=${o}`));

function parseAct(a: unknown, flow: SimFlow): SimAct {
  const bad = () => new SimInputError("行為の記録の形が違います", "bad_log");
  if (!isObj(a)) throw bad();
  if (a.act === "ask" && typeof a.q === "string" && qOf(flow, a.q)) return { act: "ask", q: a.q };
  if (a.act === "do" && typeof a.key === "string" && actionKeys(flow).includes(a.key)) return { act: "do", key: a.key };
  if (a.act === "say" && typeof a.type === "string" && a.type in SAY_LABELS && typeof a.text === "string" && a.text.trim() && a.text.length <= SIM_LIMITS.text) return { act: "say", type: a.type, text: a.text.trim() };
  if (a.act === "wait") return { act: "wait" };
  if (a.act === "stage" && STAGES.some(([id]) => id === a.to)) return { act: "stage", to: a.to };
  throw bad();
}

/** Validates the body of /api/sim. */
export function parseSimRequest(body: unknown): SimRequest {
  const b = isObj(body) ? body : {};
  const op = SIM_OPS.find((o) => o === b.op);
  if (!op) throw new SimInputError("op は author・next・fill のどれか", "bad_op");
  const id = typeof b.flow === "string" ? b.flow : "";
  if (!Object.hasOwn(SIM_CATALOG, id)) throw new SimInputError("模擬できるのは救急外来のフローだけです", "unknown_flow");
  if (b.schema !== SIM_CATALOG_SOURCE.commit) throw new SimInputError("質問の定義の版が、画面とサーバーで違います。ページを読み込み直してください", "schema_changed", 409);
  const flow = SIM_CATALOG[id];
  const req: SimRequest = { op, flow, theme: "", level: "標準", repair: null, setting: null, log: [], state: "s0", t: 0, stage: STAGES[0][0], qs: [], sources: [], told: [], answers: "", own: "" };
  if (op === "soap") {
    // the draft is written from what the doctor saw and wrote, never from the hidden setting
    if (b.setting !== undefined) throw new SimInputError("S/O/A/P の草案には、隠れた設定を送りません", "setting_not_taken");
    if (!Array.isArray(b.told) || !b.told.length || b.told.length > SIM_LIMITS.told || !b.told.every((x: unknown) => typeof x === "string" && x.length <= SIM_LIMITS.text)) throw new SimInputError("経時メモの行がありません（または長すぎます）", "bad_told");
    req.told = (b.told as string[]).map((x) => x.trim()).filter(Boolean);
    if (typeof b.answers !== "string" || b.answers.length > SIM_LIMITS.answers) throw new SimInputError("答えの文が長すぎます", "bad_answers");
    req.answers = b.answers.trim();
    if (typeof b.own !== "string" || b.own.length > SIM_LIMITS.own) throw new SimInputError("自分の A/P が長すぎます", "bad_own");
    req.own = b.own.trim();
    return req;
  }
  if (op === "author") {
    req.theme = str(b.theme, THEME_LIMIT + 1);
    if (!req.theme) throw new SimInputError("テーマがありません", "empty");
    if (req.theme.length > THEME_LIMIT) throw new SimInputError(`テーマは ${THEME_LIMIT} 字までです`, "too_long");
    if (!LEVELS.includes(b.level)) throw new SimInputError(`難しさは ${LEVELS.join("・")} のどれか`, "bad_level");
    req.level = b.level;
    if (b.repair !== undefined && b.repair !== null) {
      const r = b.repair;
      if (!isObj(r) || !isObj(r.setting) || !Array.isArray(r.errors) || r.errors.length > SIM_LIMITS.errors) throw new SimInputError("repair の形が違います", "bad_repair");
      if (JSON.stringify(r.setting).length > SIM_LIMITS.setting) throw new SimInputError("設定が大きすぎます", "too_long");
      req.repair = { setting: r.setting, errors: r.errors.map((e: any) => ({ code: str(e?.code, 40), where: str(e?.where, 120), msg: str(e?.msg, 200) })) };
    }
    return req;
  }
  if (!isObj(b.setting) || b.setting.flow !== id) throw new SimInputError("設定がありません（またはフローが違います）", "bad_setting");
  if (JSON.stringify(b.setting).length > SIM_LIMITS.setting) throw new SimInputError("設定が大きすぎます", "too_long");
  req.setting = b.setting;
  if (!Array.isArray(b.log) || b.log.length > SIM_LIMITS.log) throw new SimInputError("行為の記録がありません（または長すぎます）", "bad_log");
  req.log = b.log.map((a: unknown) => parseAct(a, flow));
  if (typeof b.state !== "string" || !/^s\d{1,2}$/.test(b.state) || !(Array.isArray(b.setting.states) && b.setting.states.some((s: any) => s?.id === b.state))) throw new SimInputError("いまの状態が設定にありません", "bad_state");
  req.state = b.state;
  if (!Number.isInteger(b.t) || b.t < 0 || b.t > 999) throw new SimInputError("区切りの数が違います", "bad_t");
  req.t = b.t;
  if (!STAGES.some(([sid]) => sid === b.stage)) throw new SimInputError("段が違います", "bad_stage");
  req.stage = b.stage;
  const srcs = isObj(b.setting.origin) && Array.isArray(b.setting.origin.sources) ? b.setting.origin.sources : [];
  req.sources = srcs.map((x: any) => (typeof x?.id === "string" ? x.id.slice(0, 120) : "")).filter(Boolean).slice(0, SIM_LIMITS.sources);
  if (op === "suggest") return req;
  if (op === "next") {
    const last = req.log[req.log.length - 1];
    if (!last || (last.act !== "wait" && last.act !== "stage")) throw new SimInputError("続きは、待つ・次の段への行為のあとにだけ書きます", "not_boundary");
  } else {
    const facts = new Set(factIds(flow));
    if (!Array.isArray(b.qs) || !b.qs.length || b.qs.length > SIM_LIMITS.fill || !b.qs.every((q: unknown) => typeof q === "string" && facts.has(q))) throw new SimInputError("補う項目は、フローの事実の質問 1〜20 個", "bad_qs");
    req.qs = [...new Set(b.qs as string[])];
  }
  return req;
}

/** The doctor's own words in a request (the identifier check runs on them; the theme is a disease or a symptom, checked the same way). */
export const simTexts = (r: SimRequest): string[] => [r.theme, ...r.log.flatMap((a) => (a.act === "say" ? [a.text] : [])), ...r.told, r.answers, r.own].filter(Boolean);

// ---------------------------------------------------------------- the request to the model
const catalogLines = (flow: SimFlow) =>
  flow.questions.map((q) => {
    const o: Record<string, unknown> = { id: q.id, label: q.label, type: q.type, kind: q.kind };
    if (q.unit) o.unit = q.unit;
    if (q.options?.length) o.options = q.options;
    if (q.exclusive?.length) o.exclusive = q.exclusive;
    if (q.afterAct) o.afterAct = true;
    return JSON.stringify(o);
  });

/** The instructions and the flow's questions: the same string for every request of an op and a flow (it is cached). */
export function simSystem(op: SimOp, flow: SimFlow): string {
  if (op === "soap") return [SIM_SOAP_RULES, "", `場面・症候: ${flow.title}`].join("\n");
  const rules = op === "author" ? [SIM_AUTHOR_RULES, SIM_SUGGEST_RULES] : op === "next" ? [SIM_NEXT_RULES, SIM_SUGGEST_RULES] : op === "suggest" ? [SIM_SUGGEST_RULES] : [SIM_FILL_RULES];
  return [SIM_RULES, ...rules, "", `質問の一覧（${flow.title}。1行に1問の JSON。kind: fact＝症例が値を持つ／reading＝先生の読み・判断／action＝先生の行為／time＝時刻）:`, ...catalogLines(flow)].join("\n");
}

const factItem = (ids: string[]) => ({
  type: "object",
  additionalProperties: false,
  required: ["q", "v", "who", "how"],
  properties: { q: { type: "string", enum: ids }, v: { type: "array", items: { type: "string" } }, who: { type: "string", enum: WHO }, how: { type: "string", enum: HOW } },
});
const idList = (ids: string[]) => (ids.length ? { type: "array", items: { type: "string", enum: ids } } : { type: "array", items: { type: "string" }, maxItems: 0 });
const textList = { type: "array", items: { type: "string" } };

/** The structured-output schema of an op: only the flow's question ids and the given sections can be named.  Sizes are checked after. */
export function simSchema(op: SimOp, flow: SimFlow, sourceIds: string[], qs: string[] = []): object {
  const facts = factIds(flow);
  const suggest = {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["act", "target", "why"],
      properties: { act: { type: "string", enum: ["ask", "do"] }, target: { type: "string", enum: [...facts, ...actionKeys(flow)] }, why: { type: "string" } },
    },
  };
  if (op === "suggest") return { type: "object", additionalProperties: false, required: ["suggest"], properties: { suggest } };
  if (op === "soap") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["S", "O", "A", "P", "disposition"],
      properties: {
        S: textList,
        O: textList,
        A: { type: "array", items: { type: "object", additionalProperties: false, required: ["problem", "assessment"], properties: { problem: { type: "string" }, assessment: { type: "string" } } } },
        P: { type: "array", items: { type: "object", additionalProperties: false, required: ["kind", "text"], properties: { kind: { type: "string", enum: PLAN_KINDS }, text: { type: "string" } } } },
        disposition: { type: "string" },
      },
    };
  }
  if (op === "fill") return { type: "object", additionalProperties: false, required: ["facts"], properties: { facts: { type: "array", items: factItem(qs) } } };
  if (op === "next") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["facts", "event_who", "event_text", "basis", "suggest"],
      properties: { facts: { type: "array", items: factItem(facts) }, event_who: { type: "string", enum: WHO }, event_text: { type: "string" }, basis: idList(sourceIds), suggest },
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["patient", "clock_start", "opening", "facts", "orders", "assumed", "used", "suggest"],
    properties: {
      patient: { type: "object", additionalProperties: false, required: ["age", "sex"], properties: { age: { type: "integer" }, sex: { type: "string", enum: SEXES } } },
      clock_start: { type: "string" },
      opening: { type: "array", items: { type: "object", additionalProperties: false, required: ["who", "text"], properties: { who: { type: "string", enum: WHO }, text: { type: "string" } } } },
      facts: { type: "array", items: factItem(facts) },
      orders: { type: "array", items: { type: "object", additionalProperties: false, required: ["order", "results"], properties: { order: { type: "string", enum: actionKeys(flow) }, results: idList(facts) } } },
      assumed: {
        type: "object",
        additionalProperties: false,
        required: ["dx", "ddx", "key", "pitfall", "lesson"],
        properties: { dx: textList, ddx: textList, key: idList(facts), pitfall: { type: "string" }, lesson: { type: "string" } },
      },
      used: idList(sourceIds),
      suggest,
    },
  };
}

export interface BookSection {
  id: string;
  title: string;
  page: string;
  path: string;
  text: string;
}

/** Fenced text of the doctor or of a book (the fence's own marks become full-width inside it). */
const fence = (s: string) => s.replace(/</g, "＜").replace(/>/g, "＞");

const booksBlock = (books: BookSection[]) =>
  books.length
    ? `<books>\n${books.map((b) => `[${b.id}] ${fence(b.title)} ${b.page} ${fence(b.path)}\n${fence(b.text.slice(0, SIM_LIMITS.bookChars))}`).join("\n\n")}\n</books>`
    : "<books>\n（該当する節が見つかりませんでした。basis は空にします）\n</books>";

/** The doctor's acts in words, numbered; the acts since the last boundary before the end are marked. */
export function renderCourse(flow: SimFlow, log: SimAct[]): string[] {
  const label = (id: string) => qOf(flow, id)?.label ?? id;
  let lastBoundary = -1;
  for (let i = log.length - 2; i >= 0; i--) if (log[i].act === "wait" || log[i].act === "stage") {
    lastBoundary = i;
    break;
  }
  return log.map((a, i) => {
    const mark = i > lastBoundary ? "＊" : "";
    let text = "";
    if (a.act === "ask") text = `聞く・診る・測る: ${label(a.q)}`;
    else if (a.act === "do") {
      const [qid, oid] = a.key.split("=");
      const opt = qOf(flow, qid)?.options?.find(([o]) => o === oid)?.[1] ?? oid;
      text = `記録した行為: ${label(qid)}：${opt}`;
    } else if (a.act === "say") text = `${SAY_LABELS[a.type]}（先生の言葉）: 「${fence(a.text)}」`;
    else if (a.act === "wait") text = "── 待つ（時間が1区切り進む）";
    else text = `── 次の段へ: ${STAGES.find(([id]) => id === a.to)?.[1] ?? a.to}（時間が1区切り進む）`;
    return `${mark}${i + 1}. ${text}`;
  });
}

/** What the AI is told about the case so far: the hidden setting (states, orders, assumption), the acts, where the case is now. */
export function userContent(r: SimRequest, books: BookSection[]): string {
  if (r.op === "soap") {
    return `<told>\n${r.told.map(fence).join("\n")}\n</told>\n\n<answers>\n${fence(r.answers) || "（まだありません）"}\n</answers>\n\n<own>\n${fence(r.own) || "（書いていません）"}\n</own>`;
  }
  if (r.op === "author") {
    const repair = r.repair
      ? `\n\n<repair>\n前に書いた設定:\n${JSON.stringify(r.repair.setting)}\n検査の結果（直す誤り）:\n${r.repair.errors.map((e) => `- ${e.code} ${e.where}: ${e.msg}`).join("\n")}\n</repair>`
      : "";
    return `<request>\nテーマ: ${fence(r.theme)}\n難しさ: ${r.level}\n</request>\n\n${booksBlock(books)}${repair}`;
  }
  const hidden = { patient: r.setting.patient, opening: r.setting.opening, states: r.setting.states, orders: r.setting.orders, assumed: r.setting.assumed };
  const stageLabel = STAGES.find(([id]) => id === r.stage)?.[1] ?? r.stage;
  const fill = r.op === "fill" ? `\nfill（値を補う項目）: ${r.qs.map((q) => `${q}（${qOf(r.flow, q)?.label ?? q}）`).join("、")}` : "";
  return `<setting>\n${fence(JSON.stringify(hidden))}\n</setting>\n\n<course>\n先生の行為（＊は前の区切りからの行為）:\n${renderCourse(r.flow, r.log).join("\n") || "（まだありません）"}\nいまの状態: ${r.state}\n区切り: ${r.t}\n段: ${stageLabel}${fill}\n</course>\n\n${booksBlock(books)}`;
}

export function buildSimBody(r: SimRequest, books: BookSection[], model: string, fallback = true): Record<string, unknown> {
  return {
    model,
    max_tokens: r.op === "author" ? 16000 : r.op === "soap" ? 8000 : 6000,
    output_config: { effort: r.op === "author" || r.op === "soap" ? "medium" : "low", format: { type: "json_schema", schema: simSchema(r.op, r.flow, books.map((b) => b.id), r.qs) } },
    system: [{ type: "text", text: simSystem(r.op, r.flow), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userContent(r, books) }],
    ...(fallback ? { fallbacks: "default" } : {}),
  };
}

// ---------------------------------------------------------------- the answer, checked for shape
export type SimDrop = "unknown" | "not_fact" | "value" | "duplicate" | "after_act" | "shape";
export interface SimSuggestion {
  act: "ask" | "do";
  target: string;
  why: string;
}
export interface SimSoap {
  S: string[];
  O: string[];
  A: { problem: string; assessment: string }[];
  P: { kind: string; text: string }[];
  disposition: string;
}

/** The suggested acts that fit the flow: an ask of a fact, a do of an act of the flow; at most SIM_LIMITS.suggest, no repeat. */
export function checkSuggestions(flow: SimFlow, list: unknown): SimSuggestion[] {
  const facts = new Set(factIds(flow));
  const keys = new Set(actionKeys(flow));
  const out: SimSuggestion[] = [];
  for (const x of Array.isArray(list) ? list.slice(0, 20) : []) {
    if (!isObj(x) || typeof x.target !== "string") continue;
    const ok = (x.act === "ask" && facts.has(x.target)) || (x.act === "do" && keys.has(x.target));
    if (!ok || out.some((o) => o.act === x.act && o.target === x.target)) continue;
    out.push({ act: x.act, target: x.target, why: str(x.why, SIM_LIMITS.why) });
    if (out.length >= SIM_LIMITS.suggest) break;
  }
  return out;
}

/** The S/O/A/P draft in its shape: short texts, at most SIM_LIMITS.soapItems per part, a plan item only Dx / Tx / Ex. */
export function checkSoap(d: any): SimSoap {
  const list = (xs: unknown) => (Array.isArray(xs) ? xs.map((x) => str(x, SIM_LIMITS.text)).filter(Boolean).slice(0, SIM_LIMITS.soapItems) : []);
  return {
    S: list(d?.S),
    O: list(d?.O),
    A: (Array.isArray(d?.A) ? d.A : []).map((a: any) => ({ problem: str(a?.problem, 120), assessment: str(a?.assessment, SIM_LIMITS.text) })).filter((a: any) => a.problem).slice(0, SIM_LIMITS.soapItems),
    P: (Array.isArray(d?.P) ? d.P : []).map((p: any) => ({ kind: p?.kind, text: str(p?.text, SIM_LIMITS.text) })).filter((p: any) => PLAN_KINDS.includes(p.kind) && p.text).slice(0, SIM_LIMITS.soapItems),
    disposition: str(d?.disposition, SIM_LIMITS.text),
  };
}
export interface SimFact {
  q: string;
  v: string | string[] | number;
  who: string;
  how: string;
}

/** The value a question takes from the AI's string array, or null (choice: one option; multi: options, an exclusive one alone; number; text). */
export function typedValue(q: SimQuestion, v: unknown): string | string[] | number | null {
  if (!Array.isArray(v) || !v.length || v.length > 40 || !v.every((x) => typeof x === "string")) return null;
  const ids = new Set((q.options ?? []).map(([o]) => o));
  if (q.type === "choice") return v.length === 1 && ids.has(v[0]) ? v[0] : null;
  if (q.type === "multi") {
    const u = [...new Set(v as string[])];
    if (!u.every((x) => ids.has(x))) return null;
    if (u.some((x) => (q.exclusive ?? []).includes(x)) && u.length > 1) return null;
    return u;
  }
  if (v.length !== 1) return null;
  const s = v[0].trim();
  if (q.type === "number") return /^-?\d+(?:\.\d+)?$/.test(s) && Number.isFinite(Number(s)) ? Number(s) : null;
  if (q.type === "text") return s && s.length <= SIM_LIMITS.text ? s : null;
  return null; // time: the case holds no time
}

/** The facts of an answer that fit the flow: { facts, dropped } (a question given twice is dropped both times: it is ambiguous). */
export function checkFacts(flow: SimFlow, list: unknown, opts: { only?: Set<string>; first?: boolean } = {}): { facts: SimFact[]; dropped: Record<SimDrop, number> } {
  const dropped: Record<SimDrop, number> = { unknown: 0, not_fact: 0, value: 0, duplicate: 0, after_act: 0, shape: 0 };
  const items: any[] = Array.isArray(list) ? list.slice(0, 200) : [];
  const counts = new Map<string, number>();
  for (const f of items) if (typeof f?.q === "string") counts.set(f.q, (counts.get(f.q) ?? 0) + 1);
  const facts: SimFact[] = [];
  for (const f of items) {
    if (!isObj(f) || typeof f.q !== "string" || !WHO.includes(f.who) || !HOW.includes(f.how)) {
      dropped.shape++;
      continue;
    }
    const q = qOf(flow, f.q);
    if (!q || (opts.only && !opts.only.has(f.q))) {
      dropped.unknown++;
      continue;
    }
    if (q.kind !== "fact") {
      dropped.not_fact++;
      continue;
    }
    if ((counts.get(f.q) ?? 0) > 1) {
      dropped.duplicate++;
      continue;
    }
    if (opts.first && q.afterAct) {
      dropped.after_act++;
      continue;
    }
    const v = typedValue(q, f.v);
    if (v === null) {
      dropped.value++;
      continue;
    }
    facts.push({ q: q.id, v, who: f.who, how: f.how });
  }
  return { facts, dropped };
}

const texts = (xs: unknown, max = SIM_LIMITS.assumed) => (Array.isArray(xs) ? xs.map((x) => str(x, SIM_LIMITS.text)).filter(Boolean).slice(0, max) : []);

export interface SimResult {
  model?: string;
  setting?: any;
  facts?: SimFact[];
  event?: { who: string; text: string };
  basis?: string[];
  suggest?: SimSuggestion[];
  soap?: SimSoap;
  dropped: Record<SimDrop, number>;
  overlap: OverlapFinding[];
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
}

/** An answer of the model as what the screen takes (the shape checked; everything else is checked on the screen). */
export function parseSimOutput(raw: string, r: SimRequest, books: BookSection[]): Omit<SimResult, "usage" | "model"> {
  let d: any;
  try {
    d = JSON.parse(raw);
  } catch {
    throw new ExtractUpstreamError("AI の答えを読めませんでした。もう一度試してください", "bad_output");
  }
  const sourceIds = new Set(books.map((b) => b.id));
  const overlapOf = (ts: string[]) => findOverlaps(ts.join("\n"), books.map((b) => ({ text: b.text, page_label: b.page })));
  const none: Record<SimDrop, number> = { unknown: 0, not_fact: 0, value: 0, duplicate: 0, after_act: 0, shape: 0 };
  if (r.op === "suggest") return { suggest: checkSuggestions(r.flow, d?.suggest), dropped: none, overlap: [] };
  if (r.op === "soap") return { soap: checkSoap(d), dropped: none, overlap: [] };
  if (r.op === "fill") {
    const { facts, dropped } = checkFacts(r.flow, d?.facts, { only: new Set(r.qs) });
    return { facts, dropped, overlap: overlapOf(facts.filter((f) => typeof f.v === "string" && qOf(r.flow, f.q)?.type === "text").map((f) => f.v as string)) };
  }
  if (r.op === "next") {
    const { facts, dropped } = checkFacts(r.flow, d?.facts);
    const text = str(d?.event_text, SIM_LIMITS.text);
    const event = text && WHO.includes(d?.event_who) ? { who: d.event_who as string, text } : undefined;
    const basis = (Array.isArray(d?.basis) ? d.basis : []).filter((b: unknown) => typeof b === "string" && sourceIds.has(b)).slice(0, 4);
    return { facts, ...(event ? { event } : {}), basis, suggest: checkSuggestions(r.flow, d?.suggest), dropped, overlap: overlapOf([...(event ? [event.text] : []), ...facts.filter((f) => qOf(r.flow, f.q)?.type === "text").map((f) => String(f.v))]) };
  }
  const { facts, dropped } = checkFacts(r.flow, d?.facts, { first: true });
  const age = d?.patient?.age;
  const sex = d?.patient?.sex;
  if (!Number.isInteger(age) || age < 0 || age > 130 || !SEXES.includes(sex)) throw new ExtractUpstreamError("AI の設定に年齢・性別がありません。もう一度試してください", "bad_output");
  const keys = new Set(actionKeys(r.flow));
  const fset = new Set(factIds(r.flow));
  const orders: { order: string; results: string[] }[] = [];
  for (const o of Array.isArray(d?.orders) ? d.orders.slice(0, 8) : []) {
    const results = [...new Set((Array.isArray(o?.results) ? o.results : []).filter((q: unknown) => typeof q === "string" && fset.has(q)))] as string[];
    if (typeof o?.order === "string" && keys.has(o.order) && results.length && !orders.some((x) => x.order === o.order)) orders.push({ order: o.order, results });
  }
  const opening = (Array.isArray(d?.opening) ? d.opening : [])
    .map((o: any) => ({ who: o?.who, text: str(o?.text, SIM_LIMITS.text) }))
    .filter((o: any) => WHO.includes(o.who) && o.text)
    .slice(0, 6);
  const used = new Set((Array.isArray(d?.used) ? d.used : []).filter((b: unknown) => typeof b === "string" && sourceIds.has(b)));
  const sources = books.filter((b) => !used.size || used.has(b.id)).map((b) => ({ id: b.id, title: b.title.slice(0, 200), page: b.page.slice(0, 40) }));
  const assumed = {
    dx: texts(d?.assumed?.dx),
    ddx: texts(d?.assumed?.ddx),
    key: texts(d?.assumed?.key).filter((q) => fset.has(q)),
    pitfall: str(d?.assumed?.pitfall, SIM_LIMITS.text),
    lesson: str(d?.assumed?.lesson, SIM_LIMITS.text),
  };
  const clock = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(d?.clock_start)) ? { clock: { start: d.clock_start } } : {};
  const setting = {
    v: 1,
    flow: r.flow.id,
    schema: SIM_CATALOG_SOURCE.commit,
    patient: { age, sex },
    ...clock,
    opening,
    states: [{ id: "s0", facts }],
    orders,
    moves: [],
    assumed,
    origin: { by: "ai", sources },
  };
  const ts = [...opening.map((o: any) => o.text), ...facts.filter((f) => qOf(r.flow, f.q)?.type === "text").map((f) => String(f.v)), ...assumed.dx, ...assumed.ddx, assumed.pitfall, assumed.lesson];
  return { setting, suggest: checkSuggestions(r.flow, d?.suggest), dropped, overlap: overlapOf(ts) };
}

// ---------------------------------------------------------------- the call
const asSection = (p: ParentResult): BookSection => ({ id: p.parent_id, title: p.book_title, page: pageLabel(p), path: p.path, text: p.text });

/** The book sections an op is grounded in: a search for the theme (author), or the sections the setting was written from (next, fill). */
export async function simBooks(db: Db, r: SimRequest): Promise<BookSection[]> {
  if (r.op === "soap") return []; // the draft is written from the case the doctor saw; the books are not searched for it
  if (r.op === "author") return (await searchParents(db, [r.theme, `${r.theme} ${r.flow.title}`], { parents: SIM_LIMITS.books })).slice(0, SIM_LIMITS.books).map(asSection);
  const out: BookSection[] = [];
  for (const id of r.sources) {
    const p = await getParent(db, id);
    if (p) out.push(asSection(p));
  }
  return out;
}

export async function runSim(deps: ExtractDeps & { db: Db }, r: SimRequest): Promise<SimResult> {
  const books = await simBooks(deps.db, r);
  const msg = await postMessages(deps, (fallback) => buildSimBody(r, books, deps.model, fallback));
  if (msg?.stop_reason === "refusal") throw new ExtractUpstreamError("モデルが、この依頼を断りました。テーマを確かめてください", "refused");
  if (msg?.stop_reason === "max_tokens") throw new ExtractUpstreamError("AI の答えが長くなりすぎました。もう一度試してください", "output_too_long");
  const { raw, usage, model } = messageText(msg);
  return { ...(model ? { model } : {}), ...parseSimOutput(raw, r, books), usage };
}
