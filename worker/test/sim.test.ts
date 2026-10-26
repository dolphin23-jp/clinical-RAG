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

test("engine: whether an item can be asked depends on what the doctor knows and did, never on the hidden setting", () => {
  const s = clone(V.valid);
  // a follow-up question that is visible only when a finding is known: the doctor must ask the finding first
  const flow = clone(V.flow);
  flow.questions.push({ id: "cold_where", slot: 1, label: "冷たい部位", type: "text", when: "limbs=cold", br: { ent: "observation" } });
  s.states[2].facts.push({ q: "cold_where", v: "手足の先", who: "患者", how: "診察" });
  const go = (log: any[]) => E.replay(s, flow, log, { readings });
  const notYet = go([{ act: "stage", to: "reassess" }, { act: "ask", q: "cold_where" }]); // limbs is cold in s2, but the doctor has not looked
  assert.equal(notYet.records.at(-1).reason, "hidden");
  assert.ok(!notYet.askable.includes("cold_where"));
  const known = go([{ act: "stage", to: "reassess" }, { act: "ask", q: "limbs" }, { act: "ask", q: "cold_where" }]);
  assert.equal(known.records.at(-1).value, "手足の先");
  assert.ok(known.askable.includes("cold_where"));
  // the askable list: fact questions only, results once they are back, acts' follow-ups once done
  const start = play([]);
  assert.deepEqual(start.askable, ["cc", "pmh", "allergy", "rr", "spo2", "limbs", "consc"]);
  assert.ok(play([{ act: "do", key: "tests=vbg" }]).askable.every((q: string) => q !== "vbg_lactate"));
  assert.ok(play([{ act: "do", key: "tests=vbg" }, { act: "wait" }]).askable.includes("vbg_lactate"));
  assert.ok(play([{ act: "do", key: "fluid=given" }]).askable.includes("rr_after"));
  assert.ok(!play([{ act: "do", key: "fluid=given" }]).askable.includes("fluid_resp")); // the doctor's reading
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

// ---------------------------------------------------------------------------------- step 1b: what the screen shows and keeps (web/sim-model.js)
const SM: any = await import(web("sim-model.js"));

test("screen model: the memo says what happened in the case's own sentences; refusals say why; no state id, no assumption", () => {
  const r = play([{ act: "ask", q: "rr" }, { act: "ask", q: "shock_judge" }, { act: "do", key: "tests=vbg" }, { act: "wait" }, { act: "say", type: "disposition", text: "入院" }]);
  const lines = SM.memoLines(V.valid, V.flow, r.records, 10);
  assert.deepEqual(lines.map((l: any) => [l.clock, l.who, l.text]), [
    ["02:10", "看護師", "呼吸数は、28 回/分。"],
    ["02:10", "", "その項目は先生が選ぶ項目です（症例は答えません）。"],
    ["02:10", "先生", "記録: 出した検査：vbg"],
    ["02:20", "", "── 待つ（時間が進む）"],
    ["02:20", "検査", "乳酸は、3.9。"],
    ["02:20", "先生", "行き先: 入院"],
  ]);
  assert.ok(!JSON.stringify(lines).includes("敗血症") && !JSON.stringify(lines).includes("s0"));
  assert.equal(SM.memoLines({ ...V.valid, clock: undefined }, V.flow, r.records, 10)[0].clock, "区切り0");
});

test("screen model: the tray takes nothing by itself; careful rows are one at a time; an answer the doctor has is never overwritten", () => {
  const s = clone(V.valid);
  s.states[0].facts.find((f: any) => f.q === "pmh").v = ["none"]; // a declared negative
  const flow = clone(V.flow);
  flow.questions.find((q: any) => q.id === "pmh").br.neg = ["none"];
  const r = E.replay(s, flow, [{ act: "ask", q: "rr" }, { act: "ask", q: "pmh" }, { act: "ask", q: "rr" }], { readings });
  const rows = SM.trayRows(flow, r.records, {});
  assert.deepEqual(rows.map((x: any) => [x.q, x.careful, x.filled]), [["rr", false, false], ["pmh", true, false], ["rr", false, false]]);
  // taken: the first rr goes in; the second rr does not overwrite it
  const a1 = SM.takeRows(flow, {}, [rows[0]]);
  assert.deepEqual(a1, { rr: 28 });
  assert.deepEqual(SM.takeRows(flow, a1, [rows[2]]), { rr: 28 });
  assert.equal(SM.trayRows(flow, r.records, a1)[2].filled, true);
  // a result's items are rows too
  const res = play([{ act: "do", key: "tests=vbg" }, { act: "wait" }]);
  assert.deepEqual(SM.trayRows(V.flow, res.records, {}).map((x: any) => [x.q, x.who]), [["vbg_lactate", "検査"]]);
});

test("screen model: the doctor's act becomes the answer of the action question, with the shown clock in its time question when that is empty", () => {
  const flow = clone(V.flow);
  flow.questions.find((q: any) => q.id === "fluid").br.at = "t_arrival"; // a time question declared by the act (fixture)
  assert.deepEqual(SM.applyAct(flow, {}, "fluid=given", "02:30"), { fluid: "given", t_arrival: "02:30" });
  assert.deepEqual(SM.applyAct(flow, { t_arrival: "02:10" }, "fluid=given", "02:30"), { t_arrival: "02:10", fluid: "given" });
  assert.deepEqual(SM.applyAct(V.flow, { tests: ["ecg"] }, "tests=vbg", ""), { tests: ["ecg", "vbg"] });
  assert.deepEqual(SM.applyAct(V.flow, {}, "rr=1", "02:10"), {}); // not an act
  assert.deepEqual(SM.boardQuestions(V.flow).map((q: any) => q.id), ["tests", "fluid"]);
});

test("screen model: the doctor fills in the readings and decisions; the note's case holds nothing of the hidden setting", () => {
  const flow = clone(V.flow);
  flow.phases = [{ id: "p1", name: "全部", short: "全部", slots: [1] }];
  const groups = SM.doctorQuestions(flow, { fluid: "given" }, "男性", readings);
  assert.deepEqual(groups[0].questions.map((q: any) => q.id), ["fluid_resp", "shock_judge", "dispo"]);
  assert.deepEqual(SM.doctorQuestions(flow, {}, "男性", readings)[0].questions.map((q: any) => q.id), ["shock_judge", "dispo"]); // fluid_resp shows after the act
  const k = SM.simKase(V.valid, flow, { rr: 28 }, " 自分の評価 ");
  assert.equal(k.own, "自分の評価");
  assert.equal(k.age, "70");
  assert.deepEqual(k.intake, { flow: "fixture.sim", answers: { rr: 28 } });
  assert.ok(!JSON.stringify(k).includes("敗血症") && !JSON.stringify(k).includes("states"));
});

test("screen model: the debrief lays the key items side by side (before / after the disposition / not asked), no judgment words", () => {
  const before = play([{ act: "ask", q: "limbs" }, { act: "say", type: "disposition", text: "入院" }]);
  assert.deepEqual(SM.debrief(V.valid, V.flow, before.records).key, [{ q: "limbs", label: "四肢の所見", status: "before" }]);
  const after = play([{ act: "say", type: "disposition", text: "入院" }, { act: "ask", q: "limbs" }]);
  assert.equal(SM.debrief(V.valid, V.flow, after.records).key[0].status, "after");
  assert.equal(SM.debrief(V.valid, V.flow, play([]).records).key[0].status, "never");
  assert.ok(!/正解|誤り|見逃し|遅い|適切/.test(JSON.stringify(SM.KEY_STATUS)));
});

test("screen model: a pasted setting is read, checked, and only an emergency flow of the imported schema is played", () => {
  const FLOWS = { "fixture.sim": V.flow, "emergency-department.fixture": { ...V.flow, id: "emergency-department.fixture" } };
  assert.equal(SM.parseSetting("{", FLOWS, readings).error, "JSON として読めません。");
  assert.match(SM.parseSetting(JSON.stringify(V.valid), FLOWS, readings).error, /救急外来/);
  const ok = SM.parseSetting(JSON.stringify({ ...V.valid, flow: "emergency-department.fixture" }), FLOWS, readings);
  assert.equal(ok.ok, true);
  const bad = SM.parseSetting(JSON.stringify({ ...V.valid, flow: "emergency-department.fixture", opening: [{ who: "救急隊", text: "敗血症性ショックです。" }] }), FLOWS, readings);
  assert.equal(bad.ok, false);
  assert.ok(bad.report.errors.some((e: any) => e.code === "leak_dx"));
  // the readings of a simulation: JUDGMENT_IDS without the raw bedside data the case shows
  const R = SM.simReadings(new Set(["first", "hi", "orth", "re_change"]));
  assert.deepEqual([...R], ["first", "re_change"]);
});

test("the simulation's screen modules send nothing, keep nothing in the browser and write no HTML", () => {
  for (const [file, imports] of [
    ["sim-model.js", ["./sim-case.js", "./sim-engine.js", "./intake.js"]],
    ["sim-ui.js", ["./sim-case.js", "./sim-engine.js", "./sim-model.js", "./extract-model.js", "./note-assemble.js", "./intake.js", "./id-guard.js"]],
  ] as const) {
    const src = readFileSync(web(file), "utf-8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.deepEqual([...src.matchAll(/^import [\s\S]*? from "(.+)";$/gm)].map((m) => m[1]), imports, file);
    assert.ok(!/\b(fetch|XMLHttpRequest|localStorage|sessionStorage|indexedDB|innerHTML|outerHTML|insertAdjacentHTML|sendBeacon|print\(|navigator\.share|Math\.random|Date\.now)\b/.test(code), `${file} touches something it must not`);
    // the only network use: /api/sim, through the app's own api() (sim-model.js has none)
    assert.deepEqual([...code.matchAll(/\/api\/[a-z/]*/g)].map((m) => m[0]), file === "sim-ui.js" ? ["/api/sim"] : [], file);
    assert.equal([...code.matchAll(/\bapi\(/g)].length, file === "sim-ui.js" ? 1 : 0, file);
  }
  // the only lazy import of the screen is the imported flows
  assert.deepEqual([...readFileSync(web("sim-ui.js"), "utf-8").matchAll(/import\("(.+?)"\)/g)].map((m) => m[1]), ["./flow-schema.js"]);
  // the copy of the note carries the fictional header, and the screen never calls the assumption "the answer"
  const ui = readFileSync(web("sim-ui.js"), "utf-8");
  assert.ok(ui.includes("`${SIM_HEADER}\\n${toText(note)}`"));
  assert.ok(!/正解/.test(ui + readFileSync(web("sim-model.js"), "utf-8")));
});

// ---------------------------------------------------------------------------------- continuations written by the AI (step 2; D4 c)
const AI_ORIGIN = { by: "ai", sources: [{ id: "fx:ch01:A", title: "試験の書籍", page: "p.1" }] };
const aiSetting = (edit?: (s: any) => void) => {
  const s = clone(V.valid);
  s.origin = clone(AI_ORIGIN);
  edit?.(s);
  return s;
};
const withoutS0 = (q: string) => aiSetting((s) => (s.states[0].facts = s.states[0].facts.filter((f: any) => f.q !== q)));

test("a boundary continuation takes the place of the moves at its act, and changes nothing told before it", () => {
  const s = aiSetting();
  const log = [{ act: "ask", q: "rr" }, { act: "do", key: "fluid=given" }, { act: "wait" }, { act: "ask", q: "rr" }];
  const was = play(log, s);
  assert.equal(was.internal.state, "s1", "without a continuation the setting's move is taken");
  const frozen = JSON.stringify(s);
  const r = SM.addContinuation(s, V.flow, log.slice(0, 3), { kind: "boundary", after: 2, facts: [{ q: "rr", v: 40, who: "看護師", how: "測定" }], event: { who: "看護師", text: "試験の続き。" }, basis: ["fx:ch01:A"] }, readings);
  assert.deepEqual(r.errors, []);
  assert.equal(JSON.stringify(s), frozen, "the setting given is not changed");
  const now = play(log, r.setting);
  assert.equal(now.internal.state, "s3");
  assert.deepEqual(now.records.filter((x: any) => x.seq <= 2), was.records.filter((x: any) => x.seq <= 2), "what was told before the boundary is the same");
  assert.ok(now.records.some((x: any) => x.kind === "event" && x.text === "試験の続き。"));
  assert.equal(now.records.at(-1).value, 40);
  // the new state is the state before the boundary with the AI's values laid over it
  const s3 = r.setting.states.find((x: any) => x.id === "s3");
  assert.deepEqual(C.effectiveFacts(r.setting, "s3").limbs, C.effectiveFacts(s, "s0").limbs);
  assert.equal(s3.event.text, "試験の続き。");
  assert.deepEqual(r.setting.cont, [{ after: 2, kind: "boundary", to: "s3", basis: ["fx:ch01:A"] }]);
  // nothing changes: the case stays, with the event only
  const q = SM.addContinuation(s, V.flow, log.slice(0, 3), { kind: "boundary", after: 2, facts: [], event: { who: "家族", text: "家族が到着しました。" }, basis: [] }, readings);
  assert.deepEqual(q.setting.cont, [{ after: 2, kind: "boundary", to: null, event: { who: "家族", text: "家族が到着しました。" }, basis: [] }]);
  assert.equal(play(log, q.setting).internal.state, "s0", "the continuation takes the place of the move: the case stays");
  // only at a boundary act, and only one per act
  assert.ok(!SM.addContinuation(s, V.flow, log, { kind: "boundary", after: 0, facts: [] }, readings).ok);
  assert.ok(!SM.addContinuation(r.setting, V.flow, log.slice(0, 3), { kind: "boundary", after: 2, facts: [{ q: "rr", v: 41, who: "看護師", how: "測定" }] }, readings).ok);
});

test("a fill gives values for items the state has none for, before the next act, with no time passing", () => {
  const s = withoutS0("spo2");
  assert.ok(SM.needsFill(s, V.flow, [], "spo2", readings));
  assert.ok(!SM.needsFill(s, V.flow, [], "rr", readings), "an item with a value needs no fill");
  assert.ok(!SM.needsFill(s, V.flow, [], "vbg_lactate", readings), "a result is not asked before it is back");
  assert.equal(play([{ act: "ask", q: "spo2" }], s).records[0].kind, "nodata");
  const r = SM.addContinuation(s, V.flow, [], { kind: "fill", after: 0, facts: [{ q: "spo2", v: 95, who: "看護師", how: "測定" }] }, readings);
  assert.deepEqual(r.errors, []);
  const p = play([{ act: "ask", q: "spo2" }], r.setting);
  assert.equal(p.records[0].value, 95);
  assert.equal(p.t, 0, "no time passes");
  assert.ok(!SM.needsFill(r.setting, V.flow, [], "spo2", readings));
  // only items without a value, only at the end of the log
  assert.ok(!SM.addContinuation(s, V.flow, [], { kind: "fill", after: 0, facts: [{ q: "rr", v: 10, who: "看護師", how: "測定" }] }, readings).ok);
  assert.ok(!SM.addContinuation(s, V.flow, [{ act: "wait" }], { kind: "fill", after: 0, facts: [{ q: "spo2", v: 95, who: "看護師", how: "測定" }] }, readings).ok);
  assert.ok(!SM.addContinuation(s, V.flow, [], { kind: "fill", after: 0, facts: [] }, readings).ok);
  // a reading is never filled (the screen's check refuses it)
  assert.ok(!SM.addContinuation(withoutS0("rr"), V.flow, [], { kind: "fill", after: 0, facts: [{ q: "shock_judge", v: "shock", who: "看護師", how: "測定" }] }, readings).ok);
  // an order whose result has no value yet asks for it first
  const o = withoutS0("vbg_lactate");
  assert.deepEqual(SM.orderNeeds(o, V.flow, [], "tests=vbg", readings), ["vbg_lactate"]);
  assert.deepEqual(SM.orderNeeds(s, V.flow, [], "tests=vbg", readings), []);
});

test("continuations over 200 random logs: what was told before a continuation never changes", () => {
  const rnd = lcg(1026);
  const base = withoutS0("spo2");
  let fills = 0;
  let bounds = 0;
  for (let n = 0; n < 200; n++) {
    const log = randomLog(rnd);
    const k = Math.floor(rnd() * (log.length + 1));
    const was = play(log, base);
    const kept = (r: any) => r.records.filter((x: any) => x.seq <= k);
    if (SM.needsFill(base, V.flow, log.slice(0, k), "spo2", readings)) {
      const r = SM.addContinuation(base, V.flow, log.slice(0, k), { kind: "fill", after: k, facts: [{ q: "spo2", v: 97, who: "看護師", how: "測定" }] }, readings);
      assert.deepEqual(r.errors, []);
      assert.deepEqual(kept(play(log, r.setting)), kept(was));
      fills++;
    }
    const b = log.findIndex((a: any, i: number) => i >= k && (a.act === "wait" || (a.act === "stage" && play(log.slice(0, i + 1), base).records.at(-1)?.kind !== "refused")));
    if (b >= 0) {
      const r = SM.addContinuation(base, V.flow, log.slice(0, b + 1), { kind: "boundary", after: b, facts: [{ q: "rr", v: 44, who: "看護師", how: "測定" }], basis: [] }, readings);
      assert.deepEqual(r.errors, []);
      const now = play(log, r.setting);
      assert.deepEqual(now.records.filter((x: any) => x.seq <= b), was.records.filter((x: any) => x.seq <= b));
      assert.deepEqual(play(log, r.setting), now, "still deterministic");
      bounds++;
    }
  }
  assert.ok(fills > 20 && bounds > 20, `${fills} fills, ${bounds} boundaries`);
});

test("the check of continuations: shape, sections of the setting only, one per act, never the background changed, never in the moves", () => {
  const ok = SM.addContinuation(aiSetting(), V.flow, [{ act: "wait" }], { kind: "boundary", after: 0, facts: [{ q: "rr", v: 40, who: "看護師", how: "測定" }], basis: [] }, readings).setting;
  const codes = (s: any) => C.validateSimCase(s, V.flow, { readings, strict: false }).errors.map((e: any) => e.code);
  assert.deepEqual(codes(ok), []);
  const mut = (f: (s: any) => void) => {
    const s = clone(ok);
    f(s);
    return codes(s);
  };
  assert.ok(mut((s) => (s.cont[0].basis = ["not:given"])).includes("basis"), "a section the setting was not written from");
  assert.ok(mut((s) => s.cont.push({ ...s.cont[0], to: null })).includes("cont"), "two continuations for one act");
  assert.ok(mut((s) => (s.cont[0].to = "s0")).includes("cont"));
  assert.ok(mut((s) => (s.cont[0].kind = "later")).includes("cont"));
  assert.ok(mut((s) => (s.cont[0].after = -1)).includes("cont"));
  assert.ok(mut((s) => (s.cont[0].extra = 1)).includes("unknown_key"));
  assert.ok(mut((s) => s.cont.push({ after: 3, kind: "fill", to: null, basis: [] })).includes("cont"), "a fill moves to the state with the values");
  assert.ok(mut((s) => s.moves.push({ from: "s3", to: "s1", at: "next", basis: [] })).includes("move"), "a continuation's state is not in the moves");
  assert.ok(mut((s) => s.states[3].facts.push({ q: "allergy", v: "drug", who: "患者", how: "問診" })).includes("background_changes"));
  assert.ok(mut((s) => (s.cont[0].event = { who: "看護師", text: "対応が遅れたため悪化。" })).includes("eval_word"));
  assert.ok(mut((s) => (s.origin = { by: "robot", sources: [] })).includes("origin"));
  // a background item s0 had no value for may be filled later (one value only)
  const filled = SM.addContinuation(withoutS0("allergy"), V.flow, [], { kind: "fill", after: 0, facts: [{ q: "allergy", v: "none", who: "患者", how: "問診" }] }, readings);
  assert.deepEqual(filled.errors, []);
  // the states a continuation made do not count against the setting's own limit
  let s = aiSetting();
  const log: any[] = [];
  for (let i = 0; i < 10; i++) {
    log.push({ act: "wait" });
    const r = SM.addContinuation(s, V.flow, log, { kind: "boundary", after: i, facts: [{ q: "rr", v: 20 + i, who: "看護師", how: "測定" }], basis: [] }, readings);
    assert.deepEqual(r.errors, [], `continuation ${i}`);
    s = r.setting;
  }
  assert.equal(s.states.length, 13);
  assert.equal(play(log, s).records.filter((x: any) => x.kind === "boundary").length, 10);
  // playing again from the start: the setting as it was written
  const b = SM.baseSetting(s);
  assert.equal(b.cont, undefined);
  assert.deepEqual(b.states.map((x: any) => x.id), ["s0", "s1", "s2"]);
  assert.deepEqual(play(log, b), play(log, aiSetting()));
});
