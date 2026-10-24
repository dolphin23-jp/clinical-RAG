// Conversations kept in D1 so a conversation survives closing or reloading the app (doctor's decision, 2026-10-24:
// docs/clinical-use.md 1d).  The third write path, after the daily counter (usage.ts) and the evaluation questions
// (evalstore.ts); the write list is pinned by worker/test/writes.test.ts.
//
// What is stored: per turn the question, the answer text and a payload (the citation chips, the sections found, the
// number check) so the screen can be rebuilt as it was.  Never stored: a question the doctor confirmed through the
// identifier check (the screen does not send it, and this store refuses identifier-like text in a question on its own),
// the API key, usage totals beyond what the footer shows.  Conversations expire after `retentionDays` without a new turn
// (the purge runs whenever the list is read or a turn is added; 0 = keep until deleted).
import { scanAll } from "./idguard.ts";
import type { D1Rw } from "./evalstore.ts";

export const CONV_TABLE_SQL = "CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)";
export const TURN_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS conv_turns (conv_id TEXT NOT NULL, seq INTEGER NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (conv_id, seq))";

export const MAX_CONVERSATIONS = 200;
export const MAX_TURNS = 100;
export const MAX_QUESTION = 4000;
export const MAX_ANSWER = 100_000;
export const MAX_PAYLOAD = 300_000;
export const TITLE_CHARS = 40;
export const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export class ConvInputError extends Error {
  code: string;
  constructor(message: string, code = "bad_request") {
    super(message);
    this.code = code;
  }
}

export interface ConvSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  turns: number;
}
export interface ConvTurn {
  seq: number;
  question: string;
  answer: string;
  payload: unknown;
  created_at: string;
}

export function convStore(d1: D1Rw, opts: { retentionDays?: number } = {}) {
  const retention = Math.max(0, Math.floor(opts.retentionDays ?? 0));
  let ready: Promise<unknown> | null = null;
  const ensure = async () => {
    try {
      ready ??= (async () => {
        await d1.prepare(CONV_TABLE_SQL).run();
        await d1.prepare(TURN_TABLE_SQL).run();
      })();
      await ready;
    } catch (e) {
      ready = null;
      throw e;
    }
  };
  const run = (sql: string, ...v: unknown[]) => d1.prepare(sql).bind(...v).run();
  const first = <T>(sql: string, ...v: unknown[]) => d1.prepare(sql).bind(...v).first<T>();

  /** delete conversations whose last turn is older than the retention period (and their turns) */
  async function purge(now: string): Promise<void> {
    if (!retention) return;
    const cutoff = new Date(new Date(now).getTime() - retention * 86_400_000).toISOString();
    await run("DELETE FROM conv_turns WHERE conv_id IN (SELECT id FROM conversations WHERE updated_at < ?)", cutoff);
    await run("DELETE FROM conversations WHERE updated_at < ?", cutoff);
  }
  const drop = async (id: string) => {
    await run("DELETE FROM conv_turns WHERE conv_id = ?", id);
    await run("DELETE FROM conversations WHERE id = ?", id);
  };

  return {
    retentionDays: retention,

    async list(now: string): Promise<ConvSummary[]> {
      await ensure();
      await purge(now);
      return (
        (
          await d1
            .prepare(
              "SELECT c.id AS id, c.title AS title, c.created_at AS created_at, c.updated_at AS updated_at, " +
                "(SELECT COUNT(*) FROM conv_turns t WHERE t.conv_id = c.id) AS turns FROM conversations c ORDER BY c.updated_at DESC LIMIT ?",
            )
            .bind(MAX_CONVERSATIONS)
            .all<ConvSummary>()
        ).results ?? []
      );
    },

    async get(id: string): Promise<{ id: string; title: string; turns: ConvTurn[] } | null> {
      if (!ID_RE.test(id)) return null;
      await ensure();
      const c = await first<{ id: string; title: string }>("SELECT id, title FROM conversations WHERE id = ?", id);
      if (!c) return null;
      const rows = (await d1.prepare("SELECT seq, question, answer, payload, created_at FROM conv_turns WHERE conv_id = ? ORDER BY seq").bind(id).all<any>()).results ?? [];
      return { id: c.id, title: c.title, turns: rows.map((r) => ({ ...r, payload: safeParse(r.payload) })) };
    },

    /** Adds one finished turn (creating the conversation on its first turn). */
    async append(id: string, t: { question: unknown; answer: unknown; payload: unknown }, now: string): Promise<number> {
      if (!ID_RE.test(id)) throw new ConvInputError("bad conversation id");
      if (typeof t.question !== "string" || !t.question.trim() || t.question.length > MAX_QUESTION) throw new ConvInputError(`question must be 1-${MAX_QUESTION} characters`);
      if (typeof t.answer !== "string" || t.answer.length > MAX_ANSWER) throw new ConvInputError(`answer must be a string of at most ${MAX_ANSWER} characters`);
      const hits = scanAll([t.question]);
      if (hits.length) throw new ConvInputError(`患者を特定できる情報の可能性があるため、この質問は保存しません（${hits.map((h) => h.label).join("、")}）`, "possible_identifier");
      const p = t.payload as any;
      if (!p || typeof p !== "object" || Array.isArray(p) || (p.kind !== "final" && p.kind !== "degraded")) throw new ConvInputError('payload must be an object with kind "final" or "degraded"');
      // a turn made in case mode carries the case it was asked with (payload.case), and one that created a fictional case the
      // request (payload.create): their text is checked like the question
      const caseHits = scanAll([...caseStrings(p.case), ...caseStrings(p.create)]);
      if (caseHits.length) throw new ConvInputError(`患者を特定できる情報の可能性があるため、この症例の入力は保存しません（${caseHits.map((h) => h.label).join("、")}）`, "possible_identifier");
      const payload = JSON.stringify(p);
      if (payload.length > MAX_PAYLOAD) throw new ConvInputError(`payload is longer than ${MAX_PAYLOAD} characters`);

      await ensure();
      await purge(now);
      const exists = await first("SELECT 1 AS x FROM conversations WHERE id = ?", id);
      if (!exists) {
        const n = Number((await first<{ n: number }>("SELECT COUNT(*) AS n FROM conversations"))?.n ?? 0);
        if (n >= MAX_CONVERSATIONS) {
          const oldest = await first<{ id: string }>("SELECT id FROM conversations ORDER BY updated_at ASC LIMIT 1");
          if (oldest) await drop(oldest.id); // the least recently used goes first
        }
        const title = t.question.replace(/\s+/g, " ").trim().slice(0, TITLE_CHARS);
        await run("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", id, title, now, now);
      }
      const seq = Number((await first<{ m: number | null }>("SELECT MAX(seq) AS m FROM conv_turns WHERE conv_id = ?", id))?.m ?? 0) + 1;
      if (seq > MAX_TURNS) throw new ConvInputError(`この会話は ${MAX_TURNS} 往復に達しました。新しい会話を始めてください`, "too_many_turns");
      await run("INSERT INTO conv_turns (conv_id, seq, question, answer, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, seq, t.question, t.answer, payload, now);
      await run("UPDATE conversations SET updated_at = ? WHERE id = ?", now, id);
      return seq;
    },

    async remove(id: string): Promise<boolean> {
      if (!ID_RE.test(id)) return false;
      await ensure();
      const had = await first("SELECT 1 AS x FROM conversations WHERE id = ?", id);
      await drop(id);
      return !!had;
    },

    async removeAll(): Promise<void> {
      await ensure();
      await run("DELETE FROM conv_turns");
      await run("DELETE FROM conversations");
    },
  };
}

/** The string values of a saved case or creation request (one level: a flat object whose other values are not text). */
/** Every string in a saved case or creation request, however deep (the intake keeps its answers one level down). */
function caseStrings(c: unknown, depth = 0): string[] {
  if (typeof c === "string") return [c];
  if (!c || typeof c !== "object" || depth > 4) return [];
  return Object.values(c as Record<string, unknown>).flatMap((v) => caseStrings(v, depth + 1));
}

function safeParse(s: unknown): unknown {
  try {
    return JSON.parse(String(s));
  } catch {
    return null;
  }
}
