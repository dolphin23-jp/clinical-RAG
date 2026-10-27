// Case mode, the parts without a screen (docs/enhancement-plan.md 7.2).  Twin of worker/src/casemode.ts: the option lists, the
// limits and the mode labels are pinned equal by worker/test/casemode.test.ts.  Nothing here derives a finding, a score or a
// threshold from the case: it is what the doctor typed, passed on as typed.

/**
 * The age is whole years (0-130; an infant under one year is 0), typed as a number (the doctor's decision of 2026-10-25: the Casebook packet needs
 * the age in years).  The bands this field had before ("70代") are still read back from older saves and old conversations: LEGACY_AGES.
 * Twin of AGE_MAX / LEGACY_AGES / isAgeYears in worker/src/casemode.ts (pinned equal by worker/test/casemode.test.ts).
 */
export const AGE_MAX = 130;
export const LEGACY_AGES = ["乳児", "幼児", "学童", "10代", "20代", "30代", "40代", "50代", "60代", "70代", "80代", "90代以上"];
export const isAgeYears = (v) => typeof v === "string" && /^(0|[1-9]\d{0,2})$/.test(v) && Number(v) <= AGE_MAX;
/**
 * What the age field holds, read from what was typed: whole years ("72", "７２", "72歳" -> "72"), an old band as it was, or "" when it is neither
 * (`ok`: false when something was typed that is not an age, so the screen can say so).
 */
export function readAge(text) {
  const bare = String(text ?? "").normalize("NFKC").replace(/\s+/g, "");
  const t = bare.replace(/[歳才]$/u, "");
  if (bare === "") return { age: "", ok: true };
  if (t === "") return { age: "", ok: false }; // only the unit ("歳") was typed
  if (isAgeYears(t)) return { age: t, ok: true };
  const band = String(text).normalize("NFKC").replace(/\s+/g, "");
  return LEGACY_AGES.includes(band) ? { age: band, ok: true } : { age: "", ok: false };
}
/** The age for a line: "72歳", or the old band as it was ("70代"); "" when there is none. */
export const ageText = (age) => (isAgeYears(age) ? `${age}歳` : String(age ?? ""));
export const SEXES = ["男性", "女性", "その他・不明"];
export const SETTINGS = ["外来", "救急", "病棟"];

/** The four buttons (the fifth mode, "ask", is a free question typed in the composer while a case is attached). */
export const MODES = [
  { id: "assess", label: "アセスメントとプラン（草案）" },
  { id: "ddx", label: "鑑別と反証" },
  { id: "miss", label: "見落としチェック" },
  { id: "consult", label: "コンサルト・医師コールの基準" },
];

/** Free-text fields in screen order (limits in characters; the Worker enforces the same numbers). */
export const FIELDS = [
  { key: "complaint", label: "主訴と経過", max: 1500, rows: 4, placeholder: "例: 3日前から発熱と咳。昨日から尿量が減った。（日付は「3日前から」のように経過で）" },
  { key: "vitals", label: "バイタル", max: 500, rows: 2, placeholder: "例: BP 92/54, HR 108, RR 24, SpO2 94%（室内気）, BT 38.4℃（単位つき。記録するだけで、正常・異常の判定は付けません）" },
  { key: "findings", label: "身体所見・検査・画像・心電図", max: 3000, rows: 6, placeholder: "例: Cr 2.4 mg/dL（ふだんは 0.9）, K 5.8 mEq/L, 尿Na 12 mEq/L, 胸部X線で右下肺野に浸潤影。（検査値は数値で）" },
  { key: "history", label: "既往・内服", max: 1500, rows: 3, placeholder: "例: 高血圧、2型糖尿病。内服はアムロジピン、メトホルミン、ロキソプロフェン（一般名で）" },
  { key: "own", label: "先生自身のアセスメント（任意）", max: 1500, rows: 3, placeholder: "例: 感染に伴う腎前性AKIを第一に考える。NSAIDs と脱水の関与。" },
];
export const TEXT_KEYS = FIELDS.map((f) => f.key);
const LIMITS = Object.fromEntries(FIELDS.map((f) => [f.key, f.max]));

/** The most characters of `structured` (the rendered answers of a scene x symptom flow, web/intake.js).  Twin of STRUCTURED_LIMIT in worker/src/casemode.ts. */
export const STRUCTURED_LIMIT = 6000;
const INTAKE_ENTRIES = 300;

/**
 * `structured`: the flow's questions answered, as text (what is sent).  `intake`: the same answers as {flow, answers}, kept by this
 * screen only so a saved conversation can reopen the form (the Worker does not take it).  Both are "" / null when the form is not used.
 */
export const emptyCase = () => ({ age: "", sex: "", setting: "", complaint: "", vitals: "", findings: "", history: "", own: "", structured: "", intake: null });

/** A case with nothing to work from (age/sex/setting alone are not enough). */
export const isEmptyCase = (c) => !(c.complaint?.trim() || c.vitals?.trim() || c.findings?.trim() || c.history?.trim() || c.structured?.trim());

/** Every free-text value, for the identifier check (the rendered answers included). */
export const caseTexts = (c) => [...TEXT_KEYS.map((k) => c[k] ?? ""), c.structured ?? ""];

/** An intake read back from a saved conversation (or any untrusted shape): {flow, answers} with plain values only, or null. */
export function cleanIntake(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.flow !== "string" || raw.flow.length > 80 || !raw.answers || typeof raw.answers !== "object" || Array.isArray(raw.answers)) return null;
  const answers = {};
  for (const [id, v] of Object.entries(raw.answers).slice(0, INTAKE_ENTRIES)) {
    if (id.length > 60) continue;
    if (typeof v === "string") answers[id] = v.slice(0, 600);
    else if (typeof v === "number" && Number.isFinite(v)) answers[id] = v;
    else if (Array.isArray(v)) answers[id] = v.filter((x) => typeof x === "string" && x.length <= 60).slice(0, 40);
  }
  return Object.keys(answers).length ? { flow: raw.flow, answers } : null;
}

/** A case read back from a saved conversation (or any untrusted shape): known keys only, choices checked, texts cut to the limit. */
export function cleanCase(raw) {
  const out = emptyCase();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  if (typeof raw.age === "string") out.age = readAge(raw.age).age;
  for (const [k, list] of [["sex", SEXES], ["setting", SETTINGS]]) if (typeof raw[k] === "string" && list.includes(raw[k])) out[k] = raw[k];
  for (const k of TEXT_KEYS) if (typeof raw[k] === "string") out[k] = raw[k].trim().slice(0, LIMITS[k]);
  if (typeof raw.structured === "string") out.structured = raw.structured.trim().slice(0, STRUCTURED_LIMIT);
  out.intake = out.structured ? cleanIntake(raw.intake) : null;
  // a fictional case (from the simulation or a created case: the doctor's decision D7, 2026-10-26) keeps its mark wherever it goes; only `true`
  if (raw.synthetic === true) out.synthetic = true;
  return out;
}

/** The mark shown with a fictional case. */
export const SYNTHETIC_MARK = "〔架空症例〕";

/** The case as the Worker takes it: without `intake` (the form's own answers stay on this screen and in the saved conversation). */
export const caseForServer = (c) => {
  const { intake, ...rest } = c;
  return rest;
};

/** Same case? (used to remember that the doctor already confirmed the identifier prompt for these words) */
export const caseKey = (c) => JSON.stringify(cleanCase(c));

const oneLine = (s, n) => {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};

/** The scene and symptom of the flow whose answers are in `structured` ("救急外来 × 腹痛"), or "". */
export const structuredTitle = (c) => /^場面・症候: (.+?)（/.exec(c.structured ?? "")?.[1] ?? "";

/** One line for the bar over the thread: 70代・男性・救急｜主訴の冒頭 */
export function caseSummary(c) {
  const who = [[ageText(c.age), c.sex].filter(Boolean).join("・"), c.setting].filter(Boolean).join("・");
  const body = oneLine(c.complaint || c.findings || c.vitals || c.history || structuredTitle(c), 48);
  return [who, body].filter(Boolean).join("｜");
}

/** Rows to show a case read-only: [label, value] for the filled fields only. */
export function caseRows(c) {
  const rows = [];
  const who = [ageText(c.age), c.sex].filter(Boolean).join("・");
  if (who) rows.push(["年齢・性別", who]);
  if (c.setting) rows.push(["場面", c.setting]);
  for (const f of FIELDS) {
    if (f.key === "own" && c.structured) rows.push(["場面・症候の入力", c.structured]);
    if (c[f.key]) rows.push([f.label, c[f.key]]);
  }
  return rows;
}

// ---------------------------------------------------------------- creating a fictional case (docs/enhancement-plan.md 7.4)
// Twin of the same lists in worker/src/casemode.ts (pinned equal by worker/test/casemode.test.ts).

export const LEVELS = ["標準", "紛らわしい鑑別あり", "複合問題"];
export const CREATE_LIMITS = { theme: 100, goal: 300 };
/** The days of course after the admission a created case can come with (0 = the case only; docs/enhancement-plan.md 8.20).  Twin of worker/src/casemode.ts COURSE_DAYS. */
export const COURSE_DAYS = [0, 3, 5, 7, 10, 14];
export const CREATE_LABEL = "架空症例を作る";

export const emptyCreate = () => ({ theme: "", setting: "", level: LEVELS[0], goal: "", pitfall: true, days: 0 });

/** A creation request read back from a saved conversation (or any untrusted shape): known keys, choices checked, texts cut. */
export function cleanCreate(raw) {
  const out = emptyCreate();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  if (typeof raw.theme === "string") out.theme = raw.theme.trim().slice(0, CREATE_LIMITS.theme);
  if (typeof raw.goal === "string") out.goal = raw.goal.trim().slice(0, CREATE_LIMITS.goal);
  if (typeof raw.setting === "string" && SETTINGS.includes(raw.setting)) out.setting = raw.setting;
  if (typeof raw.level === "string" && LEVELS.includes(raw.level)) out.level = raw.level;
  if (typeof raw.pitfall === "boolean") out.pitfall = raw.pitfall;
  if (typeof raw.days === "number" && COURSE_DAYS.includes(raw.days)) out.days = raw.days;
  return out;
}

/** Rows to show a creation request read-only: [label, value]. */
export const createRows = (c) => [
  ["テーマ", c.theme],
  ["場面", c.setting || "（指定なし）"],
  ["難しさ", c.level],
  ["学ばせたいこと", c.goal || "（指定なし）"],
  ["落とし穴", c.pitfall ? "入れる" : "入れない"],
  ...(c.days ? [["入院後の経過", `入院${c.days}日目まで、日ごとに作る`]] : []),
];


/**
 * The earlier turns sent back to the model as context: the last `n`, without the turns that made a fictional case.
 * A created case's answer (its 見立て, its course) would otherwise travel as history into a later draft or answer and show the model the
 * case's own solution (docs/enhancement-plan.md 8.21, step 0).  `entry.mode` is the mode the turn was asked in ("" for a plain question).
 */
export function recentHistory(history, n = 4) {
  return (Array.isArray(history) ? history : []).filter((h) => h && h.mode !== "create").slice(-n);
}
