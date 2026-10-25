// A created fictional case (docs/enhancement-plan.md 7.4): reads the model's answer by its fixed headings, turns it into the case
// dialog's fields, makes the draft of a training case for clinical-modules' drills/*.toml, and scans the text for what a fictional
// case must not contain.  Pure functions, no DOM, no network, no storage (worker/test/create.test.ts pins that).  No AI is used here.
//
// The draft is a starting point, not a finished drill: `[case.answers]` is NOT made (it is keyed to the flow's question and option
// ids, which only clinical-modules knows), the id / key / source are marked for the doctor to replace, and the findings table and the
// assessment are left as comments for the doctor to convert there.  Nothing of the "見立て" goes into the case dialog.
import { AGE_MAX, SETTINGS, SEXES, cleanCase, isEmptyCase, readAge } from "./case-model.js";
import { scan } from "./id-guard.js";

/** The `##` headings a created case has, in order.  Twin of worker/src/prompt.ts CREATE_HEADINGS (pinned equal by the tests). */
export const CREATE_HEADINGS = ["導入文", "症例の入力用", "所見の表", "見立て", "落とし穴", "教訓", "書籍に見つからなかった点"];
/** The lines under 症例の入力用.  Twin of CREATE_INPUT_LABELS. */
export const INPUT_LABELS = ["年齢", "性別", "場面", "主訴と経過", "バイタル", "所見・検査", "既往・内服"];
/** The first line's old name, still read from a saved conversation (the case was created before the age became whole years). */
const LEGACY_LABELS = { 年代: "年齢" };
/** Placeholder id in the draft: the doctor picks the real one (clinical-modules' scripts/drill.py has the rule). */
export const DRAFT_ID = "xx-draft";
/** clinical-modules limits a case's text fields to this many characters (scripts/drill.py MAX_TEXT). */
export const MODULES_MAX_TEXT = 600;

/** the marks the screen adds to an answer: [推論] style tags and the cited-page marks */
const TAG_RE = /\s*\[(?:推論|標準・出典未確認|施設依存)\]/g;
const CITE_RE = /\s*［(?:書籍[^］]*|Web)］/g;
const plain = (s) => String(s ?? "").replace(CITE_RE, "").replace(TAG_RE, "").replace(/\*\*/g, "").replace(/[ \t]+/g, " ").trim();
const baseOf = (h) => String(h).replace(/^[\s#\d.)０-９・-]+/, "").split(/[（(]/)[0].trim();
/** "## 2. 見立て（最初は畳む）" -> "見立て": the part before the first bracket, without numbering. */
export const headingBase = baseOf;
/** A run of this many letters/digits shared with a book's text is flagged as copied.  Twin of worker/src/overlap.ts MIN_OVERLAP. */
export const MIN_OVERLAP = 30;

/** The sections of the answer by heading: { "導入文": "…", … } (the first of a heading wins; text before the first heading is ignored). */
export function splitSections(text) {
  const out = {};
  let cur = null;
  for (const line of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const m = /^#{1,6}\s*(.+?)\s*$/.exec(line);
    if (m) {
      const base = baseOf(m[1]);
      cur = CREATE_HEADINGS.includes(base) && !(base in out) ? base : null;
      if (cur) out[cur] = [];
      continue;
    }
    if (cur) out[cur].push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join("\n").trim()]));
}

/** "- 年齢: 72" lines under 症例の入力用 -> { 年齢: "72", … } (a following indented line continues the value; the old "- 年代: 70代" is read as 年齢). */
function readInput(body) {
  const out = {};
  let last = null;
  const re = new RegExp(`^\\s*[-*・]\\s*(${[...INPUT_LABELS, ...Object.keys(LEGACY_LABELS)].join("|")})\\s*[:：]\\s*(.*)$`);
  for (const line of String(body ?? "").split("\n")) {
    const m = re.exec(line);
    if (m) {
      last = LEGACY_LABELS[m[1]] ?? m[1];
      if (!(last in out)) out[last] = m[2];
      else last = null;
    } else if (last && line.trim()) out[last] += `\n${line.trim()}`;
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, plain(v)]));
}

/** The rows of the findings table: [{ item, value, basis }].  The header and the separator row are skipped. */
function readTable(body) {
  const rows = [];
  for (const line of String(body ?? "").split("\n")) {
    if (!line.includes("|") || /^\s*\|?\s*:?-{2,}/.test(line)) continue;
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    rows.push({ item: cells[0] ?? "", value: cells[1] ?? "", basis: cells.slice(2).join(" | ") });
  }
  rows.shift(); // the header row (項目 | 値 | 根拠)
  return rows.filter((r) => r.item || r.value);
}

/**
 * text: the answer, with the cited pages written in as ［書籍 p.N］ marks (app.js adds them: pages come from the citation metadata,
 * never from the model's own text).  Returns the parts, and the headings the answer lacks.
 */
export function parseCreated(text) {
  const sec = splitSections(text);
  const bullets = (b) => String(b ?? "").split("\n").map((l) => l.replace(/^\s*[-*・]\s*/, "")).filter((l) => l.trim());
  return {
    sections: sec,
    absent: CREATE_HEADINGS.filter((h) => !(h in sec)),
    intro: plain(sec["導入文"]?.replace(/\n+/g, " ")),
    input: readInput(sec["症例の入力用"]),
    table: readTable(sec["所見の表"]),
    diagnosis: String(sec["見立て"] ?? ""),
    pitfall: plain(bullets(sec["落とし穴"]).join(" ")),
    lesson: plain(bullets(sec["教訓"]).join(" ")),
  };
}

const SEX_ALIASES = { その他: "その他・不明", 不明: "その他・不明", "その他/不明": "その他・不明", "その他、不明": "その他・不明" };

/**
 * The case dialog's fields from the created case.  `notes` lists, in words, what could not be carried over (a choice that was not one
 * of the options, an empty part).  The assessment never goes in.
 */
export function toCase(parsed) {
  const i = parsed.input;
  const notes = [];
  const pick = (label, list, aliases = {}) => {
    const v = i[label] ?? "";
    const w = aliases[v] ?? v;
    if (list.includes(w)) return w;
    notes.push(v ? `「${label}」の「${v}」は選択肢にないため、空欄にしました` : `「${label}」がありません`);
    return "";
  };
  // the age is whole years (an old band such as "70代" from a saved conversation is kept as it was); anything else is left empty and said so
  const pickAge = () => {
    const v = i["年齢"] ?? "";
    const r = readAge(v);
    if (r.ok && r.age) return r.age;
    notes.push(v ? `「年齢」の「${v}」は 0〜${AGE_MAX} の整数ではないため、空欄にしました` : "「年齢」がありません");
    return "";
  };
  const kase = cleanCase({
    age: pickAge(),
    sex: pick("性別", SEXES, SEX_ALIASES),
    setting: pick("場面", SETTINGS),
    complaint: i["主訴と経過"],
    vitals: i["バイタル"],
    findings: i["所見・検査"],
    history: i["既往・内服"],
  });
  if (isEmptyCase(kase)) notes.push("主訴と経過・バイタル・所見・既往のどれもありません。症例モードには入れられません");
  return { kase, notes, ok: !isEmptyCase(kase) };
}

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const toml = (s) => JSON.stringify(String(s)); // JSON string escapes are valid in a TOML basic string
const comment = (s) => String(s).split("\n").map((l) => `# ${l}`.trimEnd());

/**
 * A draft of one training case for clinical-modules' drills/*.toml, as TOML text.
 * meta: { theme, level, sources: [{ book_id, page }] } (the books the cited findings came from, by the RAG's own book id).
 */
export function toModulesDraft(parsed, meta) {
  const out = [
    "# clinical-RAG が、手元の書籍を参考に作った、訓練症例の下書き（架空症例）。実在の患者・症例ではない。数値は例示。",
    "# 書籍の症例文は写していない（画面で重なりを検査済み）。閾値・用量は書かない。",
    "# [case.answers] は作らない: フローの質問ID・選択肢IDへの変換は、clinical-modules 側で医師が確認しながら行う（scripts/drill.py が検査する）。",
    "# 下の [要変更] [要変換] [要照合] を直してから使う。",
    "",
    "[[case]]",
  ];
  const field = (key, value, note) => {
    const v = oneLine(value);
    out.push(`${key} = ${toml(v)}${note ? `  # ${note}` : ""}`);
    if (v.length > MODULES_MAX_TEXT) out.push(`# [要短縮] ${key} が ${v.length} 字です（clinical-modules は ${MODULES_MAX_TEXT} 字以内）`);
  };
  out.push(`id = ${toml(DRAFT_ID)}  # [要変更] 場面・症候に合う接頭辞と記号にする`);
  field("title", `${meta.theme}（${meta.level}）`);
  out.push('tags = ["draft"]');
  field("intro", parsed.intro);
  out.push("key = []  # [要変換] 結論を左右する所見の、フローの質問ID");
  field("pitfall", parsed.pitfall);
  field("lesson", parsed.lesson);
  const seen = new Set();
  const srcs = (meta.sources ?? []).filter((s) => s.book_id && !seen.has(`${s.book_id}|${s.page}`) && seen.add(`${s.book_id}|${s.page}`));
  field("source", `clinical-RAG の下書き。書籍ID: ${srcs.length ? srcs.slice(0, 4).map((s) => `${s.book_id}${s.page ? ` ${s.page}` : ""}`).join("、") : "（引用なし）"}[要照合: 台帳IDへの置き換えは clinical-modules 側]`);
  out.push("");
  out.push(...comment("症例の入力用（症例が答える所見の材料。フローの質問IDへの変換は clinical-modules 側）"));
  for (const l of INPUT_LABELS) if (parsed.input[l]) out.push(...comment(`  ${l}: ${oneLine(parsed.input[l])}`));
  out.push("");
  out.push(...comment("所見の表（項目 | 値 | 根拠。値は例示）"));
  for (const r of parsed.table) out.push(...comment(`  ${oneLine(r.item)} | ${oneLine(r.value)} | ${oneLine(r.basis)}`));
  out.push("");
  out.push(...comment("見立て（[case.expect] の材料。鑑別 id への変換は clinical-modules 側）"));
  for (const l of String(parsed.diagnosis).split("\n")) if (l.trim()) out.push(...comment(`  ${plain(l)}`));
  return out.join("\n") + "\n";
}

const DOSE_RE = /\d+(?:\.\d+)?\s*(?:mg|g|μg|µg|mcg|単位|IU|mEq|mmol|mL|ml)(?!\s*\/\s*(?:dL|dl|L|l|mL|ml)\b)(?:\s*\/\s*(?:kg|日|回|hr|h|min|分|時間|day|body))?/gi;
const THRESHOLD_RE = /\d+(?:\.\d+)?\s*(?:以上|以下|未満|超)|[<>≦≧≤≥]\s*\d+(?:\.\d+)?/g;
const DATE_RE = /\d{4}\s*[年/.-]\s*\d{1,2}\s*[月/.-]\s*\d{1,2}|\d{1,2}月\d{1,2}日|(?:令和|平成|昭和)\s*\d+年/g;
const uniq = (a, n = 8) => [...new Set(a)].slice(0, n);

/**
 * What a fictional case should not contain, found in the created text: dose-like numbers (a number with a drug unit that is not a
 * per-volume lab value), threshold-like comparisons, calendar dates, and identifier-like text (the same net as the input guard).
 * Warnings, not verdicts: a lab value such as "尿量 400 mL/日" can look like a dose; the doctor decides.
 */
export function scanCreated(text) {
  // markup left in the text (a copied "<sup>1)</sup>") is not a comparison
  const t = String(text ?? "").normalize("NFKC").replace(/<\/?[a-zA-Z][^>]*>/g, " ");
  return {
    doses: uniq(t.match(DOSE_RE) ?? []),
    thresholds: uniq(t.match(THRESHOLD_RE) ?? []),
    dates: uniq(t.match(DATE_RE) ?? []),
    ids: scan(String(text ?? "")).map((h) => h.label),
  };
}
