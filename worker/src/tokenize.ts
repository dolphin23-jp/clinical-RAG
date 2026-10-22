// Query-side twin of ingest/tokenize.py.  tests/vectors/tokenize.json is the shared contract:
// both implementations must reproduce it exactly (see worker/test/tokenize.test.ts).

const CJK = "぀-ヿ㐀-䶿一-鿿豈-﫿々〆ヵヶー";
const RUN = new RegExp(`[${CJK}]+|[0-9a-z]+`, "g");
const IS_CJK = new RegExp(`^[${CJK}]`);
const TERM_SPLIT = /[\s,，、．。;；:：()（）「」『』\[\]【】/／・]+/;

export function norm(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

export function bigramTokens(s: string): string[] {
  const out: string[] = [];
  for (const m of norm(s).matchAll(RUN)) {
    const t = m[0];
    if (IS_CJK.test(t)) {
      if (t.length === 1) out.push(t);
      else for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
    } else {
      out.push(t);
    }
  }
  return out;
}

export function bigramText(s: string): string {
  return bigramTokens(s).join(" ");
}

export function queryTerms(q: string): string[] {
  return q.normalize("NFKC").split(TERM_SPLIT).filter((t) => t.length > 0);
}

const CONTENT_SPLIT = /[\u3040-\u309f\s\p{P}\p{S}]+/u;

/**
 * Content words of a sentence-like query: split at hiragana (particles/inflection) and punctuation, keep terms of
 * >= 2 characters.  "感度と特異度の違いを教えて" -> ["感度", "特異度", "違い"] ... Used only as a recall fallback when the
 * literal query finds (almost) nothing, because a whole sentence is otherwise one exact-phrase term.
 */
export function contentTerms(q: string): string[] {
  const out = norm(q)
    .split(CONTENT_SPLIT)
    .filter((t) => [...t].length >= 2);
  return [...new Set(out)];
}
