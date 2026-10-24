// Evaluation questions kept in D1 so the evaluation can be written and run from the iPad (doctor's decision,
// 2026-10-24: docs/clinical-use.md 1c).  The second write path after the daily counter (usage.ts).  What is stored: one
// JSON line per question in the eval/clinical.template.jsonl format.  Every line passes the same check as the PC tools
// (eval/lib.ts parseQuestions: no identifier-like text, no template placeholders) before it is written.  Answers and
// evaluation results are never stored.
import { parseQuestions, type Question } from "../../eval/lib.ts";

/** The subset of D1Database used for writes (lets tests run the same SQL on node:sqlite). */
export interface D1Rw {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      all<T = unknown>(): Promise<{ results?: T[] }>;
      first<T = unknown>(): Promise<T | null>;
    };
    run(): Promise<unknown>;
  };
}

export interface StoredQuestion {
  id: string;
  line: string;
  updated_at: string;
}

export const EVAL_TABLE_SQL = "CREATE TABLE IF NOT EXISTS eval_questions (id TEXT PRIMARY KEY, line TEXT NOT NULL, updated_at TEXT NOT NULL)";
export const MAX_QUESTIONS = 300;
export const MAX_LINE = 4000;
export const ID_RE = /^[A-Za-z0-9._-]{1,40}$/;

export class EvalInputError extends Error {}

/** One question line: parsed with the PC tools' checks, its id checked for use in a URL, re-serialised canonically. */
export function checkLine(line: unknown, id?: string): { q: Question; line: string } {
  if (typeof line !== "string" || !line.trim()) throw new EvalInputError("line must be one JSON object");
  if (line.length > MAX_LINE) throw new EvalInputError(`line is longer than ${MAX_LINE} characters`);
  let qs: Question[];
  try {
    qs = parseQuestions(line.trim());
  } catch (e) {
    throw new EvalInputError((e as Error).message);
  }
  if (qs.length !== 1) throw new EvalInputError("line must hold exactly one question");
  const q = qs[0];
  if (!ID_RE.test(q.id)) throw new EvalInputError('"id" may use letters, digits, ".", "_" and "-" (at most 40)');
  if (id !== undefined && q.id !== id) throw new EvalInputError(`"id" in the line (${q.id}) differs from the address (${id})`);
  return { q, line: JSON.stringify(JSON.parse(line.trim())) };
}

export function evalStore(d1: D1Rw) {
  let ready: Promise<unknown> | null = null;
  const ensure = async () => {
    try {
      ready ??= d1.prepare(EVAL_TABLE_SQL).run();
      await ready;
    } catch (e) {
      ready = null;
      throw e;
    }
  };
  const count = async () => Number((await d1.prepare("SELECT COUNT(*) AS n FROM eval_questions").bind().first<{ n: number }>())?.n ?? 0);
  const upsert = (id: string, line: string, now: string) =>
    d1
      .prepare("INSERT INTO eval_questions (id, line, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET line = excluded.line, updated_at = excluded.updated_at")
      .bind(id, line, now)
      .run();
  return {
    async list(): Promise<StoredQuestion[]> {
      await ensure();
      return (await d1.prepare("SELECT id, line, updated_at FROM eval_questions ORDER BY id").bind().all<StoredQuestion>()).results ?? [];
    },
    async get(id: string): Promise<StoredQuestion | null> {
      await ensure();
      return d1.prepare("SELECT id, line, updated_at FROM eval_questions WHERE id = ?").bind(id).first<StoredQuestion>();
    },
    async put(id: string, rawLine: unknown, now: string): Promise<Question> {
      const { q, line } = checkLine(rawLine, id);
      await ensure();
      const exists = await d1.prepare("SELECT 1 AS x FROM eval_questions WHERE id = ?").bind(id).first();
      if (!exists && (await count()) >= MAX_QUESTIONS) throw new EvalInputError(`at most ${MAX_QUESTIONS} questions`);
      await upsert(id, line, now);
      return q;
    },
    async remove(id: string): Promise<boolean> {
      await ensure();
      const had = await d1.prepare("SELECT 1 AS x FROM eval_questions WHERE id = ?").bind(id).first();
      await d1.prepare("DELETE FROM eval_questions WHERE id = ?").bind(id).run();
      return !!had;
    },
    /** All or nothing: one bad line rejects the whole paste, with every problem listed. */
    async importText(text: unknown, now: string): Promise<number> {
      if (typeof text !== "string" || !text.trim()) throw new EvalInputError("paste one question per line (JSON Lines)");
      let qs: Question[];
      try {
        qs = parseQuestions(text);
      } catch (e) {
        throw new EvalInputError((e as Error).message);
      }
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
      const checked = lines.map((l) => checkLine(l));
      await ensure();
      const existing = new Set((await this.list()).map((s) => s.id));
      const added = checked.filter((c) => !existing.has(c.q.id)).length;
      if (existing.size + added > MAX_QUESTIONS) throw new EvalInputError(`at most ${MAX_QUESTIONS} questions`);
      for (const c of checked) await upsert(c.q.id, c.line, now);
      return qs.length;
    },
  };
}
