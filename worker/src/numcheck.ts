// Number check (docs/enhancement-plan.md T1-6): every number with a unit or a comparison in an answer is looked up in the
// text the answer could have drawn from, so a figure the books do not contain is flagged by the machine, not by the
// model's own "【出典未確認】" tag.  Deterministic and read-only.  It is a hint, not a verdict: a number that appears in the
// book can still be about something else (another drug, another condition), and a transcription error in the book itself
// is invisible here (that is the page-image check, B3).  Numbers the user typed (question, case, earlier turns) are not
// checked: the answer repeating "K 6.8 mEq/L" is not a claim from a book.
import { norm, numberExpressions } from "./numsample.ts";

export type NumStatus = "cited" | "retrieved" | "not_found";

export interface NumFinding {
  text: string;
  status: NumStatus;
  /** page label of the section it was found in ("p.12"), when known */
  page?: string | null;
  /** found in a web citation rather than a book */
  via?: "web";
}

export interface CheckInput {
  /** the answer text (all blocks) */
  answer: string;
  /** citations of the answer: the cited passage text and where it came from */
  cited: { cited_text: string; page?: string | null; kind: string }[];
  /** every section the search returned for this question */
  retrieved: { text: string; page_label: string }[];
  /** what the user typed: question, case, earlier user turns */
  inputs: string[];
}

export const MAX_FINDINGS = 40;

const DASH = /[–〜~～−‐‑—]/g;
/** One form for comparing numbers: NFKC, no spaces, no thousands separators, one dash, lower case. */
export function numKey(s: string): string {
  return norm(s).replace(/\s+/g, "").replace(/(?<=\d),(?=\d{3}(?!\d))/g, "").replace(DASH, "-").toLowerCase();
}

/** `hay` contains `key` and the match does not continue a longer number ("110mg" does not contain "10mg"). */
export function containsNumber(hay: string, key: string): boolean {
  for (let i = hay.indexOf(key); i >= 0; i = hay.indexOf(key, i + 1)) {
    if (!/[0-9.]/.test(hay[i - 1] ?? "")) return true;
  }
  return false;
}

export function checkNumbers(inp: CheckInput): NumFinding[] {
  const inputKeys = inp.inputs.map(numKey);
  const cited = inp.cited.map((c) => ({ key: numKey(c.cited_text ?? ""), page: c.page ?? null, web: c.kind === "web" }));
  const retrieved = inp.retrieved.map((r) => ({ key: numKey(r.text), page: r.page_label || null }));
  const out: NumFinding[] = [];
  const seen = new Set<string>();
  const text = norm(inp.answer);
  for (const [, , expr] of numberExpressions(text)) {
    const k = numKey(expr);
    if (seen.has(k)) continue;
    seen.add(k);
    if (inputKeys.some((h) => containsNumber(h, k))) continue; // the doctor's own number
    const c = cited.find((x) => containsNumber(x.key, k));
    if (c) {
      out.push({ text: expr, status: "cited", page: c.page, ...(c.web ? { via: "web" as const } : {}) });
    } else {
      const r = retrieved.find((x) => containsNumber(x.key, k));
      out.push(r ? { text: expr, status: "retrieved", page: r.page } : { text: expr, status: "not_found" });
    }
    if (out.length >= MAX_FINDINGS) break;
  }
  return out;
}
