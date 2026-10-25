// The scenes a draft can be made for (docs/enhancement-plan.md 8.5, 8.16): which headings the assessment/plan draft has in each scene, and
// which part of the chart each heading is (the role the doctor's "採用" gives an item).  Pure data and functions: no DOM, no network, no
// storage, no AI, no imports (note-assemble.js reads the roles from here).
//
// Twin of worker/src/casemode.ts (SCENES, SCENE_LABELS, RECORD_SCENES, BRIEF_LIMIT) and worker/src/prompt.ts (SCENE_SECTIONS: the same headings
// in the same order): worker/test/scenes.test.ts pins them equal.  What the model is told to write under each heading lives in prompt.ts only.
//
// A heading's role is one of the four adoptable parts of the draft (problems / assessment / plan / contingency), or null: a section that is
// about the draft itself (the numbers to check, what the books did not have) or a summary of the record (read, not carried over).

export const SCENES = ["ed", "op_first", "adm", "prog", "interim", "dc"];
export const SCENE_LABELS = {
  ed: "救急外来",
  op_first: "外来初診",
  adm: "病棟・入院時",
  prog: "病棟・経過",
  interim: "中間サマリー・転棟",
  dc: "退院時サマリー",
};
/** The scenes whose draft is about the course of a record: they cannot be made without the record's summary. */
export const RECORD_SCENES = ["prog", "interim", "dc"];
/** The scenes whose draft takes the record's summary when a record is open (required for RECORD_SCENES, optional for the admission). */
export const BRIEF_SCENES = ["adm", "prog", "interim", "dc"];
/** The most characters of the record's summary (twin of BRIEF_LIMIT in worker/src/casemode.ts). */
export const BRIEF_LIMIT = 5000;

const TAIL = [
  { h: "確認すべき数値（原本の頁で確認）", role: null },
  { h: "書籍に見つからなかった点", role: null },
];

/** The `##` headings of the assessment/plan draft per scene, in order, with the role of each. */
export const SCENE_HEADINGS = {
  ed: [
    { h: "問題リスト", role: "problems" },
    { h: "重症度と安定化（入力の事実に基づく論点。等級は付けない）", role: "plan" },
    { h: "critical の除外の根拠", role: "assessment" },
    { h: "検査は何を区別するか", role: "plan" },
    { h: "行き先・帰宅条件・申し送り", role: "contingency" },
    ...TAIL,
  ],
  op_first: [
    { h: "問題リスト", role: "problems" },
    { h: "鑑別と除外の根拠（critical を先に）", role: "assessment" },
    { h: "検査の目的（何を区別するか）", role: "plan" },
    { h: "再受診の基準", role: "contingency" },
    ...TAIL,
  ],
  adm: [
    { h: "問題リスト（優先順位つき）", role: "problems" },
    { h: "各問題の評価", role: "assessment" },
    { h: "各問題の計画", role: "plan" },
    { h: "治療目標・退院条件", role: "contingency" },
    { h: "コール基準", role: "contingency" },
    ...TAIL,
  ],
  prog: [
    { h: "前回からの変化（記録の要約から）", role: null },
    { h: "問題ごとの更新", role: "assessment" },
    { h: "計画の変更案と、その理由", role: "plan" },
    { h: "新しく立つ問題", role: "problems" },
    { h: "翌日の確認・コール条件", role: "contingency" },
    ...TAIL,
  ],
  interim: [
    { h: "経過の要約（転換点を軸に）", role: null },
    { h: "問題ごとの現在の評価", role: "assessment" },
    { h: "継続する計画と結果待ち", role: "plan" },
    { h: "悪化時の再評価・連絡条件", role: "contingency" },
    ...TAIL,
  ],
  dc: [
    { h: "経過の要約（問題別）", role: null },
    { h: "診断ごとの根拠", role: "assessment" },
    { h: "残る課題（何を。担当・期限は先生が決める）", role: "plan" },
    ...TAIL,
  ],
};

/** "## 初期プラン（検査・治療…）" -> "初期プラン": the part before the first bracket, without numbering (the same reading as note-assemble.js). */
export const baseHeading = (h) => String(h).replace(/^[\s#\d.)０-９・-]+/, "").split(/[（(]/)[0].trim();

/** base heading -> role, over every scene (a base heading has the same role wherever it appears: the tests pin that). */
export const SCENE_ROLE_OF = Object.freeze(
  Object.fromEntries(Object.values(SCENE_HEADINGS).flatMap((list) => list.filter((x) => x.role).map((x) => [baseHeading(x.h), x.role]))),
);

/** The role of a scene's heading, or null (also null for a heading no scene has). */
export const sceneHeadingRole = (heading) => SCENE_ROLE_OF[baseHeading(heading)] ?? null;

export const isScene = (v) => typeof v === "string" && SCENES.includes(v);

/** What a scene needs: "record" (cannot be made without the record's summary), "optional" (takes it when a record is open), or "none". */
export const briefNeed = (scene) => (RECORD_SCENES.includes(scene) ? "record" : BRIEF_SCENES.includes(scene) ? "optional" : "none");
