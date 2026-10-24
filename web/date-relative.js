// Calendar dates -> relative expressions (the doctor's decision of 2026-10-24, docs/clinical-use.md 1e): a case never carries an
// absolute date.  "10/20に入院、10/22に発熱" becomes "4日前に入院、入院3日目に発熱"; without an admission date, "10/22" is "2日前".
// Pure and deterministic: the only inputs are the text and today's date (Japan time).  Only a date with a day is converted (a year
// or a year and month alone, such as a guideline's edition, is left as it is).  Times of day are not touched.
//
// Reference points: today is "今日"; an admission date is the date written next to 入院 ("10/20に入院", "入院日: 10/20"); with one,
// a date on or after it (up to today) is "入院N日目" (the admission day is day 1), an earlier one "入院のN日前", a later one "N日後".
// A date without a year is the latest such date that is not after today (or within 14 days after it: a planned date).

const DAY = 86_400_000;
const ERA = { 令和: 2018, 平成: 1988, 昭和: 1925 };

const D = "\\d{1,2}";
// the forms that are read as a date
const FULL = `(?<![0-9])(\\d{4})\\s*[年/.\\-]\\s*(${D})\\s*[月/.\\-]\\s*(${D})(?![0-9])(?:\\s*日)?`;
const JERA = `(令和|平成|昭和)\\s*(\\d{1,2})\\s*[年.]\\s*(${D})\\s*[月.]\\s*(${D})(?![0-9])(?:\\s*日)?`;
const MDJ = `(?<![0-9])(${D})\\s*月\\s*(${D})\\s*日`;
// "10/20" alone is also a fraction ("2/3"): it is read as a date only with a cue next to it.  A strong cue is a date label before it
// ("入院日: 10/20") or an event / time-of-day word after it ("10/22 発熱", "10/22 22:10"); a weak cue is only a particle ("10/22に",
// "10/22から"), and with a weak cue alone a day of 5 or less ("1/2に減量", "2/3から") is kept as a fraction.
const LABEL = "(?:入院|発症|受診|来院|搬送|手術|退院|開始|施行|採血|撮影|検査|診断|日付|日時)日?\\s*[:：は]?\\s*[（(]?\\s*";
const STRONG = "(?:入院|受診|来院|搬送|発症|発熱|手術|開始|施行|退院|朝|昼|夕|夜|午前|午後|[（(]|\\d{1,2}:\\d{2})";
const WEAK = "(?:から|より|に|頃|ごろ|時点|以降|以前|まで)";
const MDS = `(?<![0-9/.])(?:(?<=${LABEL})(?=${D}/${D}(?![0-9/]))|(?=${D}/${D}(?![0-9/])\\s*(?:${STRONG}|${WEAK})))(${D})/(${D})(?![0-9/])`;
const DATE_RE = new RegExp(`${FULL}|${JERA}|${MDJ}|${MDS}`, "gu");

/** Today's date in Japan as { y, m, d } and as a day number. */
function jst(now) {
  const [y, m, d] = now.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }).split("-").map(Number);
  return { y, m, d, t: Date.UTC(y, m - 1, d) };
}
const valid = (y, m, d) => {
  const t = Date.UTC(y, m - 1, d);
  const x = new Date(t);
  return m >= 1 && m <= 12 && d >= 1 && d <= 31 && x.getUTCMonth() === m - 1 && x.getUTCDate() === d ? t : null;
};

/** One regex match -> its day number, or null when it is not a real date. `today` fixes a missing year. */
function dayOf(m, today) {
  if (m[1] !== undefined) return valid(Number(m[1]), Number(m[2]), Number(m[3])); // 2026/10/24, 2026年10月24日
  if (m[4] !== undefined) return valid(ERA[m[4]] + Number(m[5]), Number(m[6]), Number(m[7])); // 令和8年10月24日
  const mo = Number(m[8] ?? m[10]); // 10月24日, 10/24
  const da = Number(m[9] ?? m[11]);
  let t = valid(today.y, mo, da);
  if (t === null) return null;
  if (t > today.t + 14 * DAY) t = valid(today.y - 1, mo, da);
  return t;
}

/** "N日前" / "約Nか月前" / "約N年前", for a date n days before today (n < 0: after). */
function before(n) {
  if (n === 0) return "今日";
  const k = Math.abs(n);
  const months = Math.round(k / 30);
  const s = k <= 90 ? `${k}日` : months < 24 ? `約${months}か月` : `約${Math.round(k / 365)}年`;
  return n > 0 ? `${s}前` : `${s}後`;
}

const LABEL_BEFORE = new RegExp(`${LABEL}$`);
const STRONG_AFTER = new RegExp(`^\\s*(?:から|より|に|は)?\\s*${STRONG}`); // "11/2に手術予定": a particle, then an event word

/** "1/2に" or "2/3から": the slash form (no year, no 月) with a weak cue only and a day of 5 or less is a fraction, not a date. */
function isFraction(src, m) {
  if (m[10] === undefined) return false;
  if (Number(m[11]) > 5) return false;
  return !LABEL_BEFORE.test(src.slice(Math.max(0, m.index - 14), m.index)) && !STRONG_AFTER.test(src.slice(m.index + m[0].length));
}

const ADMIT_AFTER = /^\s*(?:に|で)?\s*入院/;
const ADMIT_BEFORE = /入院(?:日|時)?\s*[:：は]?\s*[（(]?\s*$/;

export function relativizeDates(text, { now = new Date() } = {}) {
  const src = String(text ?? "");
  const today = jst(now);
  const found = [...src.matchAll(DATE_RE)].map((m) => ({ m, day: isFraction(src, m) ? null : dayOf(m, today), at: m.index, len: m[0].length }));
  if (!found.some((f) => f.day !== null)) return { text: src, changes: [] };
  // the admission date: the first date written next to 入院
  let adm = null;
  for (const f of found) {
    if (f.day === null) continue;
    if (ADMIT_AFTER.test(src.slice(f.at + f.len)) || ADMIT_BEFORE.test(src.slice(Math.max(0, f.at - 12), f.at))) {
      adm = f.day;
      break;
    }
  }
  const phrase = (day) => {
    if (adm !== null && day >= adm && day <= today.t) return `入院${Math.round((day - adm) / DAY) + 1}日目`;
    if (adm !== null && day < adm) return `入院の${Math.round((adm - day) / DAY)}日前`;
    return before(Math.round((today.t - day) / DAY));
  };
  let out = "";
  let last = 0;
  const changes = [];
  for (const f of found) {
    if (f.day === null || f.at < last) continue;
    out += src.slice(last, f.at);
    let end = f.at + f.len;
    let to;
    const adj = ADMIT_AFTER.exec(src.slice(end));
    if (adm !== null && f.day === adm && adj) {
      // "10/20に入院" -> "4日前に入院" (not "入院1日目に入院")
      to = `${before(Math.round((today.t - f.day) / DAY))}に入院`;
      end += adj[0].length;
    } else if (adm !== null && f.day === adm && ADMIT_BEFORE.test(src.slice(Math.max(0, f.at - 12), f.at))) {
      to = before(Math.round((today.t - f.day) / DAY)); // "入院日: 10/20" -> "入院日: 4日前"
    } else to = phrase(f.day);
    changes.push({ from: src.slice(f.at, end).trim(), to });
    out += to;
    last = end;
  }
  return { text: out + src.slice(last), changes };
}
