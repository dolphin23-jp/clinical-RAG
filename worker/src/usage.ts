// Daily cap on /api/ask (the only endpoint that costs money), and four daily counts of how the answers went (docs/enhancement-plan.md F4).
// The table stores a day and numbers, nothing else: no question text, no answer text, no token, no IP, no id that could tie a count to a question.
// Days roll over at midnight Japan time (doctor's decision, 2026-10-24).
// The Db interface in db.ts stays read-only; this is the one write path, kept separate on purpose.

/**
 * How an answer went, counted per day (never which question): all four are about the answer's shape, so a day's numbers say "the books had nothing for N
 * questions" without saying which.  Definitions (worker/src/handler.ts counts them from the finished answer):
 *   no_search  the answer was given without searching the books
 *   no_hits    the books were searched, and no search found any section
 *   no_cite    the answer cites no book (a web citation does not count)
 *   num_flag   the answer has a number the machine could not find in any book text (numcheck "not_found")
 */
export const USAGE_KINDS = ["no_search", "no_hits", "no_cite", "num_flag"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export interface AskCounter {
  /** Adds one ask to `day` and returns that day's total including this one. */
  increment(day: string): Promise<number>;
  /** Adds one to each of these counts of `day` (the ask itself is counted by `increment`).  Best effort: the caller ignores a failure. */
  note?(day: string, kinds: UsageKind[]): Promise<void>;
}

/** YYYY-MM-DD in Asia/Tokyo. */
export function jstDay(d: Date): string {
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

export const USAGE_TABLE_SQL = "CREATE TABLE IF NOT EXISTS usage_daily (day TEXT PRIMARY KEY, asks INTEGER NOT NULL)";
/** The count columns are added to the table that already exists in production (and to a new one): ADD COLUMN, never a rewrite.  Day and numbers only. */
export const USAGE_COLUMN_SQL = USAGE_KINDS.map((k) => `ALTER TABLE usage_daily ADD COLUMN ${k} INTEGER NOT NULL DEFAULT 0`);
/** Succeeds only when the last count column is there (they are added in order). */
export const USAGE_PROBE_SQL = `SELECT ${USAGE_KINDS.at(-1)} FROM usage_daily LIMIT 0`;
export const USAGE_INCREMENT_SQL =
  "INSERT INTO usage_daily (day, asks) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET asks = asks + 1 RETURNING asks";
/** One statement for the four counts (0 or 1 each); the row is made if the day has none (a day with no cap has no `increment`). */
export const USAGE_NOTE_SQL = `INSERT INTO usage_daily (day, asks, ${USAGE_KINDS.join(", ")}) VALUES (?, 0, ${USAGE_KINDS.map(() => "?").join(", ")}) ON CONFLICT(day) DO UPDATE SET ${USAGE_KINDS.map((k) => `${k} = ${k} + excluded.${k}`).join(", ")}`;

/** Minimal subset of D1Database used here (lets tests run the same SQL on node:sqlite). */
export interface D1Like {
  prepare(sql: string): { bind(...values: unknown[]): { first<T = unknown>(): Promise<T | null>; run(): Promise<unknown> }; run(): Promise<unknown> };
}

export function d1Counter(d1: D1Like): AskCounter {
  let ready: Promise<unknown> | null = null;
  async function schema(): Promise<void> {
    try {
      ready ??= (async () => {
        await d1.prepare(USAGE_TABLE_SQL).run();
        try {
          await d1.prepare(USAGE_PROBE_SQL).run();
        } catch {
          for (const sql of USAGE_COLUMN_SQL) {
            try {
              await d1.prepare(sql).run();
            } catch (e) {
              if (!/duplicate column/i.test(String((e as Error)?.message))) throw e; // a column an earlier run already added
            }
          }
        }
      })();
      await ready;
    } catch (e) {
      ready = null; // retry the CREATE next time
      throw e;
    }
  }
  return {
    async increment(day: string): Promise<number> {
      await schema();
      const row = await d1.prepare(USAGE_INCREMENT_SQL).bind(day).first<{ asks: number }>();
      return Number(row?.asks ?? 0);
    },
    async note(day: string, kinds: UsageKind[]): Promise<void> {
      if (!kinds.length) return;
      await schema();
      await d1.prepare(USAGE_NOTE_SQL).bind(day, ...USAGE_KINDS.map((k) => (kinds.includes(k) ? 1 : 0))).run();
    },
  };
}
