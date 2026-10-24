// Case mode (docs/enhancement-plan.md 7.2; the doctor's decision of 2026-10-24, docs/clinical-use.md 1d): the doctor types a
// case (age band, main findings, lab values) and asks for a draft assessment/plan, a differential with rebuttals, a missed-
// item check, or consult criteria.  This module only validates and renders the case; what the model is told to do with it
// lives in prompt.ts (the one place for behaviour), and the identifier check on every free-text field is in handler.ts.
//
// The case is data the doctor typed, nothing more: it is shown to the model as "【症例（入力）】", an empty field stays
// "（未入力）" (unknown, not negative), and nothing here derives a finding, a score or a threshold.
// Twin of web/case-model.js: the option lists and limits are pinned equal by worker/test/casemode.test.ts.

export const MODES = ["assess", "ddx", "miss", "consult", "ask"] as const;
export type Mode = (typeof MODES)[number];

/** The question sent for a mode when the caller gives none; also the label of the screen's buttons. */
export const MODE_LABELS: Record<Mode, string> = {
  assess: "アセスメントとプラン（草案）",
  ddx: "鑑別と反証",
  miss: "見落としチェック",
  consult: "コンサルト・医師コールの基準",
  ask: "症例を踏まえた質問",
};

export const AGES = ["乳児", "幼児", "学童", "10代", "20代", "30代", "40代", "50代", "60代", "70代", "80代", "90代以上"] as const;
export const SEXES = ["男性", "女性", "その他・不明"] as const;
export const SETTINGS = ["外来", "救急", "病棟"] as const;

/** Free-text fields, in screen order, with their length limits (characters). */
export const TEXT_LIMITS = { complaint: 1500, vitals: 500, findings: 3000, history: 1500, own: 1500 } as const;
export type TextKey = keyof typeof TEXT_LIMITS;

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

const ENUMS: Record<"age" | "sex" | "setting", readonly string[]> = { age: AGES, sex: SEXES, setting: SETTINGS };

/** Validates and normalises the case object from a request.  Unknown keys are dropped; numbers and objects in a text field are refused. */
export function parseCase(raw: unknown): CaseInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CaseInputError("case must be an object");
  const o = raw as Record<string, unknown>;
  const out: CaseInput = { age: "", sex: "", setting: "", complaint: "", vitals: "", findings: "", history: "", own: "" };
  for (const k of ["age", "sex", "setting"] as const) {
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
  if (!isEmptyCase(out)) return out;
  throw new CaseInputError("症例が空です。主訴と経過・バイタル・所見・既往のどれかを入力してください。", "empty_case");
}

/** A case with nothing the model could work from (age/sex/setting alone are not enough). */
export const isEmptyCase = (c: CaseInput): boolean => !(c.complaint || c.vitals || c.findings || c.history);

/** Every free-text value, for the identifier check.  The choice fields are validated against fixed lists instead. */
export const caseTexts = (c: CaseInput): string[] => (Object.keys(TEXT_LIMITS) as TextKey[]).map((k) => c[k]);

const indent = (s: string) => s.replace(/\n/g, "\n  ");

/** The case as the model sees it (put before the request in the final user message).  Unfilled fields say so. */
export function renderCase(c: CaseInput): string {
  const row = (label: string, v: string) => `- ${label}: ${v ? indent(v) : "（未入力）"}`;
  const lines = [
    "【症例（入力）】先生が入力した事実だけです。「（未入力）」は未確認という意味で、陰性・正常ではありません。",
    row("年代・性別", [c.age, c.sex].filter(Boolean).join("・")),
    row("場面", c.setting),
    row("主訴と経過", c.complaint),
    row("バイタル", c.vitals),
    row("身体所見・検査・画像・心電図", c.findings),
    row("既往・内服", c.history),
  ];
  if (c.own) lines.push(row("先生自身のアセスメント（先生の案）", c.own));
  return lines.join("\n");
}
