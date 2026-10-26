// A simulated fictional case, step 1a (docs/enhancement-plan.md 8.21): the checks a setting must pass (web/sim-case.js) and the engine that plays
// it back from the doctor's acts (web/sim-engine.js).  Both are pure.  The flow and the setting are a made-up fixture (tests/vectors/simcase.json),
// not a real flow and not clinical content: what is pinned is how the engine behaves, not what a patient is like.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO } from "./nodeDb.ts";

const web = (f: string) => join(REPO, "web", f);
const C: any = await import(web("sim-case.js"));
const E: any = await import(web("sim-engine.js"));
const V: any = JSON.parse(readFileSync(join(REPO, "tests", "vectors", "simcase.json"), "utf-8"));
const readings = new Set<string>(V.readings);
const clone = (x: any) => JSON.parse(JSON.stringify(x));
const check = (s: any, opts: any = {}) => C.validateSimCase(s, V.flow, { readings, ...opts });
const play = (log: any[], s: any = V.valid) => E.replay(s, V.flow, log, { readings });

/** The vector's edits of a setting: { path, set | push | delete }. */
function edit(setting: any, ops: any[]) {
  const s = clone(setting);
  for (const op of ops) {
    const at = op.path.slice(0, -1).reduce((o: any, k: any) => o[k], s);
    const last = op.path[op.path.length - 1];
    if ("push" in op) (op.path.reduce((o: any, k: any) => o[k], s) as any[]).push(op.push);
    else if (op.delete) Array.isArray(at) ? at.splice(last, 1) : delete at[last];
    else at[last] = op.set;
  }
  return s;
}

// ---------------------------------------------------------------------------------- the checks
test("the vector's setting passes; the move without a book section is reported as inferred, not refused", () => {
  const r = check(V.valid);
  assert.deepEqual(r, { ok: true, errors: [], inferred: [1], missing: [] });
});

for (const m of V.mutations) {
  test(`check: ${m.name} -> ${m.code}`, () => {
    const r = check(edit(V.valid, m.ops));
    assert.ok(!r.ok, "an invalid setting passed");
    assert.ok(r.errors.some((e: any) => e.code === m.code), `expected ${m.code}, got ${JSON.stringify(r.errors.map((e: any) => e.code))}`);
  });
}

test("check: coverage is for the author's setting (strict); a looser check lets a missing value through, and says which", () => {
  const s = edit(V.valid, V.mutations.find((m: any) => m.code === "coverage").ops);
  assert.deepEqual(check(s).missing, ["limbs"]);
  const loose = check(s, { strict: false });
  assert.equal(loose.ok, true);
  assert.deepEqual(loose.missing, []);
});

test("check: a question the doctor's reading holds is not a fact whatever its entity says (the caller's list), and a pre-arrival time may be held when it is named", () => {
  const s = clone(V.valid);
  s.states[0].facts.push({ q: "t_arrival", v: "02:10", who: "救急隊", how: "救急隊の測定" });
  assert.ok(!check(s).ok);
  assert.ok(check(s, { preArrival: new Set(["t_arrival"]) }).ok);
  const r = clone(V.valid);
  r.states[1].facts.push({ q: "fluid_resp", v: "better", who: "患者", how: "診察" });
  assert.ok(!check(r).ok && check(r, { readings: new Set() }).errors.every((e: any) => e.code !== "reading_value"), "without the caller's list the question is an observation");
});

test("check: not an object, wrong flow, wrong version", () => {
  assert.equal(check(null).errors[0].code, "shape");
  assert.ok(check({ ...V.valid, flow: "other" }).errors.some((e: any) => e.code === "flow"));
  assert.ok(check({ ...V.valid, v: 2 }).errors.some((e: any) => e.code === "version"));
});

// ---------------------------------------------------------------------------------- the engine
test("engine: asked items answer with the value of the case; the doctor's reading is refused; a result waits for the next boundary", () => {
  const r = play([
    { act: "ask", q: "rr" },
    { act: "ask", q: "fluid_resp" }, // the doctor's reading
    { act: "ask", q: "vbg_lactate" }, // not visible before it is ordered
    { act: "do", key: "tests=vbg" },
    { act: "ask", q: "vbg_lactate" }, // ordered, not back yet
    { act: "wait" },
    { act: "ask", q: "vbg_lactate" },
  ]);
  assert.deepEqual(r.records.map((x: any) => [x.seq, x.t, x.kind, x.reason ?? x.q ?? x.key ?? ""]), [
    [1, 0, "answer", "rr"],
    [2, 0, "refused", "reading"],
    [3, 0, "refused", "hidden"],
    [4, 0, "do", "tests=vbg"],
    [5, 0, "refused", "not_ready"],
    [6, 1, "boundary", ""],
    [6, 1, "result", "tests=vbg"],
    [7, 1, "answer", "vbg_lactate"],
  ]);
  assert.deepEqual(r.records[1], { seq: 2, t: 0, kind: "refused", act: "ask", reason: "reading" });
  assert.deepEqual(r.records[6].items, [{ q: "vbg_lactate", value: 3.9, who: "検査", how: "検査" }]);
  assert.equal(r.pending.length, 0);
  assert.equal(r.t, 1);
});

test("engine: an act moves the case at the next boundary; the event arrives with it; the earlier records are not rewritten", () => {
  const r = play([{ act: "ask", q: "rr" }, { act: "do", key: "fluid=given" }, { act: "wait" }, { act: "ask", q: "rr" }]);
  const answers = r.records.filter((x: any) => x.kind === "answer");
  assert.deepEqual(answers.map((x: any) => x.value), [28, 22]); // asked again: the value of the state the case is in now, as a new record
  assert.deepEqual(r.records.find((x: any) => x.kind === "event"), { seq: 3, t: 1, kind: "event", who: "看護師", text: "呼吸が少し楽になった様子です。" });
  assert.equal(r.internal.state, "s1");
  assert.equal(r.records[0].value, 28);
});

test("engine: an order's result comes back at the next boundary, before the case moves on at that same boundary: it has the values of the state the order was made in", () => {
  const early = play([{ act: "do", key: "tests=vbg" }, { act: "do", key: "fluid=given" }, { act: "wait" }]); // the case moves on at this boundary; the result is still the earlier state's
  const r = early.records;
  assert.deepEqual(r.map((x: any) => x.kind), ["do", "do", "boundary", "result", "event"]); // result first, then the move and its event
  assert.equal(r.find((x: any) => x.kind === "result").items[0].value, 3.9);
  assert.equal(early.internal.state, "s1");
  const late = play([{ act: "do", key: "fluid=given" }, { act: "wait" }, { act: "do", key: "tests=vbg" }, { act: "wait" }]);
  assert.equal(late.records.find((x: any) => x.kind === "result").items[0].value, 2.1); // ordered in s1
  // an answer to the result question is the delivered value, also after the case has moved on; ordering again gives the new state's value
  const after = play([{ act: "do", key: "tests=vbg" }, { act: "do", key: "fluid=given" }, { act: "wait" }, { act: "ask", q: "vbg_lactate" }, { act: "do", key: "tests=vbg" }, { act: "wait" }, { act: "ask", q: "vbg_lactate" }]);
  assert.deepEqual(after.records.filter((x: any) => x.kind === "answer").map((x: any) => x.value), [3.9, 2.1]);
});

test("engine: no act -> the natural course after the doctor enters the stage; time alone does not move the case", () => {
  const s2 = play([{ act: "stage", to: "reassess" }, { act: "ask", q: "consc" }, { act: "ask", q: "limbs" }, { act: "ask", q: "rr" }]);
  assert.deepEqual(s2.records.filter((x: any) => x.kind === "answer").map((x: any) => x.value), ["drowsy", "cold", 32]);
  assert.equal(s2.records.find((x: any) => x.kind === "event").text, "呼びかけへの反応が鈍くなっています。");
  assert.equal(s2.stage, "reassess");
  const idle = play([{ act: "wait" }, { act: "wait" }, { act: "wait" }, { act: "ask", q: "rr" }]);
  assert.equal(idle.internal.state, "s0");
  assert.equal(idle.t, 3);
  assert.equal(idle.records.at(-1).value, 28);
  // an act done after the stage was entered still counts at the next boundary; one that was never done lets the natural move happen
  assert.equal(play([{ act: "stage", to: "workup" }, { act: "do", key: "fluid=given" }, { act: "stage", to: "reassess" }]).internal.state, "s1");
  assert.equal(play([{ act: "stage", to: "workup" }, { act: "do", key: "fluid=held" }, { act: "stage", to: "reassess" }]).internal.state, "s2");
});

test("engine: asking and examining take no time; the careful doctor loses nothing", () => {
  const many = play(Array.from({ length: 30 }, () => ({ act: "ask", q: "rr" })));
  assert.equal(many.t, 0);
  assert.equal(many.records.length, 30);
});

test("engine: what the setting does not hold is told as no data, never as normal or negative", () => {
  const s = clone(V.valid);
  s.states[0].facts = s.states[0].facts.filter((f: any) => f.q !== "spo2");
  const r = play([{ act: "ask", q: "spo2" }], s);
  assert.deepEqual(r.records, [{ seq: 1, t: 0, kind: "nodata", q: "spo2" }]);
  assert.match(E.NO_DATA, /設定がありません/);
  assert.match(E.NO_DATA, /陰性ではありません/);
});

test("engine: a refused act changes nothing; every refusal has a reason", () => {
  const r = play([
    { act: "ask", q: "zzz" },
    { act: "ask", q: "t_arrival" },
    { act: "ask", q: "shock_judge" },
    { act: "ask", q: "dispo" },
    { act: "do", key: "nope=1" },
    { act: "do", key: "fluid=nothing" },
    { act: "say", type: "chat", text: "x" },
    { act: "say", type: "explain", text: " " },
    { act: "say", type: "explain", text: "x".repeat(E.SAY_LIMIT + 1) },
    { act: "stage", to: "nope" },
    { act: "dance" },
    "not an act",
    null,
  ]);
  assert.deepEqual(r.records.map((x: any) => x.reason), ["unknown_q", "not_a_fact", "reading", "reading", "unknown_key", "unknown_key", "bad_say", "bad_say", "bad_say", "bad_stage", "act", "act", "act"]);
  assert.equal(r.t, 0);
  assert.equal(r.internal.state, "s0");
  assert.equal(r.stage, "stabilize");
  const back = play([{ act: "stage", to: "reassess" }, { act: "stage", to: "workup" }, { act: "stage", to: "reassess" }]);
  assert.deepEqual(back.records.filter((x: any) => x.kind === "refused").map((x: any) => x.reason), ["stage_back", "stage_back"]);
});

test("engine: the doctor's words are kept as written, and the case does not move on them", () => {
  const r = play([{ act: "say", type: "disposition", text: "  入院で経過をみます。 " }]);
  assert.deepEqual(r.records, [{ seq: 1, t: 0, kind: "say", type: "disposition", text: "入院で経過をみます。" }]);
  assert.equal(r.internal.state, "s0");
});

test("clock: shown only; one segment is a uniform number of minutes the doctor chose; no clock, no time", () => {
  assert.equal(E.clockAt(V.valid, 0, 5), "02:10");
  assert.equal(E.clockAt(V.valid, 3, 5), "02:25");
  assert.equal(E.clockAt(V.valid, 50, 30), "03:10"); // wraps after midnight, without a date
  assert.equal(E.clockAt({ ...V.valid, clock: undefined }, 1, 5), "");
  assert.equal(E.clockAt(V.valid, 1, -1), "");
  assert.equal(play([{ act: "wait" }]).t, 1); // the case's time is counted in segments; the clock does not feed back
});

// ---------------------------------------------------------------------------------- properties over random logs (a seeded generator: the module itself has none)
function lcg(seed: number) {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
const ASKS = V.flow.questions.map((q: any) => q.id).concat(["zzz"]);
const POOL: any[] = [
  ...ASKS.map((q: string) => ({ act: "ask", q })),
  ...["tests=vbg", "tests=ecg", "tests=none", "fluid=given", "fluid=held", "nope=1"].map((key) => ({ act: "do", key })),
  { act: "say", type: "explain", text: "説明しました。" },
  { act: "say", type: "bad", text: "x" },
  { act: "wait" },
  { act: "wait" },
  ...["stabilize", "workup", "reassess", "close", "nope"].map((to) => ({ act: "stage", to })),
  { act: "dance" },
];
const randomLog = (rnd: () => number) => Array.from({ length: Math.floor(rnd() * 24) }, () => POOL[Math.floor(rnd() * POOL.length)]);
const NOT_FACT = new Set(V.flow.questions.filter((q: any) => ["assessment", "reason", "none", "action", "time"].includes(q.br.ent) || readings.has(q.id)).map((q: any) => q.id));
const BACKGROUND = V.flow.questions.filter((q: any) => q.br.ent === "context").map((q: any) => q.id);

test("engine: properties over 400 random logs (deterministic; a prefix of the log gives the start of the records; nothing it must not tell is told)", () => {
  const rnd = lcg(20261026);
  for (let n = 0; n < 400; n++) {
    const log = randomLog(rnd);
    const full = play(log);
    assert.deepEqual(play(log), full, "the same log must give the same result");
    const cut = Math.floor(rnd() * (log.length + 1));
    const head = play(log.slice(0, cut));
    assert.deepEqual(full.records.slice(0, head.records.length), head.records, "a prefix of the log gives the start of the records");
    // nothing it must not tell
    const json = JSON.stringify(full.records);
    assert.ok(!json.includes("敗血症性ショック") && !json.includes("出血性ショック"), "the author's assumption is never in a record");
    assert.ok(!/"state"|"assumed"|"truth"/.test(json), "the state and the assumption stay in `internal`");
    for (const r of full.records) {
      if (r.kind === "answer") assert.ok(!NOT_FACT.has(r.q), `${r.q} is not a fact the case holds`);
    }
    // a result comes only after an order of the same key, and only at a boundary
    full.records.forEach((r: any, i: number) => {
      if (r.kind !== "result") return;
      assert.ok(full.records.slice(0, i).some((x: any) => x.kind === "do" && x.key === r.key && x.t < r.t), "a result before its order");
      assert.equal(full.records[i - 1].kind === "boundary" || full.records[i - 1].kind === "result", true, "a result outside a boundary");
    });
    // time moves at a boundary only
    assert.equal(full.t, full.records.filter((r: any) => r.kind === "boundary").length);
    // the background never changes
    for (const q of BACKGROUND) {
      const seen = new Set(full.records.filter((r: any) => r.kind === "answer" && r.q === q).map((r: any) => JSON.stringify(r.value)));
      assert.ok(seen.size <= 1, `${q} changed over time`);
    }
    // an asked result question is answered with a delivered value only
    for (const [i, r] of full.records.entries()) {
      if (r.kind === "answer" && r.q === "vbg_lactate") assert.ok(full.records.slice(0, i).some((x: any) => x.kind === "result"), "an answer before any result");
    }
  }
});

// ---------------------------------------------------------------------------------- the pins: these modules stay pure
test("sim-case.js and sim-engine.js are pure: no DOM, network, storage, clock, random or AI; only the imports that are listed", () => {
  for (const [file, imports] of [
    ["sim-case.js", ["./case-create.js", "./intake.js"]],
    ["sim-engine.js", ["./sim-case.js", "./intake.js"]],
  ] as const) {
    const src = readFileSync(web(file), "utf-8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.deepEqual([...src.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]), imports, file);
    assert.ok(!/\b(fetch|XMLHttpRequest|localStorage|sessionStorage|indexedDB|document|window|navigator|Math\.random|Date\.now|new Date|setTimeout|setInterval|crypto|innerHTML|\/api\/)\b/.test(code), `${file} touches something it must not`);
  }
  // the shared vector says what it is
  assert.match(V._note, /臨床の中身ではない/);
  assert.equal(V.flow.id, "fixture.sim");
  assert.equal(V.valid.flow, V.flow.id);
});
