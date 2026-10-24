import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { GUARD_WORDS, scanAll, scanIdentifiers } from "../src/idguard.ts";
import { REPO } from "./nodeDb.ts";

interface Case {
  text: string;
  codes: string[];
}
const vectors: { cases: Case[] } = JSON.parse(readFileSync(join(REPO, "tests", "vectors", "idguard.json"), "utf-8"));
const codesOf = (hits: { code: string }[]) => [...new Set(hits.map((h) => h.code))].sort();

test("worker guard reproduces the shared vectors", () => {
  assert.ok(vectors.cases.length >= 30);
  for (const c of vectors.cases) assert.deepEqual(codesOf(scanIdentifiers(c.text)), c.codes, JSON.stringify(c.text));
});

test("browser guard (web/id-guard.js) reproduces the same vectors and word list", async () => {
  const web: any = await import(join(REPO, "web", "id-guard.js"));
  assert.deepEqual(web.WORDS, GUARD_WORDS);
  for (const c of vectors.cases) assert.deepEqual(codesOf(web.scan(c.text)), c.codes, JSON.stringify(c.text));
});

test("hits carry only the kind, never the matched text; non-strings are safe", () => {
  for (const h of scanIdentifiers("カルテ番号 12345678 a.b@example.com")) {
    assert.deepEqual(Object.keys(h).sort(), ["code", "label"]);
    assert.ok(!h.label.includes("12345678") && !h.label.includes("example"));
  }
  for (const v of [null, undefined, 123, {}, []]) assert.deepEqual(scanIdentifiers(v), []);
});

test("scanAll merges several texts and keeps one entry per label", () => {
  const hits = scanAll(["患者ID 1234", "患者ID 5678", "普通の質問"]);
  assert.deepEqual(hits.map((h) => h.label).sort(), ["ID・MRN の後ろの数字", "「患者ID」の語"].sort());
});
