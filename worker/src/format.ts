// Turns retrieval results into Anthropic `search_result` blocks (citable), and maps citations back.
import type { ParentResult } from "./search.ts";

export interface SearchResultBlock {
  type: "search_result";
  source: string;
  title: string;
  content: { type: "text"; text: string }[];
  citations: { enabled: true };
}

export interface SourceMeta {
  source: string;
  parent_id: string;
  book_id: string;
  title: string;
  page_label: string;
  /** page label in effect at each content block (index-aligned with `content`; block 0 is the meta header) */
  block_pages: (string | null)[];
  flags: string[];
  queries: string[];
}

const BLOCK_TARGET = 480;
const PAGE_MARK = /^［(p\.[\d\-]+)］$/;
const BREAK_BEFORE = /^(［p\.|■ |\*\*(図|表)|［転写者補助)/;

export function pageLabel(p: Pick<ParentResult, "page_start" | "page_end">): string {
  if (p.page_start == null) return "";
  return p.page_end && p.page_end !== p.page_start ? `p.${p.page_start}-${p.page_end}` : `p.${p.page_start}`;
}

export function sourceId(parentId: string): string {
  return `medbook://${parentId}`;
}

export function parentIdFromSource(source: string): string | null {
  return source.startsWith("medbook://") ? source.slice("medbook://".length) : null;
}

/** Split parent text into small citable blocks; page markers / sub-headings / captions start a new block. */
export function splitBlocks(text: string): { blocks: string[]; pages: (string | null)[] } {
  const blocks: string[] = [];
  const pages: (string | null)[] = [];
  let cur: string[] = [];
  let curLen = 0;
  let pageNow: string | null = null;
  let pageAtBlockStart: string | null = null;
  const flush = () => {
    const t = cur.join("\n").trim();
    if (t) {
      blocks.push(t);
      pages.push(pageAtBlockStart);
    }
    cur = [];
    curLen = 0;
  };
  for (const line of text.split("\n")) {
    const pm = PAGE_MARK.exec(line.trim());
    if (BREAK_BEFORE.test(line) || curLen + line.length > BLOCK_TARGET) flush();
    if (pm) pageNow = pm[1];
    if (cur.length === 0) pageAtBlockStart = pageNow;
    cur.push(line);
    curLen += line.length + 1;
  }
  flush();
  return { blocks, pages };
}

export function headerText(p: ParentResult): { text: string; flags: string[] } {
  const flags: string[] = [];
  const ed = p.edition ? `第${p.edition}版` : "";
  const pub = [p.publisher, p.pub_year].filter(Boolean).join(" ");
  const lines = [
    `［メタ情報］書名: ${p.book_title}${pub ? `（${pub}）` : ""}／章節: ${p.path}／頁: ${pageLabel(p)}${p.author ? `／著者: ${p.author}` : ""}${ed && !p.book_title.includes(ed) ? `／${ed}` : ""}`,
  ];
  const warn: string[] = [];
  if (p.numeric_critical) {
    warn.push("用量・閾値などの数値を含む可能性: 原本の頁で必ず再確認すること");
    flags.push("数値注意");
  }
  if (p.has_transcriber_aid) {
    warn.push("転写者の補助記述（図の構造説明）を含む: 書籍の主張として引用しないこと");
    flags.push("転写者補助含む");
  }
  if (/未実施|未確認/.test(p.text_reliability)) {
    warn.push(`この章の転写は全文の二重照合が未完了（${p.text_reliability}）`);
    flags.push("照合未完");
  }
  const sev = p.notes.filter((n) => n.code !== "W_RELIABILITY" && n.code !== "I_CHUNK_NOTE");
  for (const n of sev.slice(0, 4)) {
    warn.push(`既知の問題[${n.code}]: ${n.message}`);
    flags.push("既知の問題");
  }
  if (warn.length) lines.push("［注意］" + warn.join("／"));
  return { text: lines.join("\n"), flags: [...new Set(flags)] };
}

export function toSearchResult(p: ParentResult, queries: string[]): { block: SearchResultBlock; meta: SourceMeta } {
  const { text: head, flags } = headerText(p);
  const { blocks, pages } = splitBlocks(p.text);
  const edition = p.edition ? ` 第${p.edition}版` : "";
  const flagStr = flags.length ? " " + flags.map((f) => `［${f}］`).join("") : "";
  const title = `${p.book_title.replace(/\s*第\d+版$/, "")}${edition}${p.pub_year ? ` (${p.pub_year})` : ""} ${p.path} ${pageLabel(p)}${flagStr}`;
  const source = sourceId(p.parent_id);
  return {
    block: {
      type: "search_result",
      source,
      title,
      content: [{ type: "text", text: head }, ...blocks.map((t) => ({ type: "text" as const, text: t }))],
      citations: { enabled: true },
    },
    meta: { source, parent_id: p.parent_id, book_id: p.book_id, title, page_label: pageLabel(p), block_pages: [null, ...pages], flags, queries },
  };
}

export interface UiCitation {
  kind: "book" | "web";
  title: string;
  cited_text: string;
  // book
  parent_id?: string;
  book_id?: string;
  page?: string | null;
  flags?: string[];
  // web
  url?: string;
}

export function resolveCitation(c: any, registry: Map<string, SourceMeta>): UiCitation | null {
  if (c?.type === "search_result_location") {
    const meta = registry.get(c.source);
    const start: number = c.start_block_index ?? 0;
    return {
      kind: "book",
      title: meta?.title ?? c.title ?? c.source,
      cited_text: c.cited_text ?? "",
      parent_id: meta?.parent_id ?? parentIdFromSource(c.source) ?? undefined,
      book_id: meta?.book_id,
      page: meta?.block_pages[start] ?? meta?.page_label ?? null,
      flags: meta?.flags ?? [],
    };
  }
  if (c?.type === "web_search_result_location") {
    return { kind: "web", title: c.title ?? c.url, cited_text: c.cited_text ?? "", url: c.url };
  }
  return null;
}
