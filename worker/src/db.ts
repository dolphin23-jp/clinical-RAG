// Minimal async DB interface so the same search code runs on Cloudflare D1 (production)
// and on node:sqlite (local tests / eval).  Positional `?` placeholders only.
// NOTE: D1 allows at most 100 bound parameters per statement; keep IN-lists small.

export type Row = Record<string, unknown>;

export interface Db {
  all<T = Row>(sql: string, ...params: unknown[]): Promise<T[]>;
}

export function fromD1(d1: D1Database): Db {
  return {
    async all<T = Row>(sql: string, ...params: unknown[]): Promise<T[]> {
      const r = await d1.prepare(sql).bind(...params).all();
      return (r.results ?? []) as T[];
    },
  };
}

export const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(",");
