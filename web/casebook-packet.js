// The Casebook packet made from a case record (docs/enhancement-plan.md 8.17; the doctor's decision of 2026-10-25, docs/clinical-use.md 1f).
// Pure functions: no DOM, no network, no storage, no AI, no randomness (the screen supplies the bytes), no clock.
//
// The packet is Casebook's hand-over format (clinical-casebook docs/contracts/handoff-packet.md, version 1; this file copies the codec of
// packages/core/src/handoff/codec.ts and the shapes of packet.ts that it uses, and tests/vectors/casebook-handoff.json pins the copy to
// Casebook's own fixtures).  RAG is a different origin from Casebook, so the packet travels by the clipboard / paste only (contract 5b).
//
// What the packet holds, and what it never does:
//  - Only what the doctor wrote or adopted, as it stands in the record: the case as typed, the problems, the diagnoses the doctor gave a
//    certainty to, the assessment / plan entries, the criteria to call, the admission texts, the day-by-day texts and trends.  Item kinds
//    used: problem, diagnosis, course, note.  Nothing is derived: a blank certainty sends no diagnosis, a plan is sent with its state in
//    the words ("計画（予定・検討）") and is never made a treatment that was started, no value is turned into a lab or a vital.
//  - Items from the AI draft keep `source: "ai"` (Casebook leaves them unselected until the doctor ticks them there).
//  - No calendar date: a text with a date is not sent.  Identifier-like text is not sent.  An outpatient case is not sent (it needs a date).
//  - A text longer than Casebook's limit is split at sentence ends and numbered (1/2, 2/2); it is never cut silently.
//  - The ids of the items are derived from the record's seed, so sending the same item again never makes a second one in Casebook.
import { isAgeYears } from "./case-model.js";
import { CODE_RE, KEY_RE, SENT_LIMIT } from "./casebook-state.js";
import { DAY_FIELDS, TREND } from "./case-course.js";
import { ADM_FIELDS, CERTAINTY, PLAN_STATES } from "./case-record.js";
import { blockersOf } from "./casebook-guard.js";

export const MAGIC = "CBH1";
export const SCHEMA_VERSION = 1;
export const PACKET_PREFIX = "CBH1:";
/** Casebook's limits (contract 3): items per packet, characters per text. */
export const MAX_ITEMS = 100;
export const MAX_TEXT = 500;
/** The most times a changed item is sent again as a new item (the revision is one digit in the mark). */
export const MAX_REV = 9;
export const SEX_OUT = { 男性: "M", 女性: "F", "その他・不明": "other" };
/** The settings a packet can carry from here.  An outpatient case needs the visit's calendar date, which this app never holds. */
export const SETTING_OUT = [
  { id: "emergency", label: "救急" },
  { id: "inpatient", label: "入院" },
];
export const SOURCE_LABEL = { ai: "AI の草案から採用", user: "先生が書いた" };

export const GROUPS = [
  { id: "ed", label: "救急の入力（入口の症例）" },
  { id: "problems", label: "問題・診断・評価・計画" },
  { id: "contingency", label: "コンサルト・医師コールの基準" },
  { id: "adm", label: "入院時の先生の欄" },
  { id: "course", label: "経過（日ごと）" },
];
/** What is not sent, in words (shown on the screen so the list is not mistaken for the whole record). */
export const NOT_SENT = [
  "検査値・バイタルの数値の項目（Casebook の検査項目名に合わせる対応表がないため。入力した文章は「経過」として送ります）",
  "病着からの時刻（経過分）、場面・症候の質問の答えの文面",
  "課題（結果待ちなど）、中間サマリー・退院時サマリーの欄、退院時の薬、主病名・副病名の区分",
  "書籍の頁・引用（どこを見たか）",
];

// ---------------------------------------------------------------- the codec (copy of Casebook's packages/core/src/handoff/codec.ts)
export function utf8Encode(text) {
  const out = [];
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0) ?? 0xfffd;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return Uint8Array.from(out);
}
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export function base64urlEncode(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64URL.charAt((n >> 18) & 63) + B64URL.charAt((n >> 12) & 63);
    if (i + 1 < bytes.length) out += B64URL.charAt((n >> 6) & 63);
    if (i + 2 < bytes.length) out += B64URL.charAt(n & 63);
  }
  return out;
}
let crcTable = null;
export function crc32(bytes) {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = (crcTable[(crc ^ b) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
/** "CBH1:" + base64url(UTF-8 of the JSON) + "." + CRC-32 (8 hex digits, of the UTF-8 of the base64url body). */
export function wrapPacket(json) {
  const body = base64urlEncode(utf8Encode(json));
  return `${PACKET_PREFIX}${body}.${crc32(utf8Encode(body)).toString(16).padStart(8, "0")}`;
}

// ---------------------------------------------------------------- ids
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
/** Casebook's ULID: 48-bit time + 80 random bits, 26 characters (packages/core/src/ids/ulid.ts).  `bytes` = 10 random bytes. */
export function ulidFrom(timeMs, bytes) {
  let time = "";
  let t = timeMs;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  let rest = "";
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      rest += ALPHABET.charAt((value >>> bits) & 31);
    }
    value &= (1 << bits) - 1;
  }
  return time + rest;
}
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
/** SHA-256 of a string (UTF-8), as 32 bytes.  Used only to derive ids from the seed, never for secrecy. */
export function sha256(text) {
  const msg = utf8Encode(text);
  const total = Math.ceil((msg.length + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[msg.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, Math.floor((msg.length * 8) / 0x100000000));
  view.setUint32(total - 4, (msg.length * 8) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  const out = new Uint8Array(32);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) dv.setUint32(i * 4, h[i]);
  return out;
}

/**
 * The id of an item, derived from the record's seed, the item's key and its revision: the same item is always the same id (sending it again
 * adds nothing to Casebook), and a different seed (another record, or after a reset) never gives the same id.  16 bytes of the SHA-256 as
 * a ULID (the first character 0-7, as the ULID format has it).
 */
export function itemIdOf(seed, key, rev = 0) {
  const d = sha256(`${seed}|${key}|${rev}`);
  let n = 0n;
  for (let i = 0; i < 16; i++) n = (n << 8n) | BigInt(d[i]);
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = ALPHABET.charAt(Number(n & 31n)) + out;
    n >>= 5n;
  }
  return out;
}

// ---------------------------------------------------------------- the candidate items
const TAGS = /\s*\[(?:推論|標準・出典未確認|施設依存)\]/g;
const CITES = /\s*［(?:書籍[^］]*|Web)］/g;
const AI_MARK = /〔AI草案〕/g;
/** One line: the words the doctor / the AI wrote, without the marks the screen adds (source tags, cited pages) and without line breaks. */
export const oneLine = (t) => String(t ?? "").replace(CITES, "").replace(TAGS, "").replace(AI_MARK, "").replace(/\s+/g, " ").trim();

/** `s` cut at most `n` UTF-16 units from the start, never between the two halves of a character. */
const cutAt = (s, n) => {
  let k = Math.min(n, s.length);
  if (k < s.length && k > 0 && s.charCodeAt(k - 1) >= 0xd800 && s.charCodeAt(k - 1) <= 0xdbff) k -= 1;
  return s.slice(0, k);
};

/**
 * The texts of one field: "<label>: <content>", or numbered pieces "<label>（1/2）: …" when it does not fit Casebook's limit (500 UTF-16
 * units, as its schema counts).  Splits after a sentence end (。！？!?; line breaks are already spaces) and, for a sentence that is too
 * long alone, in the middle.  Nothing is cut away: the pieces together hold the whole text.
 */
export function pieces(label, content, max = MAX_TEXT) {
  const body = oneLine(content);
  if (!body) return [];
  const whole = `${label}: ${body}`;
  if (whole.length <= max) return [whole];
  const budget = max - label.length - 12; // room for "（nn/nn）: "
  const parts = [];
  let cur = "";
  const push = (x) => {
    if (x.trim()) parts.push(x.trim());
  };
  for (const sentence of body.match(/[^。！？!?]+[。！？!?]*\s*|[。！？!?]+\s*/gu) ?? [body]) {
    let x = sentence;
    while (x.length > budget) {
      push(cur);
      cur = "";
      const cut = cutAt(x, budget);
      push(cut);
      x = x.slice(cut.length);
    }
    if (cur.length + x.length > budget) {
      push(cur);
      cur = x;
    } else cur += x;
  }
  push(cur);
  return parts.map((x, i) => `${label}（${i + 1}/${parts.length}）: ${x}`);
}

const hashOf = (c) => {
  let h = 0x811c9dc5;
  for (const ch of `${c.kind}|${c.status ?? ""}|${c.source}|${c.day}|${c.text}`) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // eight letters (a-p), one per four bits: no digit, so the Worker's identifier check (a run of digits, "ID" / "MRN" and digits) can never match a mark
  let out = "";
  for (let i = 0; i < 8; i++) out += String.fromCharCode(97 + ((h >>> (28 - 4 * i)) & 15));
  return out;
};

export { blockersOf };

const RULED_OUT = "除外した問題です（Casebook に「除外」を表す種類がないため、この問題と、その下の評価・計画は送れません）";
const DX_STATUS = { suspected: "suspected", likely: "suspected", confirmed: "confirmed" };
const CERT_LABEL = Object.fromEntries(CERTAINTY.map((c) => [c.id, c.label]));
const PLAN_LABEL = {
  planned: "計画（予定・検討）",
  done: "計画（実施の記録）",
  changed: "計画（変更）",
  stopped: "計画（中止・しない）",
};
for (const s of PLAN_STATES) if (!PLAN_LABEL[s.id]) PLAN_LABEL[s.id] = `計画（${s.label}）`;
const TREND_LABEL = Object.fromEntries(TREND.map((t) => [t.id, t.label]));

/**
 * Every item the record can offer, in screen order.  Each is { key, group, tag, kind, status?, day, source, text, problem?, blockers }:
 * `key` is stable (the same record item has the same key), `tag` the short name shown, `problem` the problem it belongs to ("p1").
 * An item with `blockers` can not be sent.  Nothing is judged here; a blank stays absent.
 */
export function candidates(rec) {
  const out = [];
  const add = (c) => out.push({ ...c, blockers: c.blockers ?? blockersOf(c.text) });
  const texts = (base, group, tag, kind, label, content, extra) => {
    // the whole text is checked, not only each piece: a date or a number cut in two by the split is in neither piece whole
    const whole = blockersOf(oneLine(content));
    pieces(label, content).forEach((text, i) => {
      const mine = extra?.blockers ?? [...new Set([...blockersOf(text), ...whole])];
      add({ key: `${base}.c${i + 1}`, group, tag, kind, text, ...extra, blockers: mine });
    });
  };

  // 1. the case as typed (the arrival day)
  const kase = rec.ed.case;
  for (const [field, label, kind] of [
    ["complaint", "主訴と経過", "course"],
    ["vitals", "バイタル", "course"],
    ["findings", "身体所見・検査", "course"],
    ["history", "既往・内服", "note"],
    ["own", "先生のアセスメント（入力）", "note"],
  ]) {
    texts(`ed.${field}`, "ed", label, kind, label, kase[field], { day: 1, source: "user" });
  }

  // 2. problems, with their diagnoses, assessments, plans and trends
  for (const p of rec.problems) {
    const ai = p.ai === true ? "ai" : "user";
    const name = oneLine(p.label);
    // Casebook has no kind for "ruled out": a problem the doctor ruled out is not put in its problem list, and what is written under it is not sent
    // (a note about a problem that is not there would read as something else)
    const ruled = p.certainty === "ruled_out";
    const under = ruled ? { blockers: [RULED_OUT] } : {};
    add({ key: `p.${p.id}`, group: "problems", tag: "問題", kind: "problem", day: p.added ?? 1, source: ai, text: name, problem: p.id, ...(ruled ? { blockers: [RULED_OUT, ...blockersOf(name)] } : {}) });
    if (ruled) {
      add({ key: `p.${p.id}.dx`, group: "problems", tag: `診断（${CERT_LABEL.ruled_out}）`, kind: "diagnosis", day: p.added ?? 1, source: ai, text: name, problem: p.id, blockers: [RULED_OUT] });
    } else if (DX_STATUS[p.certainty]) {
      const dxDay = (p.cert_log ?? []).filter((l) => l.certainty === p.certainty).at(-1)?.day ?? p.added ?? 1;
      const status = DX_STATUS[p.certainty];
      add({ key: `p.${p.id}.dx`, group: "problems", tag: `診断（${status === "confirmed" ? "確定" : p.certainty === "likely" ? "可能性が高い→疑いとして" : "疑い"}）`, kind: "diagnosis", status, day: dxDay, source: ai, text: name, problem: p.id });
    }
    for (const e of p.assess) texts(`p.${p.id}.assess.${e.id}`, "problems", "評価", "note", "評価", e.text, { day: e.added ?? 1, source: e.from === "ai" ? "ai" : "user", problem: p.id, ...under });
    for (const e of p.plan) {
      const state = e.state ?? "planned";
      const body = e.reason ? `${oneLine(e.text)}（理由: ${oneLine(e.reason)}）` : e.text;
      // the day is the day the doctor recorded the state (a plan marked "done" on day 5 is not a fact of day 1)
      const recorded = e.log?.length ? e.log.at(-1).day : e.added ?? 1;
      texts(`p.${p.id}.plan.${e.id}`, "problems", PLAN_LABEL[state] ?? PLAN_LABEL.planned, "note", PLAN_LABEL[state] ?? PLAN_LABEL.planned, body, { day: recorded, source: e.from === "ai" ? "ai" : "user", problem: p.id, ...under });
    }
    for (const d of rec.course.days) {
      const t = d.trend?.[p.id];
      if (!t) continue;
      const body = [TREND_LABEL[t.state] ?? "", t.note ? `（${oneLine(t.note)}）` : ""].join("");
      texts(`p.${p.id}.trend.d${d.day}`, "problems", "推移", "note", "推移", body, { day: d.day, source: "user", problem: p.id, ...under });
    }
  }

  // 3. the criteria to call or consult
  for (const e of rec.contingency) texts(`cont.${e.id}`, "contingency", "コール基準", "note", "コンサルト・医師コールの基準", e.text, { day: e.added ?? 1, source: e.from === "ai" ? "ai" : "user" });

  // 4. the doctor's admission texts
  for (const f of ADM_FIELDS) texts(`adm.${f.key}`, "adm", f.label, "note", f.label, rec.adm[f.key], { day: 1, source: "user" });

  // 5. the day-by-day texts
  for (const d of rec.course.days) {
    for (const f of DAY_FIELDS) texts(`day.d${d.day}.${f.key}`, "course", f.label, "course", f.label, d[f.key], { day: d.day, source: "user" });
  }
  for (const c of out) if (!KEY_RE.test(c.key)) c.blockers = [...c.blockers, "項目の名前の形が合いません"];
  // the marks and the revisions have limits; at the limit an item is said to be unsendable rather than sent in a way Casebook would skip
  const marked = Object.keys(rec.casebook?.sent ?? {}).length;
  return out.map((c) => {
    const h = hashOf(c);
    const m = rec.casebook?.sent?.[c.key];
    const more = [];
    if (m && m.h !== h && m.r >= MAX_REV) more.push(`直して送り直した回数が上限（${MAX_REV}回）です。Casebook で直してください`);
    if (!m && marked >= SENT_LIMIT - MAX_ITEMS) more.push("送信済みの印の上限に近づいています（症例コードと印を消して、新しい症例として送り直してください）");
    return { ...c, h, blockers: more.length ? [...c.blockers, ...more] : c.blockers };
  });
}

// ---------------------------------------------------------------- what was sent, what changed since
/** "new" (never marked), "sent" (marked, same words), "changed" (marked, but the doctor changed it since). */
export function stateOf(rec, c) {
  const m = rec.casebook?.sent?.[c.key];
  if (!m) return "new";
  return m.h === c.h ? "sent" : "changed";
}
/** The revision an item is sent with: its marked one, or the next one when a changed item is sent again as a new item. */
export function revOf(rec, c, resend = false) {
  const m = rec.casebook?.sent?.[c.key];
  if (!m) return 0;
  return resend && m.h !== c.h ? Math.min(MAX_REV, m.r + 1) : m.r;
}
/** What is ticked when the screen opens: not sent yet, nothing stops it, not from the AI (those are ticked by the doctor). */
export const ticked = (rec, c) => c.blockers.length === 0 && stateOf(rec, c) === "new" && c.source !== "ai";

// ---------------------------------------------------------------- the packet
/** The patient block of a new case from what the record has: the fields are null where the case does not say (the doctor fills them). */
export function patientDefaults(rec) {
  const c = rec.ed.case;
  return {
    ageYears: isAgeYears(c.age) ? Number(c.age) : null,
    sex: SEX_OUT[c.sex] ?? null,
    setting: c.setting === "救急" ? "emergency" : c.setting === "病棟" ? "inpatient" : null,
  };
}

const PRIORITY = { problem: 0, diagnosis: 1 };

/**
 * Builds the packet for the items whose keys are ticked.
 *  opts: { mode: "new" | "append", code (append), patient {ageYears, sex, setting} (new), synthetic: true | false (new; null = not chosen),
 *          keys: ticked keys, resend: keys of changed items to send again as new items, packetId: a ULID the screen made }
 * Returns { ok, errors, text, json, entries }.  `entries` are the marks to write once the doctor says Casebook has taken the packet in.
 */
export function buildPacket(rec, opts) {
  const errors = [];
  const seed = rec.casebook?.seed ?? "";
  if (!seed) errors.push("項目の ID の元（seed）がありません");
  const mode = opts.mode === "append" ? "append" : "new";
  const patient = opts.patient ?? {};
  if (mode === "new") {
    if (!(Number.isInteger(patient.ageYears) && patient.ageYears >= 0 && patient.ageYears <= 130)) errors.push("年齢（0〜130 の歳）を入れてください");
    if (!["M", "F", "other"].includes(patient.sex)) errors.push("性別を選んでください");
    if (!SETTING_OUT.some((s) => s.id === patient.setting)) errors.push("場面（救急・入院）を選んでください。外来の症例は受診日が要るため送れません");
    if (opts.synthetic !== true && opts.synthetic !== false) errors.push("実症例か架空症例かを選んでください");
  } else if (!CODE_RE.test(String(opts.code ?? ""))) errors.push("Casebook の症例コード（6文字）を入れてください");
  if (rec.ed?.case?.setting === "外来") errors.push("症例の場面が外来です。外来の症例は受診日（暦日）が要るため送れません（症例の場面を直してください）");
  if (!ULID_RE.test(String(opts.packetId ?? ""))) errors.push("パケットの ID がありません");

  const keys = new Set(opts.keys ?? []);
  const resend = new Set(opts.resend ?? []);
  const all = candidates(rec);
  const chosen = all.filter((c) => keys.has(c.key));
  if (chosen.length === 0) errors.push("送る項目を選んでください");
  if (chosen.length > MAX_ITEMS) errors.push(`1回に送れるのは ${MAX_ITEMS} 項目までです（${chosen.length} 項目）`);
  if (chosen.some((c) => c.blockers.length)) errors.push("送れない項目が選ばれています");
  if (chosen.some((c) => stateOf(rec, c) === "sent")) errors.push("送信済みの項目が選ばれています");
  if (chosen.some((c) => stateOf(rec, c) === "changed" && !resend.has(c.key))) errors.push("送信後に直した項目は、「新しい項目として送る」を選ぶと送れます");
  if (errors.length) return { ok: false, errors, text: "", json: null, entries: [] };

  const idOf = (key, c, again) => itemIdOf(seed, key, revOf(rec, c, again));
  const problemIds = new Map(all.filter((c) => c.kind === "problem").map((c) => [c.problem, itemIdOf(seed, c.key, revOf(rec, c, resend.has(c.key)))]));
  const entries = [];
  const items = chosen
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (PRIORITY[a.c.kind] ?? 2) - (PRIORITY[b.c.kind] ?? 2) || a.i - b.i)
    .map(({ c }) => {
      const again = resend.has(c.key);
      const rev = revOf(rec, c, again);
      entries.push({ key: c.key, h: c.h, r: rev });
      const body =
        c.kind === "problem" ? { kind: "problem", text: c.text } : c.kind === "diagnosis" ? { kind: "diagnosis", text: c.text, status: c.status } : { kind: c.kind, text: c.text };
      const item = { itemId: idOf(c.key, c, again), day: c.day, source: c.source, body };
      if (c.problem && c.kind !== "problem" && c.kind !== "diagnosis" && problemIds.has(c.problem)) item.problemId = problemIds.get(c.problem);
      return item;
    });
  const json = {
    magic: MAGIC,
    schemaVersion: SCHEMA_VERSION,
    packetId: opts.packetId,
    target: mode === "new" ? { mode: "new" } : { mode: "append", caseCode: opts.code },
    ...(mode === "new" ? { patient: { ageYears: patient.ageYears, sex: patient.sex, setting: patient.setting } } : {}),
    ...(mode === "new" && opts.synthetic === true ? { synthetic: true } : {}),
    ...(mode === "new" ? { hospitalDay: rec.course?.today ?? 1 } : {}),
    items,
  };
  const bad = validatePacket(json);
  if (bad.length) return { ok: false, errors: bad.map((b) => `パケットの形の検査: ${b}`), text: "", json: null, entries: [] };
  return { ok: true, errors: [], text: wrapPacket(JSON.stringify(json)), json, entries };
}

/**
 * The shape rules of Casebook's packet.ts for the part this file makes (problem, diagnosis, course, note; day; problemId; patient;
 * synthetic).  Returns the list of what is wrong (empty = fine).  A last check before the doctor sees the packet, and the tests' oracle
 * next to Casebook's own decoder.
 */
export function validatePacket(p) {
  const bad = [];
  const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(p)) return ["パケットがオブジェクトではない"];
  const allowed = new Set(["magic", "schemaVersion", "packetId", "target", "patient", "synthetic", "hospitalDay", "items"]);
  for (const k of Object.keys(p)) if (!allowed.has(k)) bad.push(`知らない欄: ${k}`);
  if (p.magic !== MAGIC) bad.push("magic");
  if (p.schemaVersion !== SCHEMA_VERSION) bad.push("schemaVersion");
  if (!ULID_RE.test(String(p.packetId))) bad.push("packetId");
  const mode = p.target?.mode;
  if (mode !== "new" && mode !== "append") bad.push("target.mode");
  if (mode === "append" && !CODE_RE.test(String(p.target.caseCode))) bad.push("target.caseCode");
  if (mode === "new" && Object.keys(p.target).length !== 1) bad.push("target");
  if (mode === "new") {
    const pt = p.patient;
    if (!isObj(pt) || !(Number.isInteger(pt.ageYears) && pt.ageYears >= 0 && pt.ageYears <= 130) || !["M", "F", "other"].includes(pt.sex) || !["inpatient", "outpatient", "emergency"].includes(pt.setting)) bad.push("patient");
    if (pt?.setting === "outpatient") bad.push("patient.setting（外来は送れない）");
  } else if (p.patient !== undefined) bad.push("patient は新しい症例だけ");
  if (p.synthetic !== undefined && (p.synthetic !== true || mode !== "new")) bad.push("synthetic は new の true だけ");
  if (p.hospitalDay !== undefined && !(Number.isInteger(p.hospitalDay) && p.hospitalDay >= 1 && p.hospitalDay <= 3650)) bad.push("hospitalDay");
  if (!Array.isArray(p.items) || p.items.length < 1 || p.items.length > MAX_ITEMS) bad.push("items の数");
  const ids = new Set();
  for (const [i, it] of (Array.isArray(p.items) ? p.items : []).entries()) {
    const at = `items[${i}]`;
    if (!isObj(it)) {
      bad.push(at);
      continue;
    }
    for (const k of Object.keys(it)) if (!["itemId", "day", "date", "problemId", "afterMin", "source", "body"].includes(k)) bad.push(`${at}.${k}`);
    if (!ULID_RE.test(String(it.itemId)) || ids.has(it.itemId)) bad.push(`${at}.itemId`);
    ids.add(it.itemId);
    if (!Number.isInteger(it.day) || it.day < -3650 || it.day > 3650) bad.push(`${at}.day`);
    if (!["rule", "user", "ai"].includes(it.source)) bad.push(`${at}.source`);
    const b = it.body;
    if (!isObj(b) || !["problem", "diagnosis", "course", "note"].includes(b.kind)) {
      bad.push(`${at}.body.kind`);
      continue;
    }
    const keys = Object.keys(b).sort().join(",");
    const want = b.kind === "diagnosis" ? "kind,status,text" : "kind,text";
    if (keys !== want) bad.push(`${at}.body の欄`);
    if (typeof b.text !== "string" || !b.text.trim() || b.text.length > MAX_TEXT) bad.push(`${at}.body.text`);
    if (b.kind === "diagnosis" && b.status !== "suspected" && b.status !== "confirmed") bad.push(`${at}.body.status`);
    if (it.problemId !== undefined) {
      if (!ULID_RE.test(String(it.problemId))) bad.push(`${at}.problemId`);
      if (b.kind === "problem" || b.kind === "diagnosis") bad.push(`${at}.problemId はプロブレム・診断に付けない`);
    }
  }
  return bad;
}
