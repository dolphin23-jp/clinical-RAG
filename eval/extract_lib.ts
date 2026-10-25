// Evaluation of the extraction from a pasted memo (docs/enhancement-plan.md 8.12 の6, 8.15).  Pure functions, tested in worker/test/extract.test.ts;
// the runner is eval/run_extract_eval.ts.  A case is a memo, the answers it supports (`expect`) and the questions it does NOT support
// (`must_not`: the memo says nothing about them, or says a plan, a doubt, or the opposite).  A proposal for a `must_not` question is the
// failure that matters (an unmentioned finding turned into "none" or "present", an order turned into a thing done): the target is 0.
// The memos are written by the doctor from the way real notes are written, with nothing of a real patient (no name, no ID, no date); a file of them
// is eval/extract.local.jsonl (ignored by git).
import { scanIdentifiers } from "../worker/src/idguard.ts";

export interface ExtractCase {
  id: string;
  flow: string;
  text: string;
  /** question id -> the value it should get (a string, a number, or the option ids of a multi question) */
  expect: Record<string, string | number | string[]>;
  /** questions that must get no proposal */
  must_not?: string[];
  note?: string;
}

export interface GotProposal {
  q: string;
  v: string | string[];
  frag?: string;
}

export interface CaseScore {
  id: string;
  hits: string[];
  missing: string[];
  wrong: { q: string; got: unknown; want: unknown }[];
  extra: string[];
  forbidden: string[];
  /** the forbidden ones the screen would put in the "confirm together" group (the worst place for them: confirmed without a look) */
  forbiddenTogether: string[];
}

/** Parses a cases file (JSON Lines; blank lines and # lines are skipped).  Every problem is collected and thrown once. */
export function parseCases(text: string): ExtractCase[] {
  const out: ExtractCase[] = [];
  const errors: string[] = [];
  const ids = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const at = `line ${i + 1}`;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch (e) {
      errors.push(`${at}: invalid JSON (${(e as Error).message})`);
      return;
    }
    const where = typeof o?.id === "string" && o.id ? `${at} (${o.id})` : at;
    if (typeof o?.id !== "string" || !o.id) errors.push(`${at}: "id" is required`);
    else if (ids.has(o.id)) errors.push(`${where}: duplicate id`);
    else ids.add(o.id);
    if (typeof o?.flow !== "string" || !o.flow) errors.push(`${where}: "flow" is required`);
    if (typeof o?.text !== "string" || !o.text.trim()) errors.push(`${where}: "text" is required`);
    else if (scanIdentifiers(o.text).length) errors.push(`${where}: "text" looks like it holds an identifier (docs/clinical-use.md: no names, no IDs)`);
    const expect = o?.expect;
    if (!expect || typeof expect !== "object" || Array.isArray(expect)) errors.push(`${where}: "expect" must be an object (it may be empty)`);
    else for (const [k, v] of Object.entries(expect)) if (!(typeof v === "string" || typeof v === "number" || (Array.isArray(v) && v.every((x) => typeof x === "string")))) errors.push(`${where}: expect.${k} must be a string, a number or a list of strings`);
    const mn = o?.must_not;
    if (mn !== undefined && !(Array.isArray(mn) && mn.every((x: unknown) => typeof x === "string"))) errors.push(`${where}: "must_not" must be a list of question ids`);
    if (expect && mn && Array.isArray(mn)) for (const k of mn) if (k in expect) errors.push(`${where}: "${k}" is in both expect and must_not`);
    if (typeof o?.id === "string" && typeof o?.flow === "string" && typeof o?.text === "string" && expect && typeof expect === "object") out.push({ id: o.id, flow: o.flow, text: o.text, expect, must_not: Array.isArray(mn) ? mn : [], ...(typeof o.note === "string" ? { note: o.note } : {}) });
  });
  if (errors.length) throw new Error(`cases file has ${errors.length} problem(s):\n${errors.join("\n")}`);
  return out;
}

const sameValue = (got: unknown, want: unknown): boolean => {
  if (Array.isArray(want)) return Array.isArray(got) ? got.length === want.length && want.every((x) => got.includes(x)) : want.length === 1 && got === want[0];
  if (typeof want === "number") return Number(got) === want;
  return String(got).trim() === String(want).trim();
};

/** One case against the proposals the extraction returned. */
export function scoreCase(c: ExtractCase, proposals: GotProposal[], risk?: Map<string, "low" | "high">): CaseScore {
  const got = new Map(proposals.map((p) => [p.q, p]));
  const forbid = new Set(c.must_not ?? []);
  const s: CaseScore = { id: c.id, hits: [], missing: [], wrong: [], extra: [], forbidden: [], forbiddenTogether: [] };
  for (const [q, want] of Object.entries(c.expect)) {
    const p = got.get(q);
    if (!p) s.missing.push(q);
    else if (sameValue(p.v, want)) s.hits.push(q);
    else s.wrong.push({ q, got: p.v, want });
  }
  for (const p of proposals) {
    if (forbid.has(p.q)) {
      s.forbidden.push(p.q);
      if (risk?.get(p.q) === "low") s.forbiddenTogether.push(p.q);
    } else if (!(p.q in c.expect)) s.extra.push(p.q);
  }
  return s;
}

export interface Summary {
  cases: number;
  expected: number;
  hits: number;
  missing: number;
  wrong: number;
  extra: number;
  forbidden: number;
  forbiddenTogether: number;
  casesWithForbidden: string[];
}

export function summarize(scores: CaseScore[]): Summary {
  const sum = (f: (s: CaseScore) => number) => scores.reduce((a, s) => a + f(s), 0);
  return {
    cases: scores.length,
    expected: sum((s) => s.hits.length + s.missing.length + s.wrong.length),
    hits: sum((s) => s.hits.length),
    missing: sum((s) => s.missing.length),
    wrong: sum((s) => s.wrong.length),
    extra: sum((s) => s.extra.length),
    forbidden: sum((s) => s.forbidden.length),
    forbiddenTogether: sum((s) => s.forbiddenTogether.length),
    casesWithForbidden: scores.filter((s) => s.forbidden.length).map((s) => s.id),
  };
}
