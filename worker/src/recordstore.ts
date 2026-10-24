// Case records kept in D1 (the doctor's decision of 2026-10-24, docs/clinical-use.md 1e: a new table for a case that builds up across
// encounters, deleted a set number of days after its last update or by the doctor).  The fourth write path, after the daily counter
// (usage.ts), the evaluation questions (evalstore.ts) and the conversations (convstore.ts); the write list is pinned by
// worker/test/conversations.test.ts.
//
// What is stored: one JSON document per case (web/case-record.js builds it: the case as typed, the problems with stable ids, what
// the doctor carried from one encounter to the next).  The Worker does not read it as a model: it is a document store with limits.
// Dates are not in it (time is relative: docs/enhancement-plan.md 8.6) and nothing in it is derived by AI; adopted AI items carry
// their mark in the document.
//
// Safety, all at this entrance: every string value at any depth goes through the identifier check (kinds only are reported, the text
// never is); keys are restricted to a plain alphabet so text cannot be smuggled in a key; size, depth and count are limited; a save
// carries the revision it was based on and is refused (409) when another screen saved since.  Records expire `retentionDays` after
// their last update (the purge runs whenever the list is read or a record is read or saved; 0 = keep until deleted).
import { ID_RE } from "./convstore.ts";
import type { D1Rw } from "./evalstore.ts";
import { scanAll } from "./idguard.ts";

export const RECORD_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS case_records (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, rev INTEGER NOT NULL, payload TEXT NOT NULL)";

export const MAX_RECORDS = 30;
export const MAX_RECORD_PAYLOAD = 200_000;
export const MAX_TITLE = 80;
export const MAX_DEPTH = 8;
export const MAX_STRING = 8000;
export const RECORD_VERSION = 1;
/** A key is a plain name: it starts with a letter and holds no run of five or more digits (so an ID or a phone number cannot be a key). */
const KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const DIGIT_RUN = /\d{5,}/;
/** A number in a record is a lab value or a count; a number this large could be an ID or a phone number written as a number. */
export const MAX_NUMBER = 1e9;

export class RecordInputError extends Error {
  code: string;
  status: number;
  /** only for a conflict: the revision the store holds now */
  rev?: number;
  constructor(message: string, code = "bad_request", status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface RecordSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  rev: number;
}

export function recordStore(d1: D1Rw, opts: { retentionDays?: number } = {}) {
  const retention = Math.max(0, Math.floor(opts.retentionDays ?? 0));
  let ready: Promise<unknown> | null = null;
  const ensure = async () => {
    try {
      ready ??= d1.prepare(RECORD_TABLE_SQL).run();
      await ready;
    } catch (e) {
      ready = null;
      throw e;
    }
  };
  const run = (sql: string, ...v: unknown[]) => d1.prepare(sql).bind(...v).run();
  const first = <T>(sql: string, ...v: unknown[]) => d1.prepare(sql).bind(...v).first<T>();

  /** delete the records whose last update is older than the retention period */
  async function purge(now: string): Promise<void> {
    if (!retention) return;
    const cutoff = new Date(new Date(now).getTime() - retention * 86_400_000).toISOString();
    await run("DELETE FROM case_records WHERE updated_at < ?", cutoff);
  }

  return {
    retentionDays: retention,

    async list(now: string): Promise<RecordSummary[]> {
      await ensure();
      await purge(now);
      return (
        (await d1.prepare("SELECT id, title, created_at, updated_at, rev FROM case_records ORDER BY updated_at DESC LIMIT ?").bind(MAX_RECORDS).all<RecordSummary>()).results ?? []
      );
    },

    async get(id: string, now: string): Promise<(RecordSummary & { record: unknown }) | null> {
      if (!ID_RE.test(id)) return null;
      await ensure();
      await purge(now);
      const r = await first<RecordSummary & { payload: string }>("SELECT id, title, created_at, updated_at, rev, payload FROM case_records WHERE id = ?", id);
      if (!r) return null;
      const { payload, ...head } = r;
      return { ...head, record: safeParse(payload) };
    },

    /**
     * Creates the record (`rev` absent or 0) or replaces it (`rev` = the revision this edit was based on).  Returns the new revision.
     * A refusal writes nothing.
     */
    async put(id: string, input: { rev?: unknown; record: unknown }, now: string): Promise<{ rev: number; updated_at: string }> {
      if (!ID_RE.test(id)) throw new RecordInputError("bad record id");
      const record = check(input.record);
      const title = String((record as any).title).trim();
      const payload = JSON.stringify(record);
      if (payload.length > MAX_RECORD_PAYLOAD) throw new RecordInputError(`この記録は大きすぎます（${MAX_RECORD_PAYLOAD} 文字まで）`, "too_large", 413);
      const base = input.rev === undefined || input.rev === null ? 0 : input.rev;
      if (typeof base !== "number" || !Number.isInteger(base) || base < 0) throw new RecordInputError("rev must be a non-negative integer");

      await ensure();
      await purge(now);
      const cur = await first<{ rev: number }>("SELECT rev FROM case_records WHERE id = ?", id);
      if (cur) {
        if (base !== cur.rev) throw conflict(cur.rev);
        // the revision is checked again by the write itself (WHERE rev = ?): two saves that both read `rev` can not both win
        const res = await run("UPDATE case_records SET title = ?, payload = ?, updated_at = ?, rev = ? WHERE id = ? AND rev = ?", title, payload, now, cur.rev + 1, id, cur.rev);
        const changes = changesOf(res);
        if (changes === 0) throw conflict((await first<{ rev: number }>("SELECT rev FROM case_records WHERE id = ?", id))?.rev ?? cur.rev + 1);
        return { rev: cur.rev + 1, updated_at: now };
      }
      if (base !== 0) throw new RecordInputError("この記録は見つかりません（保持期間が過ぎたか、別の画面で終えた可能性があります）", "gone", 404);
      const n = Number((await first<{ n: number }>("SELECT COUNT(*) AS n FROM case_records"))?.n ?? 0);
      if (n >= MAX_RECORDS) throw new RecordInputError(`記録は ${MAX_RECORDS} 件までです。終えた症例を消してください`, "too_many_records", 409);
      try {
        await run("INSERT INTO case_records (id, title, created_at, updated_at, rev, payload) VALUES (?, ?, ?, ?, ?, ?)", id, title, now, now, 1, payload);
      } catch (e) {
        // another request made this id between the read and the insert
        if (/UNIQUE|PRIMARY KEY|constraint/i.test(String((e as Error)?.message ?? e))) throw conflict((await first<{ rev: number }>("SELECT rev FROM case_records WHERE id = ?", id))?.rev ?? 1);
        throw e;
      }
      return { rev: 1, updated_at: now };
    },

    /** "終える": deletes one record.  True when it existed. */
    async remove(id: string): Promise<boolean> {
      if (!ID_RE.test(id)) return false;
      await ensure();
      const had = await first("SELECT 1 AS x FROM case_records WHERE id = ?", id);
      await run("DELETE FROM case_records WHERE id = ?", id);
      return !!had;
    },

    async removeAll(): Promise<void> {
      await ensure();
      await run("DELETE FROM case_records");
    },
  };
}

function conflict(rev: number): RecordInputError {
  const e = new RecordInputError("別の画面で更新されています。開き直してください", "conflict", 409);
  e.rev = rev;
  return e;
}

/** Rows changed by a write: D1 reports `meta.changes`, the local SQLite `changes`.  Unknown means the check cannot be trusted: fail closed. */
function changesOf(res: unknown): number {
  const r = res as { meta?: { changes?: unknown }; changes?: unknown } | undefined;
  const n = r?.meta?.changes ?? r?.changes;
  if (typeof n !== "number") throw new Error("the database did not report how many rows a write changed");
  return n;
}

/** Validates a record document and returns it; throws RecordInputError (the identifier refusal names kinds only). */
export function check(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RecordInputError("record must be an object");
  const o = raw as Record<string, unknown>;
  if (o.v !== RECORD_VERSION) throw new RecordInputError(`record.v must be ${RECORD_VERSION}`);
  if (typeof o.title !== "string" || !o.title.trim() || o.title.length > MAX_TITLE) throw new RecordInputError(`record.title must be 1-${MAX_TITLE} characters`);
  const strings: string[] = [];
  walk(raw, 0, strings);
  const hits = scanAll(strings);
  if (hits.length) throw new RecordInputError(`患者を特定できる情報の可能性があるため、この記録は保存しません（${hits.map((h) => h.label).join("、")}）`, "possible_identifier");
  return raw;
}

function walk(v: unknown, depth: number, out: string[]): void {
  if (typeof v === "string") {
    if (v.length > MAX_STRING) throw new RecordInputError(`a text in the record is longer than ${MAX_STRING} characters`, "too_large", 413);
    out.push(v);
    return;
  }
  if (v === null || typeof v === "number" || typeof v === "boolean") {
    if (typeof v === "number" && (!Number.isFinite(v) || Math.abs(v) >= MAX_NUMBER)) throw new RecordInputError("record has a number that is not a plain value");
    return;
  }
  if (depth >= MAX_DEPTH) throw new RecordInputError(`record is nested deeper than ${MAX_DEPTH}`);
  if (Array.isArray(v)) {
    for (const x of v) walk(x, depth + 1, out);
    return;
  }
  if (typeof v !== "object") throw new RecordInputError("record has a value that is not JSON");
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!KEY_RE.test(k) || DIGIT_RUN.test(k)) throw new RecordInputError("record has a key that is not a plain name");
    out.push(k); // a key is checked like a value
    walk(x, depth + 1, out);
  }
}

function safeParse(s: unknown): unknown {
  try {
    return JSON.parse(String(s));
  } catch {
    return null;
  }
}
