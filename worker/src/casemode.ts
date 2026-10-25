// Case mode (docs/enhancement-plan.md 7.2; the doctor's decision of 2026-10-24, docs/clinical-use.md 1d): the doctor types a
// case (age band, main findings, lab values) and asks for a draft assessment/plan, a differential with rebuttals, a missed-
// item check, or consult criteria.  This module only validates and renders the case; what the model is told to do with it
// lives in prompt.ts (the one place for behaviour), and the identifier check on every free-text field is in handler.ts.
//
// The case is data the doctor typed, nothing more: it is shown to the model as "【症例（入力）】", an empty field stays
// "（未入力）" (unknown, not negative), and nothing here derives a finding, a score or a threshold.
// Twin of web/case-model.js: the option lists and limits are pinned equal by worker/test/casemode.test.ts.

export const MODES = ["assess", "ddx", "miss", "consult", "ask", "create"] as const;
export type Mode = (typeof MODES)[number];

/** The question sent for a mode when the caller gives none; also the label of the screen's buttons. */
export const MODE_LABELS: Record<Mode, string> = {
  assess: "アセスメントとプラン（草案）",
  ddx: "鑑別と反証",
  miss: "見落としチェック",
  consult: "コンサルト・医師コールの基準",
  ask: "症例を踏まえた質問",
  create: "架空症例を作る",
};

/**
 * The age is whole years, 0-130 (an infant under one year is 0): the doctor's decision of 2026-10-25 (the Casebook packet needs the age in years).
 * The bands the field had before ("70代") are still accepted, because older saved conversations and records carry them: LEGACY_AGES.
 * Twin of AGE_MAX / LEGACY_AGES / isAgeYears / ageText in web/case-model.js (pinned equal by worker/test/casemode.test.ts).
 */
export const AGE_MAX = 130;
export const LEGACY_AGES = ["乳児", "幼児", "学童", "10代", "20代", "30代", "40代", "50代", "60代", "70代", "80代", "90代以上"] as const;
export const isAgeYears = (v: string): boolean => /^(0|[1-9]\d{0,2})$/.test(v) && Number(v) <= AGE_MAX;
/** The age for a line: "72歳", or an old band as it was ("70代"). */
export const ageText = (age: string): string => (isAgeYears(age) ? `${age}歳` : age);
export const SEXES = ["男性", "女性", "その他・不明"] as const;
export const SETTINGS = ["外来", "救急", "病棟"] as const;

/** Free-text fields, in screen order, with their length limits (characters). */
export const TEXT_LIMITS = { complaint: 1500, vitals: 500, findings: 3000, history: 1500, own: 1500 } as const;
export type TextKey = keyof typeof TEXT_LIMITS;
/**
 * The most characters of `structured`: the answers to a scene x symptom flow's questions, put into words by the screen
 * (web/intake.js, docs/clinical-use.md 1e).  Twin of STRUCTURED_LIMIT there.  No cap on what the doctor pastes elsewhere: this is
 * only the size of the rendered answers.
 */
export const STRUCTURED_LIMIT = 6000;

export interface CaseInput {
  age: string;
  sex: string;
  setting: string;
  complaint: string;
  vitals: string;
  findings: string;
  history: string;
  /** the doctor's own assessment (optional); when present the draft adds a section of differences from it */
  own: string;
  /** the answers to a scene x symptom flow's questions as text (web/intake.js); "" when the structured intake is not used */
  structured: string;
}

export class CaseInputError extends Error {
  code: string;
  constructor(message: string, code = "bad_case") {
    super(message);
    this.code = code;
  }
}

export function parseMode(raw: unknown): Mode | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "string" && (MODES as readonly string[]).includes(raw)) return raw as Mode;
  throw new CaseInputError(`mode must be one of ${MODES.join(", ")}`, "bad_mode");
}

const ENUMS: Record<"sex" | "setting", readonly string[]> = { sex: SEXES, setting: SETTINGS };

/** Validates and normalises the case object from a request.  Unknown keys are dropped; numbers and objects in a text field are refused. */
export function parseCase(raw: unknown): CaseInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CaseInputError("case must be an object");
  const o = raw as Record<string, unknown>;
  const out: CaseInput = { age: "", sex: "", setting: "", complaint: "", vitals: "", findings: "", history: "", own: "", structured: "" };
  if (o.age !== undefined && o.age !== null && o.age !== "") {
    if (typeof o.age !== "string" || !(isAgeYears(o.age) || (LEGACY_AGES as readonly string[]).includes(o.age))) throw new CaseInputError(`case.age must be whole years (0-${AGE_MAX})`);
    out.age = o.age;
  }
  for (const k of ["sex", "setting"] as const) {
    const v = o[k];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string" || !ENUMS[k].includes(v)) throw new CaseInputError(`case.${k} is not one of the choices`);
    out[k] = v;
  }
  for (const k of Object.keys(TEXT_LIMITS) as TextKey[]) {
    const v = o[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") throw new CaseInputError(`case.${k} must be a string`);
    const s = v.replace(/\r\n?/g, "\n").trim();
    if (s.length > TEXT_LIMITS[k]) throw new CaseInputError(`case.${k} is longer than ${TEXT_LIMITS[k]} characters`);
    out[k] = s;
  }
  const st = o.structured;
  if (st !== undefined && st !== null) {
    if (typeof st !== "string") throw new CaseInputError("case.structured must be a string");
    const s = st.replace(/\r\n?/g, "\n").trim();
    if (s.length > STRUCTURED_LIMIT) throw new CaseInputError(`case.structured is longer than ${STRUCTURED_LIMIT} characters`);
    out.structured = s;
  }
  if (!isEmptyCase(out)) return out;
  throw new CaseInputError("症例が空です。主訴と経過・バイタル・所見・既往・場面ごとの入力のどれかを入力してください。", "empty_case");
}

/** A case with nothing the model could work from (age/sex/setting alone are not enough). */
export const isEmptyCase = (c: CaseInput): boolean => !(c.complaint || c.vitals || c.findings || c.history || c.structured);

/** Every free-text value, for the identifier check.  The choice fields are validated against fixed lists instead. */
export const caseTexts = (c: CaseInput): string[] => [...(Object.keys(TEXT_LIMITS) as TextKey[]).map((k) => c[k]), c.structured];

// ------------------------------------------------------------------------------------------------ scenes and the record's summary
// Stage 4b (docs/enhancement-plan.md 8.16).  The assessment/plan draft can be made for a scene (its headings change: prompt.ts SCENE_SECTIONS),
// and, for the scenes that follow a case record, the record's summary goes with the case.  Twin of web/draft-scenes.js (pinned equal by
// worker/test/scenes.test.ts).  Neither is stored: they travel with one request, and the summary is not part of the saved case.

export const SCENES = ["ed", "op_first", "adm", "prog", "interim", "dc"] as const;
export type Scene = (typeof SCENES)[number];
export const SCENE_LABELS: Record<Scene, string> = {
  ed: "救急外来",
  op_first: "外来初診",
  adm: "病棟・入院時",
  prog: "病棟・経過",
  interim: "中間サマリー・転棟",
  dc: "退院時サマリー",
};
/** The scenes whose draft is about the course of a record: a request for one without the record's summary is refused. */
export const RECORD_SCENES: readonly Scene[] = ["prog", "interim", "dc"];
/** The scenes whose draft takes the record's summary when there is one (the admission takes it when a record is open; the others need it). */
export const BRIEF_SCENES: readonly Scene[] = ["adm", "prog", "interim", "dc"];
/** The most characters of the record's summary (the screen builds it and cuts it to this; twin of BRIEF_LIMIT in web/draft-scenes.js). */
export const BRIEF_LIMIT = 5000;

export function parseScene(raw: unknown): Scene | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "string" && (SCENES as readonly string[]).includes(raw)) return raw as Scene;
  throw new CaseInputError(`scene must be one of ${SCENES.join(", ")}`, "bad_scene");
}

/** The record's summary as text ("" when there is none).  It is data the screen built from the doctor's record; it is checked like every other free text. */
export function parseBrief(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string") throw new CaseInputError("record_brief must be a string", "bad_brief");
  const s = raw.replace(/\r\n?/g, "\n").trim();
  if (s.length > BRIEF_LIMIT) throw new CaseInputError(`record_brief is longer than ${BRIEF_LIMIT} characters`, "bad_brief");
  return s;
}

/** The mark the screen puts on a line of the summary that an AI draft wrote (the doctor adopted it).  Twin of AI_NOTE in web/record-brief.js. */
export const AI_NOTE = "（AI草案を採用したもの）";

/**
 * The summary without the lines an AI draft wrote: what is left is the doctor's own words, whose numbers are the doctor's input (the number check of
 * the answer leaves those alone).  A number an earlier draft invented and the doctor adopted is not the doctor's input and is still checked.
 */
export const userBrief = (brief: string): string =>
  brief
    .split("\n")
    .filter((l) => !l.includes(AI_NOTE))
    .join("\n");

/** The summary as the model sees it (after the case, before 【依頼】). */
export const renderBrief = (brief: string): string =>
  `【症例の記録（先生が記録したもの）】先生がこの症例の記録に書いた問題・評価・計画と、先生が選んだ確度・計画の状態・推移・未完了の課題です。確度・計画の状態・推移・課題の完了は、その日までに先生が記録したものです。問題名・評価と計画の文・問題の順序は、いまの記録のままです。「${AI_NOTE}」の印の行は、以前の草案を先生が採用した文です。\n${brief}`;

const indent = (s: string) => s.replace(/\n/g, "\n  ");

/** The case as the model sees it (put before the request in the final user message).  Unfilled fields say so. */
export function renderCase(c: CaseInput): string {
  const row = (label: string, v: string) => `- ${label}: ${v ? indent(v) : "（未入力）"}`;
  const lines = [
    "【症例（入力）】先生が入力した事実だけです。「（未入力）」は未確認という意味で、陰性・正常ではありません。",
    row("年齢・性別", [c.age ? ageText(c.age) : "", c.sex].filter(Boolean).join("・")),
    row("場面", c.setting),
    row("主訴と経過", c.complaint),
    row("バイタル", c.vitals),
    row("身体所見・検査・画像・心電図", c.findings),
    row("既往・内服", c.history),
  ];
  if (c.structured) lines.push(row("場面・症候の質問への答え（先生が選んだ・入力したもの。未入力は未確認）", c.structured));
  if (c.own) lines.push(row("先生自身のアセスメント（先生の案）", c.own));
  return lines.join("\n");
}

// ------------------------------------------------------------------------------------------------ creating a fictional case
// Stage 4 (docs/enhancement-plan.md 7.4): the doctor asks for a NEW fictional case built on what the books say is typical.
// The request carries a theme and wishes, never a case; the output is checked for copied book text (overlap.ts) and for
// dose/threshold/date/identifier-like text on the screen (web/case-create.js).  Twin of the lists in web/case-model.js.

export const LEVELS = ["標準", "紛らわしい鑑別あり", "複合問題"] as const;
export const CREATE_LIMITS = { theme: 100, goal: 300 } as const;

export interface CreateInput {
  /** a disease or a symptom, never a patient */
  theme: string;
  setting: string;
  level: string;
  goal: string;
  /** whether the case is to carry a pitfall */
  pitfall: boolean;
}

export function parseCreate(raw: unknown): CreateInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CaseInputError("create must be an object", "bad_create");
  const o = raw as Record<string, unknown>;
  const text = (k: "theme" | "goal"): string => {
    const v = o[k];
    if (v === undefined || v === null) return "";
    if (typeof v !== "string") throw new CaseInputError(`create.${k} must be a string`, "bad_create");
    const s = v.replace(/\r\n?/g, "\n").trim();
    if (s.length > CREATE_LIMITS[k]) throw new CaseInputError(`create.${k} is longer than ${CREATE_LIMITS[k]} characters`, "bad_create");
    return s;
  };
  const theme = text("theme");
  if (!theme) throw new CaseInputError("テーマ（病名・症候）を入力してください。", "bad_create");
  const choice = (k: "setting" | "level", list: readonly string[], dflt: string): string => {
    const v = o[k];
    if (v === undefined || v === null || v === "") return dflt;
    if (typeof v !== "string" || !list.includes(v)) throw new CaseInputError(`create.${k} is not one of the choices`, "bad_create");
    return v;
  };
  if (o.pitfall !== undefined && typeof o.pitfall !== "boolean") throw new CaseInputError("create.pitfall must be true or false", "bad_create");
  return { theme, setting: choice("setting", SETTINGS, ""), level: choice("level", LEVELS, LEVELS[0]), goal: text("goal"), pitfall: o.pitfall !== false };
}

/** The free-text values, for the identifier check. */
export const createTexts = (c: CreateInput): string[] => [c.theme, c.goal];

/** The request as the model sees it (the final user message, before 【依頼】). */
export function renderCreate(c: CreateInput): string {
  return [
    "【症例作成の依頼】先生が入力した依頼です。患者の情報ではありません。",
    `- テーマ: ${c.theme}`,
    `- 場面: ${c.setting || "（指定なし）"}`,
    `- 難しさ: ${c.level}`,
    `- 学ばせたいこと: ${c.goal ? c.goal.replace(/\n/g, "\n  ") : "（指定なし）"}`,
    `- 落とし穴: ${c.pitfall ? "入れる" : "入れない"}`,
  ].join("\n");
}
