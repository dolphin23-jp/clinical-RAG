// Chart-note draft (docs/enhancement-plan.md 7.3): the typed case and the draft items the doctor adopted, put into the fields of a
// note type.  Pure functions, no DOM, no network, no storage (worker/test/note.test.ts pins that).  No AI is used here.
//
// What goes in: the case exactly as typed, and only the draft items the doctor ticked ("採用").  What never goes in: an item not
// ticked, the draft's "確認すべき数値" / "書籍に見つからなかった点" / "先生の案との差" sections, a date, a patient ID or a name.  A
// required field with nothing to put in says （未入力）; it is not filled with prose.  A conditional field with nothing is left out.
// A plan item is a proposal: it is labelled as such and is never placed in a field for what was already done.
import { NOTE_TYPES } from "./note-types.js";

/** The types offered, in picker order.  The others are imported (note-types.js) but not wired yet. */
export const ENABLED = ["A04", "A01", "A05", "A06", "A08", "B02", "B06"];

export const UNFILLED = "（未入力）";
export const AI_MARK = "〔AI草案〕";
/** Left empty on purpose: the doctor fills these in the chart itself (the case never contains them). */
export const BLANK_HEADER = "［日付］　［患者ID］　［氏名］";
export const AI_NOTICE = `※${AI_MARK}の印がある項目は、AI（書籍の検索に基づく草案）の提案を、医師が採用したものです。`;

/** The typed case's parts, as sources for a field. */
export const SOURCE_LABELS = {
  ctx: "年代・性別・場面",
  complaint: "主訴と経過",
  vitals: "バイタル",
  findings: "身体所見・検査・画像・心電図",
  history: "既往・内服",
  own: "先生のアセスメント（入力）",
};

/** The adoptable parts of the assessment/plan draft (the `##` headings of worker/src/prompt.ts MODE_HEADINGS.assess). */
export const ROLES = {
  problems: { heading: "問題リスト", label: "問題リスト（草案）" },
  assessment: { heading: "各問題の評価", label: "各問題の評価（草案）" },
  plan: { heading: "初期プラン", label: "初期プラン（草案。予定・検討であり、実施の記録ではありません）" },
  contingency: { heading: "コンサルト・医師コールの基準", label: "コンサルト・医師コールの基準（草案）" },
};
/** Draft sections that are about the draft itself, not chart content: never adoptable. */
export const NOT_ADOPTABLE = ["確認すべき数値", "書籍に見つからなかった点", "先生の案との差"];

/** "## 初期プラン（検査・治療…）" -> "初期プラン": the part before the first bracket, without numbering. */
const baseOf = (h) => String(h).replace(/^[\s#\d.)０-９・-]+/, "").split(/[（(]/)[0].trim();

/** The role of a draft section heading, or null when it is not adoptable. */
export function headingRole(heading) {
  const b = baseOf(heading);
  for (const [id, r] of Object.entries(ROLES)) if (r.heading === b) return id;
  return null;
}

/**
 * Which parts fill which field, per type: "ctx" and the case keys are the typed case; "d:<role>" are adopted draft items.
 * A field not listed has nothing to take: required -> （未入力）, conditional -> left out.
 * Each draft role appears once per type, so an item is never written twice.
 */
export const FILL = {
  A04: { arrival: ["ctx"], hpi: ["complaint"], background: ["history"], initial: ["vitals"], exam: ["findings"], assessment: ["own", "d:problems", "d:assessment"], management: ["d:plan", "d:contingency"] },
  A01: { visit: ["ctx"], hpi: ["complaint"], background: ["history"], initial: ["vitals"], exam: ["findings"], reasoning: ["own", "d:problems", "d:assessment"], plan: ["d:plan"], recheck: ["d:contingency"] },
  A05: { admission: ["ctx"], hpi: ["complaint"], background: ["history"], initial: ["vitals", "findings"], problem_list: ["d:problems"], problem_ap: ["own", "d:assessment", "d:plan"], outlook: ["d:contingency"] },
  A06: { context: ["ctx"], interval: ["complaint"], objective: ["vitals", "findings"], problem_ap: ["own", "d:problems", "d:assessment", "d:plan"], handover: ["d:contingency"] },
  A08: { context: ["ctx"], hpi: ["complaint"], initial: ["vitals", "findings"] },
  B02: { summary: ["ctx", "complaint"], findings: ["vitals", "findings"] },
  B06: { situation: ["ctx", "complaint", "own", "d:problems"], background: ["history", "vitals", "findings"], tasks: ["d:plan"], contingency: ["d:contingency"] },
};
/** Fields whose line says something is still to be filled by hand (not an AI statement): shown after the adopted items. */
export const FIELD_NOTES = {
  "B06.tasks": "（担当・期限は入力していません）",
};

const ctxText = (c) => [[c.age, c.sex].filter(Boolean).join("・"), c.setting].filter(Boolean).join("・");

/** The sections of a type that apply to the note being made (B02 has a request and a response side: the request is made). */
function sectionsOf(type) {
  if (!type.variants) return type.sections;
  return type.sections.filter((s) => !s.variant || s.variant === "request");
}

/**
 * kase: the typed case ({age, sex, setting, complaint, vitals, findings, history, own}).
 * items: adopted draft items [{ role, heading, text, cites: [{kind, title, page, url}] }] (anything else is ignored).
 * Returns { type, sections: [{ key, label, requirement, blocks, empty }], adopted, unfilled, omitted }.
 */
export function assemble(typeId, { kase = {}, items = [] } = {}) {
  if (!ENABLED.includes(typeId)) throw new Error(`note type ${typeId} is not offered`);
  const type = NOTE_TYPES[typeId];
  if (!type) throw new Error(`note type ${typeId} is not imported`);
  const adopted = items.filter((i) => i && ROLES[i.role] && String(i.text ?? "").trim());
  const fill = FILL[typeId] ?? {};
  const sections = [];
  const unfilled = [];
  const omitted = [];
  const used = new Set();
  for (const s of sectionsOf(type)) {
    const blocks = [];
    for (const src of fill[s.key] ?? []) {
      if (src.startsWith("d:")) {
        const role = src.slice(2);
        const mine = adopted.filter((i) => i.role === role);
        if (mine.length) {
          blocks.push({ kind: "draft", role, label: ROLES[role].label, items: mine });
          for (const i of mine) used.add(i);
        }
      } else {
        const text = src === "ctx" ? ctxText(kase) : String(kase[src] ?? "").trim();
        if (text) blocks.push({ kind: src === "own" ? "own" : "case", source: src, label: SOURCE_LABELS[src], text });
      }
    }
    const empty = blocks.length === 0;
    if (empty && s.requirement !== "required") {
      omitted.push(s.key);
      continue;
    }
    if (empty) unfilled.push(s.key);
    const note = FIELD_NOTES[`${typeId}.${s.key}`];
    sections.push({ key: s.key, label: s.label, requirement: s.requirement, blocks, empty, ...(note && !empty ? { note } : {}) });
  }
  // an adopted item whose role has no field in this type is reported, never silently dropped
  const unplaced = adopted.filter((i) => !used.has(i));
  return { type: { id: type.id, title: type.title, version: type.version, status: type.status }, sections, adopted: used.size, unplaced: unplaced.length, unfilled, omitted };
}

const TAG_RE = /\s*\[(?:推論|標準・出典未確認|施設依存)\]/g;

const citeLabel = (c) => (c.kind === "web" ? "Web" : `書籍${c.page ? ` ${c.page}` : ""}`);
const citeLine = (c) => (c.kind === "web" ? `Web: ${c.title || c.url || ""}`.trim() : `${String(c.title ?? "").replace(/(\s*［[^］]*］)+\s*$/, "")}${c.page ? ` ${c.page}` : ""}`.trim());

/**
 * The note as plain text, for the clipboard.  opts.aiMark: keep the 〔AI草案〕 mark on adopted items and the notice line.
 * opts.sourceMarks: keep where each item comes from ([推論] etc., the cited book pages and the list of sources).
 * 【出典未確認・要確認】 on a number is always kept: it is a warning about the number, not a mark of origin.
 */
export function toText(note, { aiMark = true, sourceMarks = true } = {}) {
  const out = [`【${note.type.title}】下書き`, BLANK_HEADER];
  if (aiMark && note.adopted) out.push(AI_NOTICE);
  out.push("");
  const cites = new Map();
  for (const s of note.sections) {
    out.push(`■${s.label}`);
    if (s.empty) out.push(UNFILLED);
    const several = s.blocks.length > 1;
    for (const b of s.blocks) {
      if (b.kind === "draft") {
        out.push(`［${b.label}］`);
        for (const i of b.items) {
          let text = String(i.text).replace(/\s+/g, " ").trim();
          if (!sourceMarks) text = text.replace(TAG_RE, "");
          const marks = [];
          if (sourceMarks) {
            for (const c of i.cites ?? []) {
              marks.push(`［${citeLabel(c)}］`);
              cites.set(citeLine(c), true);
            }
          }
          out.push(`・${aiMark ? AI_MARK : ""}${text}${marks.length ? ` ${[...new Set(marks)].join("")}` : ""}`);
        }
      } else {
        if (several || b.kind === "own" || b.source === "findings") out.push(`［${b.label}］`);
        out.push(b.text);
      }
    }
    if (s.note) out.push(s.note);
    out.push("");
  }
  if (sourceMarks && cites.size) {
    out.push("■AI草案の出典（採用した項目）");
    for (const line of cites.keys()) if (line) out.push(`・${line}`);
    out.push("");
  }
  while (out.at(-1) === "") out.pop();
  return out.join("\n");
}
