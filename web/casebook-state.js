// What a case record remembers about sending to Casebook (docs/enhancement-plan.md 8.17; the doctor's decision of 2026-10-25, docs/clinical-use.md 1f).
// Pure functions over a record (no DOM, no network, no storage, no AI, no imports); every change returns a new record.
//
//   seed   letters only; the item ids sent to Casebook are derived from it (the same record item gets the same id every time, so sending
//          again never makes a second copy in Casebook).  Made once, from random bytes the screen supplies.
//   code   the case code Casebook shows when it has taken a new case in ("" until the doctor types it); with it the next send is an append.
//   sent   what the doctor said Casebook has taken: { <item key>: { h: hash of what was sent, r: revision } }.  A mark is written only when the
//          doctor presses "取り込みました" — copying the packet is not a mark.
//   count  how many packets were marked as taken in.
// None of it is a date: the marks carry no time.

export const SENT_LIMIT = 300;
export const SEED_RE = /^[a-z]{10}$/;
/** Casebook's case code (packages/core/src/ids/case-code.ts CASE_CODE_PATTERN): six letters/digits without 0 O 1 I L U. */
export const CODE_RE = /^[2-9A-HJKMNP-TV-Z]{6}$/;
/** An item key: plain letters, digits, "." and "-" (a record's keys are checked by the Worker, which allows only these; no run of 5 digits). */
export const KEY_RE = /^[a-z][a-z0-9.-]{0,62}$/;
const HASH_RE = /^[0-9a-z]{1,8}$/;

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

export const emptyCasebook = () => ({ seed: "", code: "", sent: {}, count: 0 });

/** The case code as typed: spaces out, capitals ("abc234" -> "ABC234"). */
export const normalizeCode = (text) => String(text ?? "").normalize("NFKC").replace(/\s+/g, "").toUpperCase();

/** A seed from ten random bytes (the screen supplies them: this file touches no randomness). Letters only, so no run of digits can form. */
export function newSeed(bytes) {
  let out = "";
  for (let i = 0; i < 10; i++) out += String.fromCharCode(97 + ((bytes?.[i] ?? 0) % 26));
  return out;
}

/** The state read back from a saved record (or any untrusted shape): known keys only, values checked. */
export function cleanCasebook(raw) {
  const out = emptyCasebook();
  if (!isObj(raw)) return out;
  if (typeof raw.seed === "string" && SEED_RE.test(raw.seed)) out.seed = raw.seed;
  if (typeof raw.code === "string" && CODE_RE.test(raw.code)) out.code = raw.code;
  if (Number.isInteger(raw.count) && raw.count >= 0 && raw.count < 10_000) out.count = raw.count;
  if (isObj(raw.sent)) {
    for (const [k, v] of Object.entries(raw.sent).slice(0, SENT_LIMIT)) {
      if (!KEY_RE.test(k) || !isObj(v) || typeof v.h !== "string" || !HASH_RE.test(v.h)) continue;
      out.sent[k] = { h: v.h, r: Number.isInteger(v.r) && v.r >= 0 && v.r <= 9 ? v.r : 0 };
    }
  }
  return out;
}

const clone = (o) => structuredClone(o);
const withState = (rec) => {
  const next = clone(rec);
  next.casebook = cleanCasebook(next.casebook);
  return next;
};

/** The seed, made from `bytes` the first time it is needed. */
export function ensureSeed(rec, bytes) {
  const next = withState(rec);
  if (!next.casebook.seed) next.casebook.seed = newSeed(bytes);
  return next;
}

/** Sets the case code Casebook showed ("" clears it).  Returns { rec, ok } (ok: false when it is not a case code). */
export function setCode(rec, text) {
  const code = normalizeCode(text);
  const next = withState(rec);
  if (code === "") {
    next.casebook.code = "";
    return { rec: next, ok: true };
  }
  if (!CODE_RE.test(code)) return { rec: next, ok: false };
  next.casebook.code = code;
  return { rec: next, ok: true };
}

/** Records that Casebook has taken these items in: entries = [{ key, h, r }].  The packet counts once. */
export function markSent(rec, entries) {
  const next = withState(rec);
  for (const e of entries) {
    if (!KEY_RE.test(e.key) || !HASH_RE.test(e.h)) continue;
    next.casebook.sent[e.key] = { h: e.h, r: Number.isInteger(e.r) && e.r >= 0 && e.r <= 9 ? e.r : 0 };
  }
  if (entries.length) next.casebook.count = Math.min(9999, next.casebook.count + 1);
  return next;
}

/** Forgets the case code and every mark, and starts a new seed (for sending the record as another, new case). */
export function resetCasebook(rec, bytes) {
  const next = withState(rec);
  next.casebook = { ...emptyCasebook(), seed: newSeed(bytes) };
  return next;
}
