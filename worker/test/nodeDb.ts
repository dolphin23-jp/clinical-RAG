import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Db } from "../src/db.ts";

export const REPO = resolve(import.meta.dirname, "..", "..");

export function openDb(path: string): Db {
  const d = new DatabaseSync(path, { readOnly: true });
  return {
    async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
      return d.prepare(sql).all(...(params as any[])) as unknown as T[];
    },
  };
}

/** Build a throwaway DB from the synthetic fixture with the real Python ingest. */
export function buildFixtureDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "medbook-"));
  const db = join(dir, "fx.sqlite");
  execFileSync("python3", ["-m", "ingest", "build", "--db", db, "fx", join(REPO, "tests", "fixtures", "synthetic_ch.md")], {
    cwd: REPO,
    stdio: "pipe",
  });
  return db;
}
