// Evaluation of the simulation's AI calls (docs/enhancement-plan.md 8.21, step 2): how often a setting the AI wrote passes the screen's own check
// (web/sim-case.js, strict: every fact has a value), how often after the one repair the screen asks for, what the checks refuse (by error code),
// whether text is copied from a book, and whether a continuation (a wait, and the theme's act then a wait) passes.  It needs the real model and
// costs requests (about 4-6 per theme).  Nothing is stored by the Worker; the results are printed and, with --out, written to a file (put it
// under work/, which git ignores).  The themes are invented names of diseases and symptoms (eval/sim.invented.jsonl), not patients.
//
//   against the deployed Worker (the whole path, with its books; each call counts in the daily cap):
//     MEDBOOK_TOKEN=... node --no-warnings eval/run_sim_eval.ts --api https://<worker> eval/sim.invented.jsonl [--verbose] [--course 3] [--out work/sim_eval.json]
//   --local: straight to the Anthropic API from this machine (a key in ANTHROPIC_API_KEY, or the variable named by --key-env), running the same code
//     as the Worker (worker/src/sim.ts).  The books come from a local database built by `python3 -m ingest build` (--db library.sqlite); without
//     one the AI writes from no book section.  [--model <id>] (default: claude-opus-5-5)
//     ANTHROPIC_API_KEY=... node --no-warnings eval/run_sim_eval.ts --local --db library.sqlite eval/sim.invented.jsonl --out work/sim_eval.json
//
// Reading the result: "author ok" (first try) and "after repair" are the share the doctor gets a case from; the error codes say what the AI
// gets wrong (coverage = a fact without a value; leak_dx = the diagnosis in a text; eval_word, dose, threshold, date, identifier; copied = a book
// sentence).  A refused answer is never used by the screen, so these cost the doctor time, not safety.  The doctor reads the settings in
// --verbose (the opening, the facts, the continuation's event) for whether they make sense: no check can tell that.
import { readFileSync, writeFileSync } from "node:fs";
import { SIM_CATALOG_SOURCE } from "../worker/src/sim-catalog.ts";
import { ExtractUpstreamError } from "../worker/src/extract.ts";
import { parseSimRequest, runSim } from "../worker/src/sim.ts";
import { accessHeaders } from "./lib.ts";
import { openDb } from "../worker/test/nodeDb.ts";
import type { Db } from "../worker/src/db.ts";

const args: string[] = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const WITH_VALUE = ["--api", "--out", "--key-env", "--model", "--db", "--anthropic-base", "--course"];
const positional = args.filter((a, i) => !a.startsWith("--") && !WITH_VALUE.includes(args[i - 1] ?? ""));
const local = args.includes("--local");
const apiBase = opt("--api");
const path = positional[0];
const token = process.env.MEDBOOK_TOKEN ?? "";
const keyEnv = opt("--key-env") ?? "ANTHROPIC_API_KEY";
const apiKey = process.env[keyEnv] ?? "";
if (!path || (!local && !apiBase)) {
  console.error("usage: MEDBOOK_TOKEN=... node --no-warnings eval/run_sim_eval.ts --api https://<worker> <themes.jsonl> [--verbose] [--out work/sim_eval.json]");
  console.error("   or: ANTHROPIC_API_KEY=... node --no-warnings eval/run_sim_eval.ts --local [--db library.sqlite] [--model <id>] <themes.jsonl> [--verbose] [--out work/sim_eval.json]");
  process.exit(2);
}
if (local && apiKey.length < 16) {
  console.error(`--local needs the Anthropic API key in the environment variable ${keyEnv} (the key is not printed, not written to --out, and not sent anywhere but the Anthropic API)`);
  process.exit(2);
}
if (!local && token.length < 16) {
  console.error("set the access token in the environment variable MEDBOOK_TOKEN (the APP_TOKEN of the Worker)");
  process.exit(2);
}
// @ts-ignore plain JavaScript, no declaration file
const { FLOWS } = (await import("../web/flow-schema.js")) as { FLOWS: Record<string, any> };
// @ts-ignore plain JavaScript, no declaration file
const SM = (await import("../web/sim-model.js")) as any;
// @ts-ignore plain JavaScript, no declaration file
const { JUDGMENT_IDS } = (await import("../web/extract-model.js")) as any;
const readings = SM.simReadings(JUDGMENT_IDS);
const verbose = args.includes("--verbose");
const courseDays = Number(opt("--course") ?? 0);
if (courseDays && !SM.WARD_DAYS.includes(courseDays)) {
  console.error(`--course は ${SM.WARD_DAYS.join("・")} のどれか`);
  process.exit(2);
}
const emptyDb: Db = { all: async () => [] } as unknown as Db;
const db: Db = local && opt("--db") ? openDb(opt("--db") as string) : emptyDb;
const model = opt("--model") ?? "claude-opus-5-5";

interface Theme {
  id: string;
  flow: string;
  theme: string;
  level: string;
  act?: string;
}
const themes: Theme[] = readFileSync(path, "utf-8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

let calls = 0;
const tokens = { input: 0, output: 0, cache_read: 0 };
/** One /api/sim call, of the deployed Worker or (--local) of the Anthropic API through worker/src/sim.ts. */
async function sim(body: Record<string, unknown>): Promise<any> {
  calls++;
  const full = { ...body, schema: SIM_CATALOG_SOURCE.commit };
  let j: any;
  if (!local) {
    const res = await fetch(`${(apiBase as string).replace(/\/$/, "")}/api/sim`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...accessHeaders() },
      body: JSON.stringify(full),
    });
    j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status} ${j.error ?? ""}`);
  } else {
    try {
      j = await runSim({ db, apiKey, model, apiBase: opt("--anthropic-base") }, parseSimRequest(full));
    } catch (e) {
      if (e instanceof ExtractUpstreamError) throw new Error(`${e.code}: ${e.message}`);
      throw e;
    }
  }
  tokens.input += j.usage?.input_tokens ?? 0;
  tokens.output += j.usage?.output_tokens ?? 0;
  tokens.cache_read += j.usage?.cache_read_input_tokens ?? 0;
  return j;
}

const codes = (errors: { code: string }[]) => errors.reduce((m: Record<string, number>, e) => ((m[e.code] = (m[e.code] ?? 0) + 1), m), {});
const results: any[] = [];
for (const t of themes) {
  const flow = FLOWS[t.flow];
  const out: any = { id: t.id, flow: t.flow, theme: t.theme, level: t.level };
  try {
    let j = await sim({ op: "author", flow: t.flow, theme: t.theme, level: t.level });
    let c = SM.checkAiSetting(j, flow, readings);
    out.first = { ok: c.ok, codes: codes(c.errors), dropped: j.dropped, copied: (j.overlap ?? []).length };
    if (!c.ok && c.setting) {
      j = await sim({ op: "author", flow: t.flow, theme: t.theme, level: t.level, repair: { setting: c.setting, errors: c.errors.slice(0, 40) } });
      c = SM.checkAiSetting(j, flow, readings);
      out.repair = { ok: c.ok, codes: codes(c.errors), dropped: j.dropped, copied: (j.overlap ?? []).length };
    }
    out.ok = c.ok;
    if (c.ok) {
      let setting = c.setting;
      out.sources = setting.origin.sources.length;
      if (verbose) out.setting = setting;
      // two continuations: a wait with no act, and the theme's act then a wait
      const conts: any[] = [];
      for (const log of [[{ act: "wait" }], ...(t.act ? [[{ act: "wait" }, { act: "do", key: t.act }, { act: "wait" }]] : [])]) {
        let s = setting;
        for (let i = 0; i < log.length; i++) {
          if (log[i].act !== "wait") continue;
          const head = log.slice(0, i + 1);
          const before = SM.stateAfter(s, flow, head, i, readings);
          const after = (await import("../web/sim-engine.js" as string)).replay(s, flow, head, { readings });
          const n = await sim({ op: "next", flow: t.flow, setting: s, log: head, state: before, t: after.t, stage: after.stage });
          const r = SM.addContinuation(s, flow, head, { kind: "boundary", after: i, facts: n.facts ?? [], event: n.event, basis: n.basis ?? [] }, readings);
          conts.push({ after: i, ok: r.ok, codes: codes(r.errors), changed: (n.facts ?? []).length, event: verbose ? n.event?.text ?? "" : !!n.event, copied: (n.overlap ?? []).length, ...(verbose ? { facts: n.facts } : {}) });
          if (r.ok) s = r.setting;
        }
      }
      out.continuations = conts;
      // the course after the admission (step 5a), with --course N: made once from the opening state, checked as the screen checks it
      if (courseDays) {
        const admit = SM.admitOptions(flow)[0];
        const start = (await import("../web/sim-engine.js" as string)).replay(setting, flow, [], { readings });
        const w = await sim({ op: "course", flow: t.flow, setting, log: [], state: "s0", t: start.t, stage: start.stage, days: courseDays, admit: admit.id });
        const c = SM.checkWardDays(w.ward, { dx: setting.assumed?.dx, overlap: w.overlap });
        out.course = { days: c.days.length, missing: c.missing, hidden: c.hidden, copied: (w.overlap ?? []).length, ...(verbose ? { text: c.days } : {}) };
      }
    }
  } catch (e) {
    out.error = (e as Error).message;
  }
  results.push(out);
  console.log(JSON.stringify(verbose ? out : { ...out, setting: undefined }));
}

const n = results.length;
const firstOk = results.filter((r) => r.first?.ok).length;
const ok = results.filter((r) => r.ok).length;
const contAll = results.flatMap((r) => r.continuations ?? []);
const allCodes: Record<string, number> = {};
for (const r of results) for (const part of [r.first, r.repair]) for (const [k, v] of Object.entries(part?.codes ?? {})) allCodes[k] = (allCodes[k] ?? 0) + (v as number);
const summary = {
  themes: n,
  author_ok_first_try: `${firstOk}/${n}`,
  author_ok_after_repair: `${ok}/${n}`,
  errors_by_code: allCodes,
  continuations_ok: `${contAll.filter((c) => c.ok).length}/${contAll.length}`,
  ...(courseDays
    ? {
        course_days_made: `${results.reduce((a, r) => a + (r.course?.days ?? 0), 0)}/${results.filter((r) => r.course).length * courseDays}`,
        course_hidden: results.reduce((m: Record<string, number>, r) => {
          for (const [k, v] of Object.entries(r.course?.hidden ?? {})) m[k] = (m[k] ?? 0) + (v as number);
          return m;
        }, {}),
        course_copied: results.reduce((a, r) => a + (r.course?.copied ?? 0), 0),
      }
    : {}),
  calls,
  tokens,
  model: local ? model : "(the Worker's)",
};
console.log("\n" + JSON.stringify(summary, null, 2));
if (opt("--out")) writeFileSync(opt("--out") as string, JSON.stringify({ summary, results }, null, 2));
