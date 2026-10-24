import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { Db } from "../src/db.ts";
import { rrf, searchChunkIds, searchParents } from "../src/search.ts";
import { DICTIONARY, expandQueries, MAX_RELATED, MAX_SYNONYMS } from "../src/synonyms.ts";
import { buildFixtureDb, openDb } from "./nodeDb.ts";

let db: Db;
before(() => {
  db = openDb(buildFixtureDb());
});

test("2-character CJK terms are found (trigram alone cannot)", async () => {
  const r = await searchParents(db, ["腎炎"]);
  assert.ok(r.length >= 1);
  assert.ok(r[0].text.includes("腎炎"));
  assert.equal(r[0].book_id, "fx");
});

test("Latin substring inside a token is found via trigram (GFR in eGFR)", async () => {
  const r = await searchParents(db, ["GFR 半量"]);
  assert.ok(r.some((p) => p.text.includes("eGFR 30 未満") && p.path.includes("薬物治療")));
});

test("numeric_critical, dose flag and page-annotated parent text", async () => {
  const [p] = await searchParents(db, ["架空薬X 10 mg"]);
  assert.equal(p.numeric_critical, true);
  assert.match(p.text, /［p\.12］/);
  assert.match(p.book_title, /架空内科ハンドブック/);
  assert.equal(p.author, "架空花子");
  assert.equal(p.pub_year, 2030);
});

test("transcriber-written text is flagged and labelled", async () => {
  const [p] = await searchParents(db, ["折れ線グラフ"]);
  assert.equal(p.has_transcriber_aid, true);
  assert.match(p.text, /［転写者補助・原本の記述ではない］/);
  assert.ok(p.matched.some((m) => m.provenance === "transcriber"));
});

test("reliability warning and transcriber flags travel with results", async () => {
  const [p] = await searchParents(db, ["ゼルニア値"]);
  const codes = p.notes.map((n) => n.code);
  assert.ok(codes.includes("W_RELIABILITY"), JSON.stringify(codes));
  assert.ok(codes.includes("I_TRANSCRIBER_FLAG"), JSON.stringify(codes));
});

test("citations resolve to reference entries with PMIDs", async () => {
  const r = await searchParents(db, ["軽症 中等症 重症"]);
  const withRefs = r.find((p) => p.refs.length > 0);
  assert.ok(withRefs, "expected a parent with linked references");
  assert.ok(withRefs!.refs.some((x) => x.pmid === "99999991"));
});

test("references are excluded by default, included on request", async () => {
  const noRef = await searchChunkIds(db, ["架空学術 PMID 99999991"]);
  const ids = noRef.map(([id]) => id);
  const kinds = await db.all<{ kind: string }>(`SELECT kind FROM chunks WHERE chunk_id IN (${ids.map(() => "?").join(",") || "''"})`, ...ids);
  assert.ok(kinds.every((k) => k.kind !== "references"));
  const withRef = await searchChunkIds(db, ["架空太郎 架空症候群の診療"], { includeReferences: true });
  const k2 = await db.all<{ kind: string }>(`SELECT kind FROM chunks WHERE chunk_id IN (${withRef.map(() => "?").join(",")})`, ...withRef.map(([i]) => i));
  assert.ok(k2.some((k) => k.kind === "references"));
});

test("single-character CJK query falls back to substring scan", async () => {
  const hits = await searchChunkIds(db, ["値"]);
  assert.ok(hits.length > 0);
});

test("no hits is an empty result, not an error; hostile input cannot break FTS syntax", async () => {
  assert.deepEqual(await searchParents(db, ["ぬるぽぬるぽ存在しない語"]), []);
  for (const evil of ['" OR 1=1 --', "NEAR(", "a* b* *", "'; DROP TABLE chunks;--", ""]) {
    await searchParents(db, [evil]); // must not throw
  }
  const n = await db.all<{ n: number }>("SELECT count(*) AS n FROM chunks");
  assert.ok(n[0].n > 0);
});

test("book filter and diversity cap", async () => {
  const none = await searchParents(db, ["ゼルニア値"], { bookIds: ["other-book"] });
  assert.deepEqual(none, []);
  const capped = await searchParents(db, ["ゼルニア値"], { maxPerBook: 1, parents: 5 });
  assert.equal(capped.length, 1);
});

test("RRF: agreement between retrievers beats a single high rank", () => {
  const s = rrf([["a", "b"], ["c", "b"]]);
  const order = [...s.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
  assert.equal(order[0], "b"); // second place in both lists beats first place in only one
});

test("sentence-like query falls back to content words instead of returning nothing", async () => {
  const strict = await searchChunkIds(db, ["ゼルニア値が基準の半分以下になる状態とは何ですか"], { k: 30 });
  assert.ok(strict.length > 0, "relaxed retry should find chunks about ゼルニア値");
  const r = await searchParents(db, ["ゼルニア値の基準を教えて"]);
  assert.ok(r.length >= 1);
  assert.ok(r.some((p) => p.text.includes("ゼルニア値")));
});

test("search degrades to the bigram index when the trigram table is unusable", async () => {
  const broken: Db = {
    async all(sql: string, ...params: unknown[]) {
      if (sql.includes("chunks_tri")) throw new Error("no such tokenizer: trigram");
      return db.all(sql, ...params);
    },
  };
  const r = await searchParents(broken, ["腎炎"]);
  assert.ok(r.length >= 1);
});

// ---------------------------------------------------------------------------------- dictionary expansion (T1-9)
test("expandQueries: other spellings and related words of matched groups; terms already in the query are not repeated", () => {
  const e = expandQueries(["高K血症 治療"]);
  assert.ok(e.synonyms.includes("高カリウム血症") && e.synonyms.includes("hyperkalemia"));
  assert.ok(!e.synonyms.includes("高K血症"));
  assert.ok(e.related.includes("カリウム吸着薬") && e.related.includes("透析"));
  // abbreviations work inside a Japanese sentence, as whole words only
  assert.ok(expandQueries(["AKIの定義と病期分類"]).synonyms.includes("急性腎障害"));
  assert.deepEqual(expandQueries(["HDLコレステロール"]).synonyms, []);
  assert.deepEqual(expandQueries(["CRP 上昇"]).synonyms, []);
});

test("expandQueries: ambiguous abbreviations lead to the full name but are never added to a search", () => {
  assert.ok(expandQueries(["PE を疑う"]).synonyms.includes("肺塞栓症"));
  const fromFull = expandQueries(["肺塞栓症"]);
  assert.ok(!fromFull.synonyms.includes("PE") && !fromFull.synonyms.includes("PTE"));
  assert.ok(!expandQueries(["血液透析"]).synonyms.includes("HD"));
});

test("expandQueries: caps hold and nothing fires on unrelated words", () => {
  const all = expandQueries([DICTIONARY.map((g) => g.terms[0]).join(" ")]);
  assert.ok(all.synonyms.length <= MAX_SYNONYMS && all.related.length <= MAX_RELATED);
  assert.deepEqual(expandQueries(["ゼルニア値"]), { synonyms: [], related: [] });
});

test("dictionary content: no numbers (doses, thresholds) and no duplicate spellings across groups", () => {
  const seen = new Map<string, number>();
  DICTIONARY.forEach((g, i) => {
    for (const t of [...g.terms, ...(g.abbr ?? []), ...(g.related ?? [])]) {
      assert.doesNotMatch(t, /\d+\s*(mg|g|ml|mL|mEq|mmol|%|単位|倍)/, t);
    }
    for (const t of [...g.terms, ...(g.abbr ?? [])]) {
      const k = t.normalize("NFKC").toLowerCase();
      assert.ok(!seen.has(k), `"${t}" is in groups ${seen.get(k)} and ${i}`);
      seen.set(k, i);
    }
  });
});

test("search: a synonym finds a section the literal word cannot; an empty dictionary turns expansion off", async () => {
  const dict = [{ terms: ["ゼルニア値", "zernia level"] }];
  assert.deepEqual(await searchParents(db, ["zernia level"], { dictionary: [] }), []);
  const r = await searchParents(db, ["zernia level"], { dictionary: dict });
  assert.ok(r.length >= 1 && r.every((p) => p.text.includes("ゼルニア値")));
});

test("search: related words reach the section that discusses the condition under another heading", async () => {
  const dict = [{ terms: ["架空病Q"], related: ["架空薬X"] }];
  const r = await searchParents(db, ["架空病Q"], { dictionary: dict });
  assert.ok(r.some((p) => p.path.includes("薬物治療")));
});

test("search: expansion never removes a literal hit, and adds at most 4 D1 queries", async () => {
  let n = 0;
  const counting: Db = { all: (sql: string, ...p: unknown[]) => (n++, db.all(sql, ...p)) };
  const plain = await searchParents(counting, ["腎炎"], { dictionary: [] });
  const nPlain = n;
  n = 0;
  const dict = [{ terms: ["腎炎", "nephritis"], related: ["架空薬X", "ゼルニア値"] }];
  const expanded = await searchParents(counting, ["腎炎"], { dictionary: dict });
  assert.ok(n - nPlain <= 4, `${n} vs ${nPlain}`);
  const ids = new Set(expanded.map((p) => p.parent_id));
  assert.ok(plain.length >= 1);
  for (const p of plain) assert.ok(ids.has(p.parent_id), p.path); // the fixture has 5 parents, so nothing is pushed out by the cap
  assert.equal(expanded[0].parent_id, plain[0].parent_id); // the literal best hit stays first
});

test("search: dictionary hits do not suppress the content-word retry of a sentence-like query", async () => {
  const params: string[] = [];
  const spy: Db = { all: (sql: string, ...p: unknown[]) => (params.push(...p.map(String)), db.all(sql, ...p)) };
  // related words alone would already find 3+ chunks; the retry for "ゼルニア値" must still run
  const dict = [{ terms: ["ゼルニア値", "zernia"], related: ["架空薬X", "腎炎", "eGFR", "架空症候群"] }];
  const r = await searchParents(spy, ["ゼルニア値が基準の半分以下になる状態とは何ですか"], { dictionary: dict });
  assert.ok(params.includes('"ゼル ルニ ニア ア値"') || params.some((x) => x.includes('"ゼル ルニ ニア ア値"')), "content-word retry ran");
  assert.ok(r.some((p) => p.text.includes("基準の半分以下")));
});
