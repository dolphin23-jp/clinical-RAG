// Daily cap on /api/ask (the only endpoint that costs money). The counter stores the day and a number, nothing else:
// no question text, no token, no IP. Days roll over at midnight Japan time (doctor's decision, 2026-10-24).
// The Db interface in db.ts stays read-only; this is the one write path, kept separate on purpose.

export interface AskCounter {
  /** Adds one ask to `day` and returns that day's total including this one. */
  increment(day: string): Promise<number>;
}

/** YYYY-MM-DD in Asia/Tokyo. */
export function jstDay(d: Date): string {
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

export const USAGE_TABLE_SQL = "CREATE TABLE IF NOT EXISTS usage_daily (day TEXT PRIMARY KEY, asks INTEGER NOT NULL)";
export const USAGE_INCREMENT_SQL =
  "INSERT INTO usage_daily (day, asks) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET asks = asks + 1 RETURNING asks";

/** Minimal subset of D1Database used here (lets tests run the same SQL on node:sqlite). */
export interface D1Like {
  prepare(sql: string): { bind(...values: unknown[]): { first<T = unknown>(): Promise<T | null> }; run(): Promise<unknown> };
}

export function d1Counter(d1: D1Like): AskCounter {
  let ready: Promise<unknown> | null = null;
  return {
    async increment(day: string): Promise<number> {
      try {
        ready ??= d1.prepare(USAGE_TABLE_SQL).run();
        await ready;
      } catch (e) {
        ready = null; // retry the CREATE next time
        throw e;
      }
      const row = await d1.prepare(USAGE_INCREMENT_SQL).bind(day).first<{ asks: number }>();
      return Number(row?.asks ?? 0);
    },
  };
}
