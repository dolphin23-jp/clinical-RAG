// Uncited-statement marking (C6): web/answer-marks.js and its rendering in web/md.js.  The DOM part is covered by
// tests/e2e/ui_clinical.py; here the pure functions.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { REPO } from "./nodeDb.ts";

const marks: any = await import(join(REPO, "web", "answer-marks.js"));
const md: any = await import(join(REPO, "web", "md.js"));
const U: string = marks.UNCITED;

test("sentinels are one non-empty private-use character each, and the two files agree", () => {
  assert.equal(U.length, 1);
  assert.equal(U, "");
  assert.equal(md.UNCITED, U);
  assert.equal(md.CITE_OPEN, "");
  assert.equal(md.CITE_CLOSE, "");
});

test("markUncited: statements are marked; headings, tables, rules, quotes and short lines are not", () => {
  const text = [
    "## 反証・見落としの確認",
    "ここで挙げた点は、書籍に記載がなく、一般的な標準診療からの推論です。",
    "- 腎前性の除外には、尿中ナトリウムを含めた評価が考えられます。",
    "- 短い項目",
    "| 項目 | 内容 |",
    "---",
    "> 引用された囲みの文章はここにあります、長い行でも印は付けません。",
    "",
    "1. 補液への反応を見て再評価することが、次の分岐になります。",
  ].join("\n");
  assert.deepEqual(marks.markUncited(text).split("\n"), [
    "## 反証・見落としの確認",
    `${U}ここで挙げた点は、書籍に記載がなく、一般的な標準診療からの推論です。`,
    `- ${U}腎前性の除外には、尿中ナトリウムを含めた評価が考えられます。`,
    "- 短い項目",
    "| 項目 | 内容 |",
    "---",
    "> 引用された囲みの文章はここにあります、長い行でも印は付けません。",
    "",
    `1. ${U}補液への反応を見て再評価することが、次の分岐になります。`,
  ]);
});

test("markUncited: a block that continues the previous line is not marked at its first line", () => {
  const t = "続きの文が、前の引用の直後から同じ行に続いています。\nこちらは新しい行の、書籍にない推論の文です。";
  assert.deepEqual(marks.markUncited(t, false).split("\n"), ["続きの文が、前の引用の直後から同じ行に続いています。", `${U}こちらは新しい行の、書籍にない推論の文です。`]);
});

test("buildAnswerMarkdown: chips after cited blocks, marks on uncited ones, plain text unchanged", () => {
  const blocks = [
    { text: "- 第一に、この節の記載内容を要約します。", citations: [{ k: "b:1" }] },
    { text: "\n- 第二に、書籍にはない補足として、推論を述べます。", citations: [] },
    { text: "\n- 第三に、別の節に基づく記載を述べます。\n", citations: [{ k: "b:2" }] },
  ];
  const out = marks.buildAnswerMarkdown(blocks, (b: any) => b.citations.map((c: any) => c.k), { citeOpen: md.CITE_OPEN, citeClose: md.CITE_CLOSE });
  assert.deepEqual(out.groups, [["b:1"], ["b:2"]]);
  assert.equal(out.plain, blocks.map((b) => b.text).join(""));
  assert.equal(out.md, `- 第一に、この節の記載内容を要約します。${md.CITE_OPEN}0${md.CITE_CLOSE}\n- ${U}第二に、書籍にはない補足として、推論を述べます。\n- 第三に、別の節に基づく記載を述べます。${md.CITE_OPEN}1${md.CITE_CLOSE}\n`);
  // mark: false (an answer with no book citation at all) leaves the text alone
  const plain = marks.buildAnswerMarkdown([blocks[1]], () => [], { citeOpen: md.CITE_OPEN, citeClose: md.CITE_CLOSE, mark: false });
  assert.equal(plain.md, blocks[1].text);
});

test("stripCiteMarks removes chips and markers (clipboard text)", () => {
  assert.equal(md.stripCiteMarks(`- ${U}推論の文${md.CITE_OPEN}3${md.CITE_CLOSE}`), "- 推論の文");
});
