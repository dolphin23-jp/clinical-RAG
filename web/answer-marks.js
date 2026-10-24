// Builds the markdown the answer is rendered from: citation chips are spliced in after cited text (as before), and text
// the books do not back (no citation on its block) is marked so it can be shown lighter (docs/enhancement-plan.md C6).
// Pure functions, no DOM: tested in worker/test/marks.test.ts.
//
// Marking is per line, only for lines that carry a statement: headings, table rows, rules, code fences, quotes and
// short connective lines are left alone.  A block that continues the previous line (the API splits text blocks at
// citations, sometimes mid-line) is not marked at its first line.  UNCITED is a private-use character that
// md.js turns into <span class="uncited">.

export const UNCITED = "\uE002";
const LIST_RE = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/;
const SKIP_RE = /^\s*(#{1,6}\s|```|>|\|)|\|/; // heading, fence, quote, table row (any line with a pipe)
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
export const MIN_LETTERS = 12;

/** letters, digits and CJK characters left after removing markdown emphasis marks */
function substance(s) {
  return (s.replace(/\*\*|`/g, "").match(/[\p{L}\p{N}]/gu) || []).length;
}

/** Marks the statement lines of an uncited block. `atLineStart`: false when the block continues the previous line. */
export function markUncited(text, atLineStart = true) {
  return String(text)
    .split("\n")
    .map((line, i) => {
      if (i === 0 && !atLineStart) return line;
      if (!line.trim() || SKIP_RE.test(line) || HR_RE.test(line)) return line;
      const m = LIST_RE.exec(line);
      const body = m ? m[3] : line;
      if (substance(body) < MIN_LETTERS) return line;
      return m ? `${m[1]}${m[2]} ${UNCITED}${m[3]}` : UNCITED + line.trimStart();
    })
    .join("\n");
}

/**
 * blocks: [{ text, citations }] of the final answer.  keysOf(block) registers its citations and returns their keys.
 * mark: true to mark uncited statements (only meaningful when the answer cites at least one book).
 * Returns { md, plain, groups }: md has the chip sentinels, plain is the clipboard text, groups[i] the keys of chip i.
 */
export function buildAnswerMarkdown(blocks, keysOf, { citeOpen, citeClose, mark = true }) {
  const groups = [];
  let md = "";
  let plain = "";
  for (const b of blocks) {
    const keys = keysOf(b);
    plain += b.text;
    if (keys.length) {
      groups.push(keys);
      md += b.text.replace(/(\s*)$/, `${citeOpen}${groups.length - 1}${citeClose}$1`);
    } else md += mark ? markUncited(b.text, md === "" || md.endsWith("\n")) : b.text;
  }
  return { md, plain, groups };
}
