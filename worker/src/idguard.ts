// Identifier guard: flags text that looks like a patient identifier before it is sent to the model.
// Twin of web/id-guard.js; tests/vectors/idguard.json is the shared contract (worker/test/idguard.test.ts runs both).
// The net is the same as clinical-modules' web/id-guard.js. Names and dates are deliberately NOT detected
// (doctor's decision, 2026-10-24: docs/clinical-use.md 2.1 / 2.3): names cannot be told apart from ordinary words
// ("患者さん") and dates are written legitimately. Slipping through the net does not make an identifier acceptable.

export interface GuardHit {
  code: "digits" | "phone" | "word" | "idnum" | "email";
  label: string;
}

export const GUARD_WORDS = ["患者ID", "カルテ番号", "診察券", "生年月日", "患者氏名", "ＩＤ", "マイナンバー", "保険証", "電話番号", "郵便番号", "〒"];

/** Full-width digits / hyphens / colon -> ASCII, so the number nets see one form. */
function half(s: string): string {
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[‐‑–—−ー－]/g, "-")
    .replace(/：/g, ":");
}

export function scanIdentifiers(text: unknown): GuardHit[] {
  const t = typeof text === "string" ? text : "";
  const s = half(t); // number nets use the normalised text; the word net uses the original (keeps "マイナンバー" intact)
  const out: GuardHit[] = [];
  // 8+ consecutive digits that are not part of a decimal, a negative number or a hyphenated run
  if (/(^|[^0-9.\-])[0-9]{8,}(?![0-9])/.test(s)) out.push({ code: "digits", label: "8桁以上の数字の並び" });
  if (/(^|[^0-9])[0-9]{2,4}-[0-9]{2,4}-[0-9]{3,4}(?![0-9])/.test(s)) out.push({ code: "phone", label: "電話番号らしき並び" });
  for (const w of GUARD_WORDS) if (t.includes(w)) out.push({ code: "word", label: `「${w}」の語` });
  if (/(^|[^A-Za-z])(ID|MRN)\s*[:#＃]?\s*[0-9]{4,}/i.test(s)) out.push({ code: "idnum", label: "ID・MRN の後ろの数字" });
  if (/[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+\.[A-Za-z0-9.\-]+/.test(s)) out.push({ code: "email", label: "メールアドレスらしき文字" });
  return out;
}

/** Hits over several texts, one entry per label (the caller shows labels, never the matched text). */
export function scanAll(texts: unknown[]): GuardHit[] {
  const seen = new Set<string>();
  const out: GuardHit[] = [];
  for (const t of texts) {
    for (const h of scanIdentifiers(t)) {
      if (seen.has(h.label)) continue;
      seen.add(h.label);
      out.push(h);
    }
  }
  return out;
}
