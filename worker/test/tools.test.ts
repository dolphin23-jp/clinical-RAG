// iPad-side measurement and evaluation (docs/evaluation.md 5): numeric worksheet endpoint, evaluation questions in D1,
// one-question retrieval runs.  The fixture DB is read-only; the evaluation store is a separate writable SQLite.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import { dbBackend, evalRetrieval, parseQuestions } from "../../eval/lib.ts";
import type { Db } from "../src/db.ts";
import { MAX_LINE } from "../src/evalstore.ts";
import { handle, type AppDeps } from "../src/handler.ts";
import { allocate, draw, norm, numberExpressions } from "../src/numsample.ts";
import { buildFixtureDb, openDb, openRw, REPO } from "./nodeDb.ts";

let db: Db;
before(() => {
  db = openDb(buildFixtureDb());
});
const TOKEN = "test-token-0123456789abcdef";
const app = (extra: Partial<AppDeps> = {}): AppDeps => ({ db, apiKey: "k", appToken: TOKEN, model: "m", ...extra });
const req = (path: string, init: RequestInit = {}) =>
  new Request(`http://x${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers as any) } });
const line = (o: object) => JSON.stringify(o);

// ---------------------------------------------------------------------------------- numeric worksheet (T1-7)
test("number extraction matches the shared vectors (same file as scripts/sample_numeric.py)", () => {
  const v = JSON.parse(readFileSync(join(REPO, "tests", "vectors", "numeric_expr.json"), "utf-8"));
  assert.ok(v.cases.length >= 12);
  for (const c of v.cases) assert.deepEqual(numberExpressions(norm(c.text)).map((x) => x[2]), c.exprs, c.text);
});

test("draw: even across books, then flags; deterministic per seed", () => {
  const cands = [
    ...["a1", "a2", "a3", "a4"].map((id) => ({ chunk_id: id, book_id: "A", flags: "dose_unit" })),
    ...["a5", "a6"].map((id) => ({ chunk_id: id, book_id: "A", flags: "threshold,lab_threshold" })),
    ...["b1", "b2"].map((id) => ({ chunk_id: id, book_id: "B", flags: "dose_unit,threshold" })),
  ];
  const p = draw(cands, 4, 7);
  assert.deepEqual(draw(cands, 4, 7), p);
  assert.equal(p.filter((x) => x.startsWith("a")).length, 2);
  assert.equal(p.filter((x) => x.startsWith("b")).length, 2);
  assert.ok(p.some((x) => ["a5", "a6"].includes(x)) && p.some((x) => ["a1", "a2", "a3", "a4"].includes(x)));
  assert.deepEqual(allocate(5, { A: 10, B: 1 }), { A: 4, B: 1 });
});

test("/api/numeric/sample: rows with the number marked in context, linked to the section; needs the token", async () => {
  const res = await handle(req("/api/numeric/sample?chunks=5&per_chunk=3&seed=1"), app());
  assert.equal(res.status, 200);
  const j: any = await res.json();
  for (const r of j.rows) {
    assert.match(r.no, /^N\d{3}$/);
    assert.ok(r.context.includes(`【${r.number}】`));
    assert.ok(r.parent_id && r.book_id === "fx" && /^p\./.test(r.page_label));
  }
  assert.deepEqual(j.rows.map((r: any) => r.number), ["10 mg/日", "30 未満"]); // the fixture's only numeric chunk
  assert.deepEqual([j.drawn, j.candidates, j.empty], [1, 1, 0]);
  assert.equal((await handle(new Request("http://x/api/numeric/sample"), app())).status, 401);
  const none: any = await (await handle(req("/api/numeric/sample?books=other"), app())).json();
  assert.equal(none.rows.length, 0);
});

// ---------------------------------------------------------------------------------- evaluation questions in D1 (T1-8)
const Q1 = line({ id: "def", group: "keyword", severity: "high", queries: ["ゼルニア値 定義"], question: "ゼルニア値 の定義", expect: { book_id: "fx", text_contains: ["半分以下"] } });
const Q2 = line({ id: "syn", group: "concept", queries: ["架空薬X"], expect: { pages: [12] } });

test("store: put / list / jsonl / delete; lines are checked like the PC tools", async () => {
  const rw = openRw();
  const deps = app({ rw, now: () => new Date("2026-10-24T00:00:00Z") });
  assert.equal((await handle(req("/api/eval/questions/def", { method: "PUT", body: JSON.stringify({ line: Q1 }) }), deps)).status, 200);
  const list: any = await (await handle(req("/api/eval/questions"), deps)).json();
  assert.deepEqual(list.questions.map((q: any) => q.id), ["def"]);
  assert.equal(list.questions[0].updated_at, "2026-10-24T00:00:00.000Z");
  const jsonl = await (await handle(req("/api/eval/questions?format=jsonl"), deps)).text();
  assert.equal(parseQuestions(jsonl)[0].id, "def");

  const bad = async (path: string, l: string) => {
    const r = await handle(req(path, { method: "PUT", body: JSON.stringify({ line: l }) }), deps);
    return { status: r.status, j: (await r.json()) as any };
  };
  const ident = await bad("/api/eval/questions/x1", line({ id: "x1", queries: ["カルテ番号 12345678"], expect: { pages: [1] } }));
  assert.equal(ident.status, 400);
  assert.match(ident.j.error, /patient identifier/);
  assert.ok(!JSON.stringify(ident.j).includes("12345678"));
  assert.equal((await bad("/api/eval/questions/x2", line({ id: "x2", queries: ["x"], expect: { book_id: "BOOK_ID" } }))).status, 400);
  assert.match((await bad("/api/eval/questions/x3", Q2)).j.error, /differs/);
  assert.equal((await bad("/api/eval/questions/x4", "x".repeat(MAX_LINE + 1))).status, 400);
  assert.equal((await handle(req("/api/eval/questions/bad%20id", { method: "PUT", body: "{}" }), deps)).status, 400);
  assert.equal((rw.raw.prepare("SELECT COUNT(*) AS n FROM eval_questions").get() as any).n, 1); // nothing bad was written

  const del: any = await (await handle(req("/api/eval/questions/def", { method: "DELETE" }), deps)).json();
  assert.equal(del.deleted, true);
  assert.equal(((await (await handle(req("/api/eval/questions/def", { method: "DELETE" }), deps)).json()) as any).deleted, false);
});

test("store: import is all-or-nothing and updates existing ids", async () => {
  const rw = openRw();
  const deps = app({ rw });
  const ok: any = await (await handle(req("/api/eval/import", { method: "POST", body: JSON.stringify({ text: `# comment\n${Q1}\n${Q2}\n` }) }), deps)).json();
  assert.equal(ok.imported, 2);
  const badText = `${Q1}\n${line({ id: "x", queries: ["患者ID 1234"], expect: { pages: [1] } })}`;
  const r = await handle(req("/api/eval/import", { method: "POST", body: JSON.stringify({ text: badText }) }), deps);
  assert.equal(r.status, 400);
  const ids = ((await (await handle(req("/api/eval/questions"), deps)).json()) as any).questions.map((q: any) => q.id);
  assert.deepEqual(ids, ["def", "syn"]);
});

test("/api/eval/retrieval: one stored question, with and without the dictionary, same ranks as the PC tool", async () => {
  const rw = openRw();
  const deps = app({ rw });
  await handle(req("/api/eval/import", { method: "POST", body: JSON.stringify({ text: `${Q1}\n${Q2}` }) }), deps);
  for (const id of ["def", "syn"]) {
    const j: any = await (await handle(req("/api/eval/retrieval", { method: "POST", body: JSON.stringify({ id }) }), deps)).json();
    const [q] = parseQuestions(id === "def" ? Q1 : Q2);
    const [on] = await evalRetrieval(dbBackend(db), [q], { parents: 5, expand: true });
    const [off] = await evalRetrieval(dbBackend(db), [q], { parents: 5, expand: false });
    assert.equal(j.rank_on, on.rank ?? null);
    assert.equal(j.rank_off, off.rank ?? null);
    assert.ok(j.top_on.length <= 3 && j.top_on.every((h: any) => h.book_id === "fx" && /^p\./.test(h.page_label)));
  }
  assert.equal((await handle(req("/api/eval/retrieval", { method: "POST", body: JSON.stringify({ id: "nope" }) }), deps)).status, 404);
});

test("/api/eval/* answers 501 without storage and 401 without the token", async () => {
  assert.equal((await handle(req("/api/eval/questions"), app())).status, 501);
  assert.equal((await handle(new Request("http://x/api/eval/questions"), app({ rw: openRw() }))).status, 401);
});

// ---------------------------------------------------------------------------------- web/eval-tools.js (browser twins)
test("eval-tools.js: worksheet summary and Wilson match the Python script (shared vectors)", async () => {
  const t: any = await import(join(REPO, "web", "eval-tools.js"));
  const v = JSON.parse(readFileSync(join(REPO, "tests", "vectors", "numeric_report.json"), "utf-8"));
  const rows = v.rows.map((r: any) => ({ no: r.no, book_id: r.book, flag: r.flag, chunk_id: r.chunk }));
  const judged = Object.fromEntries(v.rows.filter((r: any) => r.verdict).map((r: any) => [r.no, { verdict: r.verdict, kind: r.kind, shift: r.shift }]));
  const s = t.summarizeNumeric(rows, judged);
  for (const k of ["rows", "ok", "err", "skip", "unjudged", "by_book", "by_flag", "chunks", "kinds", "page_shift"]) assert.deepEqual(s[k], v.expect[k], k);
  for (const w of v.wilson) {
    const [lo, hi] = t.wilson(w.k, w.n);
    assert.ok(Math.abs(lo - w.lo) < 5e-4 && Math.abs(hi - w.hi) < 5e-4, `${w.k}/${w.n}`);
  }
});

test("eval-tools.js: retrieval metrics, ask scoring and page labels agree with eval/lib.ts", async () => {
  const t: any = await import(join(REPO, "web", "eval-tools.js"));
  const lib = await import("../../eval/lib.ts");
  const qs = parseQuestions(
    [
      line({ id: "a", group: "g1", severity: "high", queries: ["x"], expect: { pages: [10] } }),
      line({ id: "b", group: "g1", queries: ["x"], expect: { pages: [10] } }),
      line({ id: "c", group: "g2", queries: ["x"], expect: { pages: [10] } }),
      line({ id: "d", group: "neg", negative: true, queries: ["x"], expect: {} }),
    ].join("\n"),
  );
  const ranks: Record<string, [number | null, number | null]> = { a: [1, 2], b: [null, 3], c: [4, null], d: [null, null] };
  const results = qs.map((q) => ({ group: q.group, severity: q.severity, negative: q.negative, rank_on: ranks[q.id][0], rank_off: ranks[q.id][1] }));
  for (const [key, i] of [["on", 0], ["off", 1]] as const) {
    const ref = lib.metrics(qs.map((q) => ({ q, rank: q.negative ? undefined : ranks[q.id][i], hits: [] })));
    assert.deepEqual(t.retrievalMetrics(results, key), Object.fromEntries(ref));
  }
  for (const label of ["p.10", "p.10-11", "", "p.x"]) assert.deepEqual(t.parsePageLabel(label), lib.parsePageLabel(label));
  const q = parseQuestions(line({ id: "s", queries: ["x"], expect: { book_id: "fx", pages: [11] }, must_mention: ["半分以下", "急性"] }))[0];
  for (const o of [
    { answer: "基準の半分以下。", citations: [{ kind: "book", book_id: "fx", page: "p.10-11" }] },
    { answer: "記載が見つかりませんでした", citations: [{ kind: "web" }] },
    { answer: "", citations: [{ kind: "book", book_id: "other", page: "p.11" }] },
  ]) {
    assert.deepEqual(t.scoreAsk(q, o), lib.scoreAsk(q, { kind: "final", status: 200, ...o }));
  }
  assert.deepEqual(t.pagesFrom("12, 13 14、x"), [12, 13, 14]);
  assert.deepEqual(t.listFrom("a, b\nc、"), ["a", "b", "c"]);
});
