// Identifier guard (browser twin of worker/src/idguard.ts; tests/vectors/idguard.json is the shared contract).
// Same net as clinical-modules' web/id-guard.js. Names and dates are deliberately NOT detected (docs/clinical-use.md
// 2.1 / 2.3). It only reports the kind of match; it never edits or stores the input.

export const WORDS = ["患者ID", "カルテ番号", "診察券", "生年月日", "患者氏名", "ＩＤ", "マイナンバー", "保険証", "電話番号", "郵便番号", "〒"];

function half(s) {
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[‐‑–—−ー－]/g, "-")
    .replace(/：/g, ":");
}

/** Returns [{ code, label }], empty when nothing matched. */
export function scan(text) {
  const t = typeof text === "string" ? text : "";
  const s = half(t);
  const out = [];
  if (/(^|[^0-9.\-])[0-9]{8,}(?![0-9])/.test(s)) out.push({ code: "digits", label: "8桁以上の数字の並び" });
  if (/(^|[^0-9])[0-9]{2,4}-[0-9]{2,4}-[0-9]{3,4}(?![0-9])/.test(s)) out.push({ code: "phone", label: "電話番号らしき並び" });
  for (const w of WORDS) if (t.includes(w)) out.push({ code: "word", label: `「${w}」の語` });
  if (/(^|[^A-Za-z])(ID|MRN)\s*[:#＃]?\s*[0-9]{4,}/i.test(s)) out.push({ code: "idnum", label: "ID・MRN の後ろの数字" });
  if (/[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+\.[A-Za-z0-9.\-]+/.test(s)) out.push({ code: "email", label: "メールアドレスらしき文字" });
  return out;
}
