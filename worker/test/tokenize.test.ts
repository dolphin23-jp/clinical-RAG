import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { bigramText, queryTerms } from "../src/tokenize.ts";
import { biMatch, triMatch } from "../src/search.ts";
import { REPO } from "./nodeDb.ts";

const vectors = JSON.parse(readFileSync(join(REPO, "tests", "vectors", "tokenize.json"), "utf-8")) as {
  in: string;
  bigram: string;
  terms: string[];
}[];

test("TS tokenizer reproduces the Python contract vectors exactly", () => {
  assert.ok(vectors.length > 10);
  for (const v of vectors) {
    assert.equal(bigramText(v.in), v.bigram, `bigram for ${JSON.stringify(v.in)}`);
    assert.deepEqual(queryTerms(v.in), v.terms, `terms for ${JSON.stringify(v.in)}`);
  }
});

test("MATCH builders", () => {
  assert.equal(biMatch("糸球体腎炎"), '"糸球 球体 体腎 腎炎"');
  assert.equal(biMatch("腎炎 eGFR"), '"腎炎" OR "egfr"');
  assert.equal(biMatch("   "), null);
  // trigram index only gets terms of >= 3 chars
  assert.equal(triMatch("腎炎"), null);
  assert.equal(triMatch("腎炎 GFR"), '"gfr"');
  // double quotes inside a term must be escaped, never break out of the phrase
  assert.equal(triMatch('a"b"c'), '"a""b""c"');
});

test("contentTerms splits sentences at hiragana/punctuation and keeps content words", async () => {
  const { contentTerms } = await import("../src/tokenize.ts");
  assert.deepEqual(contentTerms("感度と特異度の違いを教えて"), ["感度", "特異度"]); // okurigana words (違い) lose their stem: known limit
  assert.deepEqual(contentTerms("AKIの診断基準"), ["aki", "診断基準"]);
  assert.deepEqual(contentTerms("ゼルニア値は？"), ["ゼルニア値"]);
  assert.deepEqual(contentTerms("あ、の、を"), []);
});
