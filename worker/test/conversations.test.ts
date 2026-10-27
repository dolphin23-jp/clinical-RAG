// Conversations in D1 (convstore.ts, /api/conversations/*) and the pin on what the Worker may write (writes).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import type { Db } from "../src/db.ts";
import { ConvInputError, convStore, MAX_CONVERSATIONS, MAX_TURNS, TITLE_CHARS } from "../src/convstore.ts";
import { handle, type AppDeps } from "../src/handler.ts";
import { buildFixtureDb, openDb, openRw, REPO } from "./nodeDb.ts";

let db: Db;
before(() => {
  db = openDb(buildFixtureDb());
});
const TOKEN = "test-token-0123456789abcdef";
const app = (extra: Partial<AppDeps> = {}): AppDeps => ({ db, apiKey: "k", appToken: TOKEN, model: "m", ...extra });
const req = (path: string, init: RequestInit = {}) =>
  new Request(`http://x${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers as any) } });
const final = (extra: object = {}) => ({ kind: "final", blocks: [{ text: "答え", citations: [] }], sources: [], numbers: [], ...extra });
const t = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString(); // 2026-10-n
const ID = (n: number) => `conv-${String(n).padStart(8, "0")}`;

test("store: first turn creates the conversation (title = start of the question), later turns number on", async () => {
  const s = convStore(openRw(), { retentionDays: 30 });
  assert.equal(await s.append(ID(1), { question: "  高K血症で   心電図変化が\nあるとき、最初に何をする？ 続きの文は切り捨てられる長い質問です。", answer: "答え1", payload: final() }, t(1)), 1);
  assert.equal(await s.append(ID(1), { question: "続けて", answer: "答え2", payload: final() }, t(2)), 2);
  const [c] = await s.list(t(2));
  assert.equal(c.turns, 2);
  assert.equal(c.title.length, TITLE_CHARS);
  assert.match(c.title, /^高K血症で 心電図変化が あるとき/);
  const g = await s.get(ID(1));
  assert.deepEqual(g!.turns.map((x) => [x.seq, x.question, x.answer]), [[1, c.title === "" ? "" : g!.turns[0].question, "答え1"], [2, "続けて", "答え2"]]);
  assert.deepEqual((g!.turns[0].payload as any).blocks, [{ text: "答え", citations: [] }]);
  assert.equal(await s.get("nope"), null);
});

test("store: identifier-like questions are refused (nothing written), as are bad ids, sizes and payloads", async () => {
  const rw = openRw();
  const s = convStore(rw, { retentionDays: 30 });
  const bad = async (id: string, q: any, a: any, p: any) => {
    try {
      await s.append(id, { question: q, answer: a, payload: p }, t(1));
      return "";
    } catch (e) {
      assert.ok(e instanceof ConvInputError);
      return (e as ConvInputError).code + ":" + e.message;
    }
  };
  const idErr = await bad(ID(1), "カルテ番号 12345678 の件", "a", final());
  assert.match(idErr, /^possible_identifier:/);
  assert.ok(!idErr.includes("12345678"));
  assert.match(await bad("short", "q", "a", final()), /bad conversation id/);
  assert.match(await bad(ID(1), "", "a", final()), /question must be/);
  assert.match(await bad(ID(1), "q", 5, final()), /answer must be/);
  assert.match(await bad(ID(1), "q", "a", { kind: "other" }), /payload must be/);
  assert.match(await bad(ID(1), "q", "a", final({ big: "x".repeat(300_001) })), /payload is longer/);
  // refused before anything was written (not even the tables): the list is empty
  assert.deepEqual(await s.list(t(1)), []);
  assert.equal((rw.raw.prepare("SELECT COUNT(*) AS n FROM conv_turns").get() as any).n, 0);
  // an answer that quotes an 8-digit PMID is fine: only the user's question is checked
  assert.equal(await s.append(ID(2), { question: "文献は？", answer: "PMID 12345678 を参照", payload: final() }, t(1)), 1);
});

test("store: retention purges on read and on write; 0 keeps everything", async () => {
  const rw = openRw();
  const s = convStore(rw, { retentionDays: 30 });
  await s.append(ID(1), { question: "古い会話", answer: "a", payload: final() }, "2026-08-01T00:00:00.000Z");
  await s.append(ID(2), { question: "新しい会話", answer: "a", payload: final() }, "2026-10-20T00:00:00.000Z");
  assert.deepEqual((await s.list("2026-10-24T00:00:00.000Z")).map((c) => c.id), [ID(2)]);
  assert.equal((rw.raw.prepare("SELECT COUNT(*) AS n FROM conv_turns").get() as any).n, 1); // its turns went too
  await s.append(ID(3), { question: "もう1つ", answer: "a", payload: final() }, "2026-12-30T00:00:00.000Z"); // writing purges too
  assert.deepEqual((await s.list("2026-12-30T00:00:00.000Z")).map((c) => c.id), [ID(3)]);
  const keep = convStore(openRw(), { retentionDays: 0 });
  await keep.append(ID(1), { question: "ずっと残す", answer: "a", payload: final() }, "2020-01-01T00:00:00.000Z");
  assert.equal((await keep.list("2030-01-01T00:00:00.000Z")).length, 1);
});

test("store: turn and conversation caps; deleting one or all", async () => {
  const s = convStore(openRw(), { retentionDays: 0 });
  for (let i = 1; i <= MAX_TURNS; i++) await s.append(ID(1), { question: `q${i}`, answer: "a", payload: final() }, t(1));
  await assert.rejects(s.append(ID(1), { question: "もう1往復", answer: "a", payload: final() }, t(1)), (e: any) => e.code === "too_many_turns");
  const many = convStore(openRw(), { retentionDays: 0 });
  for (let i = 1; i <= MAX_CONVERSATIONS + 1; i++) await many.append(ID(i), { question: `会話${i}`, answer: "a", payload: final() }, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString());
  const ids = (await many.list(t(1))).map((c) => c.id);
  assert.equal(ids.length, MAX_CONVERSATIONS);
  assert.ok(!ids.includes(ID(1)) && ids.includes(ID(MAX_CONVERSATIONS + 1)), "the least recently used one made room");
  assert.equal(await many.remove(ID(5)), true);
  assert.equal(await many.remove(ID(5)), false);
  await many.removeAll();
  assert.deepEqual(await many.list(t(1)), []);
});

test("HTTP: append, list, restore, delete; 401 without the token, 501 without storage, 404 for unknown", async () => {
  const rw = openRw();
  const deps = app({ rw, conversationRetentionDays: 30, now: () => new Date(t(24)) });
  const post = (id: string, body: object) => handle(req(`/api/conversations/${id}/turns`, { method: "POST", body: JSON.stringify(body) }), deps);
  const ok = await post(ID(1), { question: "腎前性AKIの見分け方", answer: "答え", payload: final({ numbers: [{ text: "10 mg", status: "cited" }] }) });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as any).seq, 1);
  const list: any = await (await handle(req("/api/conversations"), deps)).json();
  assert.equal(list.retention_days, 30);
  assert.deepEqual(list.conversations.map((c: any) => [c.id, c.turns, c.title]), [[ID(1), 1, "腎前性AKIの見分け方"]]);
  const got: any = await (await handle(req(`/api/conversations/${ID(1)}`), deps)).json();
  assert.equal(got.turns[0].payload.numbers[0].status, "cited");
  const refused = await post(ID(2), { question: "患者ID 123456", answer: "a", payload: final() });
  assert.equal(refused.status, 400);
  assert.equal(((await refused.json()) as any).code, "possible_identifier");
  assert.equal((await handle(req(`/api/conversations/${ID(9)}`), deps)).status, 404);
  assert.equal((await handle(req(`/api/conversations/${ID(1)}`, { method: "DELETE" }), deps)).status, 200);
  assert.equal(((await (await handle(req("/api/conversations"), deps)).json()) as any).conversations.length, 0);
  await post(ID(3), { question: "q", answer: "a", payload: final() });
  assert.equal(((await (await handle(req("/api/conversations", { method: "DELETE" }), deps)).json()) as any).deleted, "all");
  assert.equal((await handle(new Request("http://x/api/conversations"), deps)).status, 401);
  assert.equal((await handle(req("/api/conversations"), app())).status, 501);
});

// ---------------------------------------------------------------------------------- the write list is pinned
const SRC = join(REPO, "worker", "src");
const code = (f: string) => readFileSync(join(SRC, f), "utf-8");

test("writes: SQL writes exist only in the four store modules and touch only their tables", () => {
  const allowedFiles = new Set(["usage.ts", "evalstore.ts", "convstore.ts", "recordstore.ts"]);
  const allowedTables = new Set(["usage_daily", "eval_questions", "conversations", "conv_turns", "case_records"]);
  const tables = new Set<string>();
  for (const f of readdirSync(SRC).filter((x) => x.endsWith(".ts"))) {
    const text = code(f);
    const writes = [...text.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|DROP\s+TABLE|ALTER\s+TABLE)\s+([a-z_]+)/g)].filter((m) => /^[A-Z]/.test(m[0]));
    if (writes.length && !allowedFiles.has(f)) assert.fail(`${f} writes to the database: ${writes.map((m) => m[0]).join("; ")}`);
    for (const m of writes) tables.add(m[2]);
  }
  assert.deepEqual([...tables].sort(), [...allowedTables].sort());
  // the read-only DB part stays read-only
  assert.doesNotMatch(code("db.ts"), /\.run\(|INSERT|UPDATE|DELETE/);
  assert.doesNotMatch(code("handler.ts") + code("anthropic.ts") + code("search.ts"), /\.prepare\(/);
});

test("writes: no logging of questions or answers (only the two known console.warn calls)", () => {
  const found: Record<string, number> = {};
  for (const f of readdirSync(SRC).filter((x) => x.endsWith(".ts"))) {
    const n = (code(f).match(/console\./g) ?? []).length;
    if (n) found[f] = n;
  }
  assert.deepEqual(found, { "handler.ts": 1, "search.ts": 1 });
  assert.match(code("handler.ts"), /console\.warn\(`daily ask counter unavailable[^`]*\$\{\(e as Error\)\.message\}`\)/);
  assert.match(code("search.ts"), /console\.warn\(`trigram index unavailable[^`]*\$\{\(e as Error\)\.message\}`\)/);
});

// ---------------------------------------------------------------------------------- a saved simulation (enhancement-plan 8.21 stage 4; D6 b)
test("store: a simulation of a fictional case is saved as payload.sim and comes back; an identifier anywhere in it (keys too) is refused; the books' list is not scanned", async () => {
  const sim = (extra: object = {}) => ({
    kind: "sim",
    sim: {
      v: 1,
      theme: "肺炎",
      setting: { v: 1, flow: "ed-dyspnea", patient: { age: 72 }, opening: "息が苦しい", origin: { by: "ai", sources: [{ id: "bk1:12", title: "架空の書籍 第12版", page: 123456 }] } },
      log: [{ k: "ask", q: "rr" }],
      ...extra,
    },
  });
  const s = convStore(openRw(), { retentionDays: 30 });
  assert.equal(await s.append(ID(1), { question: "【模擬】肺炎（救急）", answer: "【架空症例（模擬）・実在の患者ではありません】", payload: sim() }, t(1)), 1);
  const got = await s.get(ID(1));
  assert.equal((got!.turns[0].payload as any).sim.setting.opening, "息が苦しい");
  assert.equal((got!.turns[0].payload as any).kind, "sim");

  const rw = openRw();
  const s2 = convStore(rw, { retentionDays: 30 });
  const refuse = (p: object) =>
    assert.rejects(s2.append(ID(2), { question: "【模擬】肺炎", answer: "a", payload: p }, t(1)), (e: any) => e instanceof ConvInputError && e.code === "possible_identifier" && !e.message.includes("12345678"));
  await refuse(sim({ own: "カルテ番号 12345678 の患者" }));
  await refuse(sim({ log: [{ k: "say", text: "患者ID 12345678" }] }));
  await refuse(sim({ notes: { "患者ID 12345678": 1 } }));
  for (const bad of [{ kind: "sim" }, { kind: "sim", sim: { v: 2, setting: {}, log: [] } }, { kind: "sim", sim: { v: 1, setting: {}, log: {} } }, { kind: "sim", sim: { v: 1, setting: [], log: [] } }]) {
    await assert.rejects(s2.append(ID(2), { question: "q", answer: "a", payload: bad }, t(1)), /payload\.sim must be/);
  }
  assert.deepEqual(await s2.list(t(1)), []); // nothing was written
});
