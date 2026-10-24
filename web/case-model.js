// Case mode, the parts without a screen (docs/enhancement-plan.md 7.2).  Twin of worker/src/casemode.ts: the option lists, the
// limits and the mode labels are pinned equal by worker/test/casemode.test.ts.  Nothing here derives a finding, a score or a
// threshold from the case: it is what the doctor typed, passed on as typed.

export const AGES = ["乳児", "幼児", "学童", "10代", "20代", "30代", "40代", "50代", "60代", "70代", "80代", "90代以上"];
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

export const emptyCase = () => ({ age: "", sex: "", setting: "", complaint: "", vitals: "", findings: "", history: "", own: "" });

/** A case with nothing to work from (age/sex/setting alone are not enough). */
export const isEmptyCase = (c) => !(c.complaint?.trim() || c.vitals?.trim() || c.findings?.trim() || c.history?.trim());

/** Every free-text value, for the identifier check. */
export const caseTexts = (c) => TEXT_KEYS.map((k) => c[k] ?? "");

/** A case read back from a saved conversation (or any untrusted shape): known keys only, choices checked, texts cut to the limit. */
export function cleanCase(raw) {
  const out = emptyCase();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, list] of [["age", AGES], ["sex", SEXES], ["setting", SETTINGS]]) if (typeof raw[k] === "string" && list.includes(raw[k])) out[k] = raw[k];
  for (const k of TEXT_KEYS) if (typeof raw[k] === "string") out[k] = raw[k].trim().slice(0, LIMITS[k]);
  return out;
}

/** Same case? (used to remember that the doctor already confirmed the identifier prompt for these words) */
export const caseKey = (c) => JSON.stringify(cleanCase(c));

const oneLine = (s, n) => {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};

/** One line for the bar over the thread: 70代・男性・救急｜主訴の冒頭 */
export function caseSummary(c) {
  const who = [[c.age, c.sex].filter(Boolean).join("・"), c.setting].filter(Boolean).join("・");
  const body = oneLine(c.complaint || c.findings || c.vitals || c.history || "", 48);
  return [who, body].filter(Boolean).join("｜");
}

/** Rows to show a case read-only: [label, value] for the filled fields only. */
export function caseRows(c) {
  const rows = [];
  const who = [c.age, c.sex].filter(Boolean).join("・");
  if (who) rows.push(["年代・性別", who]);
  if (c.setting) rows.push(["場面", c.setting]);
  for (const f of FIELDS) if (c[f.key]) rows.push([f.label, c[f.key]]);
  return rows;
}
