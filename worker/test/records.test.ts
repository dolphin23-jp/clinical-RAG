// Case records in D1 (recordstore.ts, /api/records/*; the doctor's decision of 2026-10-24, docs/clinical-use.md 1e).  The write list is
// pinned in conversations.test.ts; here: the store's limits, the identifier check at any depth, the revision check, retention and "終える".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import type { Db } from "../src/db.ts";
import { handle, type AppDeps } from "../src/handler.ts";
import { MAX_DEPTH, MAX_NUMBER, MAX_RECORDS, MAX_RECORD_PAYLOAD, MAX_STRING, MAX_TITLE, RecordInputError, check, recordStore } from "../src/recordstore.ts";
import { buildFixtureDb, openDb, openRw, REPO } from "./nodeDb.ts";

let db: Db;
before(() => {
  db = openDb(buildFixtureDb());
});
const TOKEN = "test-token-0123456789abcdef";
const app = (extra: Partial<AppDeps> = {}): AppDeps => ({ db, apiKey: "k", appToken: TOKEN, model: "m", ...extra });
const req = (path: string, init: RequestInit = {}) =>
  new Request(`http://x${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers as any) } });
const ID = (n: number) => `rec-${String(n).padStart(8, "0")}`;
const day = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString(); // 2026-10-n
const rec = (extra: object = {}) => ({
  v: 1,
  title: "70代・男性・救急｜腹痛",
  ed: { case: { age: "70代", complaint: "3日前から腹痛", structured: "場面・症候: 救急外来 × 腹痛（x）", intake: { flow: "emergency-department.abdominal-pain", answers: { first: "sick", assoc: ["nausea"], temp: 38.4 } } } },
  problems: [{ id: "p1", label: "腎前性AKI", certainty: "suspected", plan: [{ id: "i1", text: "輸液", state: "planned" }] }],
  ...extra,
});
const rejects = (p: Promise<unknown>, code: string, check?: (e: RecordInputError) => void) =>
  assert.rejects(p, (e: any) => {
    assert.ok(e instanceof RecordInputError, String(e));
    assert.equal(e.code, code);
    check?.(e);
    return true;
  });

// ---------------------------------------------------------------------------------- the store
test("store: a record is created at revision 1, read back as it was, and each save raises the revision", async () => {
  const s = recordStore(openRw(), { retentionDays: 60 });
  assert.deepEqual(await s.list(day(1)), []);
  assert.deepEqual(await s.put(ID(1), { record: rec() }, day(1)), { rev: 1, updated_at: day(1) });
  const g = await s.get(ID(1), day(2));
  assert.deepEqual(g!.record, rec());
  assert.deepEqual([g!.id, g!.title, g!.rev, g!.created_at, g!.updated_at], [ID(1), "70代・男性・救急｜腹痛", 1, day(1), day(1)]);
  assert.deepEqual(await s.put(ID(1), { rev: 1, record: rec({ title: "70代・男性・入院" }) }, day(3)), { rev: 2, updated_at: day(3) });
  const l = await s.list(day(3));
  assert.deepEqual(l.map((x) => [x.id, x.title, x.rev, x.created_at, x.updated_at]), [[ID(1), "70代・男性・入院", 2, day(1), day(3)]]);
  assert.equal(await s.get("nope", day(3)), null);
  assert.equal(await s.get(ID(9), day(3)), null);
});

test("store: a save based on an old revision is refused with the current one; a record that is gone is not recreated by an update", async () => {
  const s = recordStore(openRw(), { retentionDays: 60 });
  await s.put(ID(1), { record: rec() }, day(1));
  await s.put(ID(1), { rev: 1, record: rec({ title: "二つ目の画面" }) }, day(2));
  await rejects(s.put(ID(1), { rev: 1, record: rec({ title: "古い画面" }) }, day(3)), "conflict", (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.rev, 2);
  });
  await rejects(s.put(ID(1), { record: rec({ title: "版なし" }) }, day(3)), "conflict"); // creating over an existing one is not a save
  assert.equal((await s.get(ID(1), day(3)))!.title, "二つ目の画面"); // the refused saves wrote nothing
  await s.remove(ID(1));
  await rejects(s.put(ID(1), { rev: 2, record: rec() }, day(4)), "gone", (e) => assert.equal(e.status, 404));
  for (const bad of [-1, 1.5, "2", NaN]) await rejects(s.put(ID(2), { rev: bad as any, record: rec() }, day(4)), "bad_request");
});

test("store: a record expires after its last update (60 days); 0 keeps it; reading does not extend it", async () => {
  const s = recordStore(openRw(), { retentionDays: 60 });
  const at = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString();
  await s.put(ID(1), { record: rec({ title: "古い" }) }, at(2026, 10, 1));
  assert.equal((await s.list(at(2026, 11, 29))).length, 1); // 59 days after the last update: still there
  assert.equal((await s.get(ID(1), at(2026, 11, 29)))!.title, "古い"); // reading is not an update
  await s.put(ID(2), { record: rec({ title: "新しい" }) }, at(2026, 11, 29));
  assert.deepEqual((await s.list(at(2026, 12, 1))).map((x) => x.id), [ID(2)]); // 61 days after the first: purged
  assert.equal(await s.get(ID(1), at(2026, 12, 1)), null);
  // an update restarts the clock
  await s.put(ID(2), { rev: 1, record: rec({ title: "更新" }) }, at(2027, 1, 20));
  assert.equal((await s.list(at(2027, 2, 25))).length, 1); // 88 days after the creation, 36 after the update
  assert.equal((await s.list(at(2027, 3, 25))).length, 0); // 64 days after the update
  const keep = recordStore(openRw(), { retentionDays: 0 });
  await keep.put(ID(1), { record: rec() }, day(1));
  assert.equal((await keep.list(at(2030, 1, 1))).length, 1);
});

test("store: 終える deletes one record (true once); removeAll empties; the limit on how many are kept", async () => {
  const s = recordStore(openRw(), { retentionDays: 60 });
  await s.put(ID(1), { record: rec() }, day(1));
  assert.equal(await s.remove(ID(1)), true);
  assert.equal(await s.remove(ID(1)), false);
  assert.equal(await s.remove("x"), false);
  for (let i = 1; i <= MAX_RECORDS; i++) await s.put(ID(i), { record: rec() }, day(2));
  await rejects(s.put(ID(99), { record: rec() }, day(3)), "too_many_records", (e) => assert.equal(e.status, 409));
  assert.equal((await s.list(day(3))).length, MAX_RECORDS);
  await s.put(ID(1), { rev: 1, record: rec({ title: "更新は上限に関わらない" }) }, day(3));
  await s.removeAll();
  assert.deepEqual(await s.list(day(3)), []);
});

test("store: an identifier-like text at ANY depth is refused with kinds only, and nothing is written", async () => {
  const rw = openRw();
  const s = recordStore(rw, { retentionDays: 60 });
  await s.list(day(1)); // the table exists
  const at = (path: (o: any) => void) => {
    const r: any = rec();
    path(r);
    return r;
  };
  const dirty = "カルテ番号 12345678 の件";
  const cases: Record<string, any> = {
    title: rec({ title: dirty }),
    "ed.case.complaint": at((r) => (r.ed.case.complaint = dirty)),
    "ed.case.structured": at((r) => (r.ed.case.structured = dirty)),
    "intake answer (text)": at((r) => (r.ed.case.intake.answers.memo = dirty)),
    "intake answer (list)": at((r) => (r.ed.case.intake.answers.assoc = ["nausea", dirty])),
    "problem label": at((r) => (r.problems[0].label = dirty)),
    "plan item": at((r) => (r.problems[0].plan[0].text = dirty)),
    "a phone number": at((r) => (r.ed.case.history = "電話 090-1234-5678")),
  };
  for (const [where, r] of Object.entries(cases)) {
    await rejects(s.put(ID(1), { record: r }, day(1)), "possible_identifier", (e) => {
      assert.ok(!/12345678|090-1234/.test(e.message), `${where}: the text is not echoed`);
      assert.match(e.message, /「カルテ番号」の語|電話番号/);
    });
  }
  assert.deepEqual(await s.list(day(1)), []);
  assert.equal(Number((rw.raw.prepare("SELECT COUNT(*) AS n FROM case_records").get() as any).n), 0);
  // clinical wording passes: an age band, vitals, lab values with units, relative times
  await s.put(ID(1), { record: rec({ ed: { case: { vitals: "BP 92/54, HR 108, SpO2 94%", findings: "Cr 2.4 mg/dL, K 5.8 mEq/L", complaint: "入院3日目に再燃" } } }) }, day(1));
});

test("store: shape and size — an object with v=1 and a title; plain keys; depth, string and total size are limited", async () => {
  const s = recordStore(openRw(), { retentionDays: 60 });
  for (const bad of [null, [], "x", 5, {}, { v: 2, title: "t" }, { v: 1 }, { v: 1, title: "" }, { v: 1, title: "  " }, { v: 1, title: "あ".repeat(MAX_TITLE + 1) }]) await rejects(s.put(ID(1), { record: bad }, day(1)), "bad_request");
  await rejects(s.put(ID(1), { record: rec({ "名前": "x" }) }, day(1)), "bad_request"); // a key is a plain name
  await rejects(s.put(ID(1), { record: rec({ "a b": "x" }) }, day(1)), "bad_request");
  let deep: any = "x";
  for (let i = 0; i < MAX_DEPTH + 1; i++) deep = { k: deep };
  await rejects(s.put(ID(1), { record: rec({ deep }) }, day(1)), "bad_request");
  await rejects(s.put(ID(1), { record: rec({ note: "あ".repeat(MAX_STRING + 1) }) }, day(1)), "too_large", (e) => assert.equal(e.status, 413));
  await s.put(ID(1), { record: rec({ note: "あ".repeat(MAX_STRING) }) }, day(1)); // exactly the limit is fine
  const many = Array.from({ length: Math.ceil(MAX_RECORD_PAYLOAD / MAX_STRING) + 5 }, (_, i) => ({ id: `n${i}`, t: "あ".repeat(MAX_STRING) }));
  await rejects(s.put(ID(2), { record: rec({ many }) }, day(1)), "too_large");
  assert.ok(MAX_RECORD_PAYLOAD >= 400_000);
  await rejects(s.put("bad id!", { record: rec() }, day(1)), "bad_request");
  assert.throws(() => check(rec({ n: Infinity })), RecordInputError);
  assert.equal((await s.list(day(1))).length, 1);
});

// ---------------------------------------------------------------------------------- the HTTP routes
test("routes: list / read / save / end over HTTP; token required; 501 without storage; 404, 409 and 400 carry their codes", async () => {
  const deps = app({ rw: openRw(), caseRecordRetentionDays: 60, now: () => new Date(day(5)) });
  const put = (id: string, body: unknown) => handle(req(`/api/records/${id}`, { method: "PUT", body: JSON.stringify(body) }), deps);
  const ok = await put(ID(1), { record: rec() });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { rev: 1, updated_at: day(5) });
  const list: any = await (await handle(req("/api/records"), deps)).json();
  assert.equal(list.retention_days, 60);
  assert.deepEqual(list.records.map((r: any) => [r.id, r.rev]), [[ID(1), 1]]);
  const got: any = await (await handle(req(`/api/records/${ID(1)}`), deps)).json();
  assert.deepEqual(got.record, rec());
  assert.equal(got.rev, 1);
  const stale = await put(ID(1), { rev: 0, record: rec() });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: "別の画面で更新されています。開き直してください", code: "conflict", rev: 1 });
  const dirty = await put(ID(2), { record: rec({ title: "患者ID 123456" }) });
  assert.equal(dirty.status, 400);
  const dj: any = await dirty.json();
  assert.equal(dj.code, "possible_identifier");
  assert.ok(!JSON.stringify(dj).includes("123456"));
  assert.equal((await put(ID(3), { record: "x" })).status, 400);
  assert.equal((await handle(req(`/api/records/${ID(3)}`, { method: "PUT", body: "{" }), deps)).status, 400);
  assert.equal((await put(ID(4), { rev: 3, record: rec() })).status, 404);
  assert.equal((await handle(req(`/api/records/${ID(9)}`), deps)).status, 404);
  assert.equal((await handle(req(`/api/records/${ID(1)}`, { method: "POST" }), deps)).status, 404);
  assert.deepEqual(await (await handle(req(`/api/records/${ID(1)}`, { method: "DELETE" }), deps)).json(), { deleted: true });
  assert.deepEqual(await (await handle(req(`/api/records/${ID(1)}`, { method: "DELETE" }), deps)).json(), { deleted: false });
  await put(ID(5), { record: rec() });
  assert.deepEqual(await (await handle(req("/api/records", { method: "DELETE" }), deps)).json(), { deleted: "all" });
  assert.equal(((await (await handle(req("/api/records"), deps)).json()) as any).records.length, 0);
  assert.equal((await handle(new Request("http://x/api/records"), deps)).status, 401);
  assert.equal((await handle(req("/api/records"), app())).status, 501);
});

// ---------------------------------------------------------------------------------- what the store does not do
test("the store has no logging, reads no model, and the Worker never reads a record except through the store", () => {
  const src = readFileSync(join(REPO, "worker", "src", "recordstore.ts"), "utf-8");
  assert.doesNotMatch(src, /console\./);
  assert.doesNotMatch(src, /anthropic|fetch\(/i);
  const handler = readFileSync(join(REPO, "worker", "src", "handler.ts"), "utf-8");
  assert.doesNotMatch(handler, /case_records/);
  // records are not part of what a question to the model carries
  const ask = readFileSync(join(REPO, "worker", "src", "anthropic.ts"), "utf-8");
  assert.doesNotMatch(ask, /recordstore|case_records/);
});

test("the record screen keeps nothing in the browser's own storage and talks only to /api/records, plus the search (retrieval only, no model) for a problem's book pages", () => {
  const ui = readFileSync(join(REPO, "web", "record-ui.js"), "utf-8").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(ui, /localStorage|sessionStorage|indexedDB|caches\./);
  const paths = [...ui.matchAll(/`(\/api\/[^`]*)`|"(\/api\/[^"]*)"/g)].map((m) => (m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, "{id}"));
  // stage 4b (docs/enhancement-plan.md 8.16): the search by a problem's name (/api/search: no model is called) is the one other path
  assert.deepEqual([...new Set(paths)].sort(), ["/api/records", "/api/records/{id}", "/api/search"]);
  assert.equal((ui.match(/\/api\/search/g) ?? []).length, 1, "one call site");
  // no AI: the screen never asks the model, and the model module never reads a record
  assert.doesNotMatch(ui, /\/api\/ask|\/api\/extract/);
  const model = readFileSync(join(REPO, "web", "case-record.js"), "utf-8");
  assert.doesNotMatch(model, /import .* from "\.\/(app|record-ui|conv)\.js"/);
});

// ---------------------------------------------------------------------------------- review follow-ups (PR #11)
test("store: two saves based on the same revision can not both win (the UPDATE checks the revision itself); a double create is one record", async () => {
  const s = recordStore(openRw(), { retentionDays: 60 });
  await s.put(ID(1), { record: rec({ title: "base" }) }, day(1));
  const r = await Promise.allSettled([s.put(ID(1), { rev: 1, record: rec({ title: "A" }) }, day(2)), s.put(ID(1), { rev: 1, record: rec({ title: "B" }) }, day(2))]);
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1, JSON.stringify(r.map((x: any) => x.status)));
  const lost: any = r.find((x) => x.status === "rejected");
  assert.ok(lost.reason instanceof RecordInputError && lost.reason.code === "conflict" && lost.reason.status === 409 && lost.reason.rev === 2);
  const won = (r.find((x) => x.status === "fulfilled") as any).value;
  assert.equal(won.rev, 2);
  assert.equal((await s.get(ID(1), day(2)))!.rev, 2);
  // the same id created twice at once: one record, the other save is a conflict (not a database error)
  const c = await Promise.allSettled([s.put(ID(2), { record: rec({ title: "A" }) }, day(2)), s.put(ID(2), { record: rec({ title: "B" }) }, day(2))]);
  assert.equal(c.filter((x) => x.status === "fulfilled").length, 1);
  assert.ok((c.find((x) => x.status === "rejected") as any).reason instanceof RecordInputError);
  assert.equal(((c.find((x) => x.status === "rejected") as any).reason as RecordInputError).code, "conflict");
  assert.equal((await s.list(day(2))).filter((x) => x.id === ID(2)).length, 1);
});

test("store: a database that does not report changed rows is not trusted (the save fails closed instead of assuming it won)", async () => {
  const real = openRw();
  const blind: any = {
    prepare(sql: string) {
      const p = real.prepare(sql);
      return { bind: (...v: unknown[]) => { const b: any = p.bind(...v); return { ...b, run: async () => { await b.run(); return undefined; } }; }, run: () => p.run() };
    },
  };
  const s = recordStore(blind, { retentionDays: 60 });
  await s.put(ID(1), { record: rec() }, day(1)); // an insert needs no count
  await assert.rejects(s.put(ID(1), { rev: 1, record: rec({ title: "x" }) }, day(2)), /did not report/);
});

test("store: keys and numbers are checked like values — no ID or phone number as a key, no number that could be one", async () => {
  const s = recordStore(openRw(), { retentionDays: 60 });
  for (const [where, r] of Object.entries({
    "digits as a key": rec({ "12345678901234": 1 }),
    "an ID-like key": rec({ "ID-12345678": "x" }),
    "a key starting with a digit": rec({ "1abc": "x" }),
    "an 11-digit number": rec({ n: 12345678901 }),
    "a phone number as a number": rec({ ed: { case: { complaint: "x", tel: 9012345678 } } }),
  })) await rejects(s.put(ID(1), { record: r }, day(1)), "bad_request", (e) => assert.ok(!/12345678|9012345678/.test(e.message), where));
  // what the screen really writes passes: question ids with a digit, lab values, counters
  await s.put(ID(1), { record: rec({ ed: { case: { intake: { flow: "emergency-department.abdominal-pain", answers: { spo2: 94, bp_r: 120, temp: 38.4, glu: 110000 } } } } }) }, day(1));
  assert.ok(MAX_NUMBER >= 1e9);
});
