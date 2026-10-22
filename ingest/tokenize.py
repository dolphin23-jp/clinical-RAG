"""Index/query-side text normalisation shared (by contract) with worker/src/tokenize.ts.

Why this exists
---------------
SQLite FTS5's `trigram` tokenizer cannot match terms shorter than 3 characters, and
Japanese medical text is full of 2-character terms (腎炎, 感度, 浮腫).  We therefore keep
two lexical indexes:

* `chunks_tri`  – trigram index: substring match for terms >= 3 chars (incl. 'GFR' inside 'eGFR').
* `chunks_bi`   – `unicode61` index over *character bigrams* produced here: covers every
                  CJK term >= 2 chars, and whole Latin/digit words ('cr', 'aki').

The two functions below MUST stay byte-for-byte compatible with the TypeScript copy.
tests/vectors/tokenize.json is the shared contract.
"""
from __future__ import annotations

import re
import unicodedata

# Hiragana/Katakana, CJK ext-A, CJK unified, compat ideographs, iteration marks, prolonged sound mark.
CJK_CLASS = "぀-ヿ㐀-䶿一-鿿豈-﫿々〆ヵヶー"
_RUN = re.compile(f"[{CJK_CLASS}]+|[0-9a-z]+")
_IS_CJK = re.compile(f"[{CJK_CLASS}]")
_TERM_SPLIT = re.compile(r"[\s,，、．。;；:：()（）「」『』\[\]【】/／・]+")


def norm(s: str) -> str:
    return unicodedata.normalize("NFKC", s).lower()


def bigram_tokens(s: str) -> list[str]:
    out: list[str] = []
    for m in _RUN.finditer(norm(s)):
        t = m.group()
        if _IS_CJK.match(t[0]):
            if len(t) == 1:
                out.append(t)
            else:
                out.extend(t[i : i + 2] for i in range(len(t) - 1))
        else:
            out.append(t)
    return out


def bigram_text(s: str) -> str:
    """Space-joined bigram tokens; this is what the `chunks_bi` FTS table indexes."""
    return " ".join(bigram_tokens(s))


def query_terms(q: str) -> list[str]:
    """Split a free-text query into terms (whitespace / punctuation separated)."""
    return [t for t in _TERM_SPLIT.split(unicodedata.normalize("NFKC", q)) if t]


def clean_for_index(s: str) -> str:
    """Strip markup that would pollute lexical indexes (superscript citations, <br>)."""
    s = re.sub(r"<sup>[^<]*</sup>", " ", s)
    s = re.sub(r"<br\s*/?>", " ", s)
    s = re.sub(r"[*|`]|:?-{3,}:?", " ", s)  # markdown emphasis / table rules
    return s
