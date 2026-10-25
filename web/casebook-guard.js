// What stops a text from going to Casebook (docs/enhancement-plan.md 8.17).  Pure functions: no DOM, no network, no storage.
//
// Casebook runs its own anonymization check on every text it receives (packages/core/src/lint/anonymize.ts): an item with a calendar date, a
// phone number, an e-mail address, a postal code, a long number or a birth date is skipped there.  This file stops those texts here first, so
// the packet never carries them, and so an item that Casebook would skip is not marked as sent.  It is a net that may stop MORE than Casebook
// does (a false stop costs the doctor a rewrite; a miss puts the text on the clipboard), never less: worker/test/casebook.test.ts compares it
// with Casebook's own check on a long list of shapes (and, when CASEBOOK_DIR points at Casebook's worktree, with the real function).
//
// Texts are folded first, the way Casebook folds them: invisible characters (zero-width, soft hyphen, word joiner ...) are dropped, full-width
// letters and digits become plain (NFKC), the dash look-alikes become "-".  A name is not detected (as in the rest of this app; the doctor's
// decision of 2026-10-24, docs/clinical-use.md 1b).
import { relativizeDates } from "./date-relative.js";
import { scan } from "./id-guard.js";

const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;

/** The text as Casebook reads it: no invisible characters, NFKC, dash look-alikes as "-" (and "ー" between digits). */
export const fold = (text) =>
  String(text ?? "")
    .replace(INVISIBLE, "")
    .normalize("NFKC")
    .replace(/[\u2010-\u2015\u2212\u30FB]/g, (c) => (c === "\u30FB" ? c : "-"))
    .replace(/(\d)\s*\u30FC|\u30FC\s*(?=\d)/g, (m, d) => `${d ?? ""}-`); // "ー" next to a digit is a dash

const KANJI = "〇零一二三四五六七八九十";
const MONTHS = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const SEP = "\\s*[-/.]\\s*";
const NOT_DIGIT = "(?:^|[^\\d])";

/** The shapes of a calendar date (after folding).  A bare "10/24" is left to the screen's own reader (relativizeDates). */
const DATES = [
  new RegExp(`${NOT_DIGIT}\\d{4}\\s*[-/]\\s*\\d{1,2}(?!\\d)`), // 2025-10, 2025/10/24, 1950-03
  new RegExp(`${NOT_DIGIT}\\d{4}${SEP}\\d{1,2}${SEP}\\d{1,2}(?!\\d)`), // 2025.10.24
  /\d{1,2}\s*月\s*\d{1,2}/, // 10月24日, 2月29日, 4月31日 (a date that never existed is still a date)
  /\d{4}\s*年\s*\d{1,2}\s*月/, // 2025年10月
  /(?:明治|大正|昭和|平成|令和)\s*(?:元|\d{1,2}|[〇零一二三四五六七八九十]{1,3})\s*年/, // 令和7年, 昭和25年生まれ
  new RegExp(`[${KANJI}]{4}\\s*年`), // 二〇二五年
  new RegExp(`[${KANJI}]{1,3}\\s*月\\s*[${KANJI}\\d]{1,3}`), // 十月二十四日, 十月24日
  new RegExp(`\\d{1,2}\\s*月\\s*[${KANJI}]{1,3}`), // 10月二十四日
  new RegExp(`(?:明治|大正|昭和|平成|令和)\\s*\\d{1,2}${SEP}\\d{1,2}${SEP}\\d{1,2}`), // 平成7-9-1
  // era letter + year.month.day (R7.10.24, s25-3-4): the month and the day must be possible, so that "T 36.5/37.2" is not read as a date
  new RegExp(`(?:^|[^A-Za-z])[MTSHRmtshr]\\s?\\d{1,2}${SEP}(?:0?[1-9]|1[0-2])${SEP}(?:0?[1-9]|[12]\\d|3[01])(?!\\d)`),
  new RegExp(`(?:^|[^A-Za-z])${MONTHS}[\\s./-]*\\d{1,2}(?:st|nd|rd|th)?(?![\\d])`, "i"), // Oct 24, October 24th, 2025-Oct-24, 2025/Sept / 1
  new RegExp(`(?:^|[^\\dA-Za-z])\\d{1,2}(?:st|nd|rd|th)?[\\s./-]*${MONTHS}(?![A-Za-z])`, "i"), // 24 Oct, 24-Oct-2025
  new RegExp(`(?:^|[^A-Za-z])${MONTHS}[\\s-]*\\d{4}(?!\\d)`, "i"), // 2025-Oct-24 is covered above by the month; Oct 2025
];

/** Phone-number shapes (after folding): 03-1234-5678, 03 1234 5678, 03(1234)5678, 0120 123 456, +81 3 1234 5678, 09012345678. */
const PHONES = [
  new RegExp(`${NOT_DIGIT}0\\d{1,4}[\\s().-]*\\d{1,4}[\\s().-]*\\d{3,4}(?!\\d)`),
  /\+\s*\d{1,3}[\s().-]*\d{1,4}[\s().-]*\d{2,4}[\s().-]*\d{3,4}(?!\d)/,
];
const digitCount = (s) => (s.match(/\d/g) ?? []).length;

const POSTAL = new RegExp(`${NOT_DIGIT}\\d{3}\\s*-\\s*\\d{4}(?!\\d)`);
const LONG_NUMBER = /\d(?:[\s-]*\d){11,}/; // twelve digits, however they are spaced
const EMAIL = /[A-Za-z0-9._%+-]+\s*@\s*[A-Za-z0-9-]+\s*\.\s*[A-Za-z0-9.-]+/;

const THREE = new RegExp(`${NOT_DIGIT}(\\d{1,2})${SEP}(\\d{1,2})${SEP}(\\d{2,4})(?!\\d)`, "g");
const okMonth = (n) => n >= 1 && n <= 12;
const okDay = (n) => n >= 1 && n <= 31;
/**
 * Three numbers in a row with date separators (24/10/2025, 10.24.2025, 25.10.24, 12/3/98) when they can be a date in some order: a 4-digit
 * year, or a 2-digit year with a possible month and day.  Three readings in a row (36.5/37.2/38.1, 94 / 96 / 98) are not.
 */
function hasNumericDate(f) {
  for (const m of f.matchAll(THREE)) {
    const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (m[3].length === 4) {
      if ((okMonth(a) && okDay(b)) || (okDay(a) && okMonth(b))) return true;
    } else if (m[3].length === 2) {
      if ((okMonth(b) && okDay(c)) || (okMonth(a) && okDay(b)) || (okDay(a) && okMonth(b))) return true;
    }
  }
  return false;
}

/** True when the (folded) text holds a phone-number shape of 9 to 11 digits. */
function hasPhone(f) {
  for (const re of PHONES) {
    const g = new RegExp(re.source, "g");
    for (const m of f.matchAll(g)) if (digitCount(m[0]) >= 9 && digitCount(m[0]) <= 15) return true;
  }
  return false;
}

/** The kinds of what is in the text that must not be sent: [] when nothing; kinds only, the matched text is never repeated. */
export function guardKinds(text) {
  const f = fold(text);
  const kinds = new Set();
  for (const src of [String(text ?? ""), f]) for (const h of scan(src)) kinds.add(h.label);
  if (DATES.some((re) => re.test(f)) || hasNumericDate(f) || relativizeDates(f).changes.length) kinds.add("日付");
  if (hasPhone(f)) kinds.add("電話番号らしき並び");
  if (POSTAL.test(f)) kinds.add("郵便番号らしき並び");
  if (LONG_NUMBER.test(f)) kinds.add("12桁以上の数字の並び");
  if (EMAIL.test(f)) kinds.add("メールアドレスらしき文字");
  return [...kinds];
}

/**
 * Why a text can not be sent as it is (kinds only).  `[]` = nothing stops it.  A text that holds a date says so in its own words (the doctor
 * rewrites it as "3日前"); the rest are "患者を特定できる情報の可能性（…）".
 */
export function blockersOf(text) {
  const out = [];
  if (!String(text ?? "").trim()) out.push("中身がありません");
  const kinds = guardKinds(text);
  const ids = kinds.filter((k) => k !== "日付");
  if (ids.length) out.push(`患者を特定できる情報の可能性（${ids.join("、")}）`);
  if (kinds.includes("日付")) out.push("日付が含まれています（「3日前」などの経過に直してください）");
  return out;
}
