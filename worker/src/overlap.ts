// Copied-text check for a created fictional case (docs/enhancement-plan.md 7.4).  A case made "from the books" must be new: it
// must not repeat a sentence of a book, nor a book's own case.  This finds runs of MIN_OVERLAP or more characters that the answer
// shares, letter for letter, with any section the search returned for the question.  Deterministic, read-only, a warning and not a
// verdict: a run that long is almost never a coincidence, but the doctor decides what to do about it.
//
// Comparison is on letters and digits only (NFKC, lower case; spaces, punctuation and markup ignored), so a book's sentence with
// a changed bracket, a full-width digit or a line break still matches.  Linear time: the windows of the sources go into a set.

export const MIN_OVERLAP = 30;

export interface OverlapFinding {
  /** the answer's own text of the run (cut to 160 characters), so the screen can show and mark it */
  text: string;
  /** how many letters/digits the run shares with the book, markup and spaces not counted */
  length: number;
  /** page label of the section the run was found in ("p.10-12"), when known */
  page: string;
}

const KEEP = /[\p{L}\p{N}]/u;

/** Letters and digits of `s` in one form, with the index in `s` each came from. */
function squeeze(s: string): { n: string; at: number[] } {
  let n = "";
  const at: number[] = [];
  let i = 0;
  for (const ch of s) {
    for (const c of ch.normalize("NFKC").toLowerCase()) {
      if (KEEP.test(c)) {
        n += c;
        at.push(i);
      }
    }
    i += ch.length;
  }
  return { n, at };
}

export function findOverlaps(answer: string, sources: { text: string; page_label: string }[], opts: { min?: number; max?: number } = {}): OverlapFinding[] {
  const min = opts.min ?? MIN_OVERLAP;
  const a = squeeze(answer);
  if (a.n.length < min) return [];
  const windows = new Map<string, number>();
  sources.forEach((src, k) => {
    const { n } = squeeze(src.text);
    for (let i = 0; i + min <= n.length; i++) {
      const w = n.slice(i, i + min);
      if (!windows.has(w)) windows.set(w, k);
    }
  });
  const out: OverlapFinding[] = [];
  let i = 0;
  while (i + min <= a.n.length) {
    const first = windows.get(a.n.slice(i, i + min));
    if (first === undefined) {
      i++;
      continue;
    }
    let end = i; // last window start of this run
    while (end + 1 + min <= a.n.length && windows.has(a.n.slice(end + 1, end + 1 + min))) end++;
    const from = a.at[i];
    const to = a.at[end + min - 1] + 1;
    const raw = answer.slice(from, to).trim();
    out.push({ text: raw.length > 160 ? `${raw.slice(0, 160)}…` : raw, length: end - i + min, page: sources[first].page_label || "" });
    i = end + min; // the next run starts after this one
  }
  return out.sort((x, y) => y.length - x.length).slice(0, opts.max ?? 5);
}
