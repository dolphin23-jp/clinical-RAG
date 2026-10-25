// Streaming tool-use loop against the Anthropic Messages API.
//   question -> search_books -> search_result blocks -> answer with citations
// The client tool `search_books` runs on our own index; `web_search` (server tool) is optional.
// Claude 5.5 models reject forced tool use (tool_choice any/tool -> HTTP 400), so "always search the library
// first" is enforced here instead: text produced before the first book search is held back, and an answer that
// skips the search is discarded and re-requested once with an explicit instruction.
import type { Db } from "./db.ts";
import { pageLabel as pageLabelOf, resolveCitation, toSearchResult, type SourceMeta, type UiCitation } from "./format.ts";
import { DEFAULT_WEB_DOMAINS, SEARCH_TOOL, SYSTEM_PROMPT } from "./prompt.ts";
import { searchParents } from "./search.ts";
import { checkNumbers, type NumFinding } from "./numcheck.ts";
import { findOverlaps, type OverlapFinding } from "./overlap.ts";
import { contentTerms } from "./tokenize.ts";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  web_search_requests: number;
  book_searches: number;
}

export interface SourceCard {
  source: string;
  parent_id: string;
  book_id: string;
  title: string;
  page_label: string;
  flags: string[];
  queries: string[];
}

export type StreamEvent =
  | { t: "status"; text: string }
  | { t: "sources"; items: SourceCard[] }
  | { t: "delta"; text: string }
  | { t: "reset" } // drop the answer text streamed so far (it was commentary before a tool call)
  | { t: "final"; blocks: { text: string; citations: UiCitation[] }[]; usage: Usage; turns: number; stop_reason: string; searched_books: boolean; numbers: NumFinding[]; overlap?: OverlapFinding[] }
  // the answer could not be completed, but the library still could be searched: show the sections instead of nothing.
  // Text already streamed stays on screen as an unfinished answer (doctor's decision, 2026-10-24).
  | { t: "degraded"; message: string; items: SourceCard[] }
  | { t: "error"; message: string };

export interface AskDeps {
  db: Db;
  apiKey: string;
  model: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  webDomains?: string[];
  maxTurns?: number;
  maxBookSearches?: number;
  maxTokens?: number;
  now?: Date;
  signal?: AbortSignal;
}

export interface AskInput {
  question: string;
  history?: { role: "user" | "assistant"; text: string }[];
  web?: boolean;
  bookIds?: string[];
  model?: string;
  /** case mode (casemode.ts): the rendered case, put before the request in the final user message only (never in the history) */
  caseBlock?: string;
  /** case mode: the parts of `caseBlock` that are the doctor's own words; the numbers in them are the doctor's input and are not checked (default: all of it) */
  caseInputs?: string[];
  /** case mode: the mode's rules and headings (prompt.ts caseSystem), sent as a second system block after the cached base prompt */
  modeSystem?: string;
  /** case mode: words to search when the answer fails before any search (the request itself is only a button label) */
  hint?: string;
  /** case creation: the answer is a new fictional case, so check it for runs copied from the sections it drew on (overlap.ts);
   *  its example numbers are not claims from a book, so the number check is skipped */
  checkOverlap?: boolean;
}

const API_VERSION = "2023-06-01";

/** Appended to the question when the model tried to answer without searching the library. */
export const SEARCH_NUDGE = "【システムからの指示】回答を書く前に、必ず search_books を呼んで手元の書籍を検索してください。記憶だけで回答を始めないでください。";

export function buildRequestBody(deps: AskDeps, input: AskInput, messages: any[], _turn: number, nudge = false): any {
  const tools: any[] = [SEARCH_TOOL];
  if (input.web) {
    const domains = deps.webDomains ?? DEFAULT_WEB_DOMAINS;
    tools.push({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 5,
      ...(domains.length ? { allowed_domains: domains } : {}),
    });
  }
  const today = (deps.now ?? new Date()).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  let msgs = messages;
  if (nudge && messages.length && messages.at(-1).role === "user" && typeof messages.at(-1).content === "string") {
    msgs = [...messages.slice(0, -1), { role: "user", content: [{ type: "text", text: messages.at(-1).content }, { type: "text", text: SEARCH_NUDGE }] }];
  }
  // No tool_choice (= auto): forced tool use is rejected by Claude 5.5.  No temperature/top_p/top_k/prefill/thinking
  // overrides either: those are rejected or fixed on 5.5.  Thinking tokens count against max_tokens, hence the headroom.
  return {
    model: input.model ?? deps.model,
    max_tokens: deps.maxTokens ?? 16000,
    stream: true,
    system: [
      { type: "text", text: `${SYSTEM_PROMPT}\n\n今日の日付: ${today}（日本時間）`, cache_control: { type: "ephemeral" } },
      ...(input.modeSystem ? [{ type: "text", text: input.modeSystem }] : []),
    ],
    tools,
    messages: msgs,
  };
}

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: any }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trimStart();
      }
      if (data) yield { event, data: JSON.parse(data) };
    }
  }
}

interface TurnResult {
  content: any[];
  stop_reason: string;
  /** text deltas that were held back (see `hold` in streamTurn) */
  held: StreamEvent[];
  /** true when text deltas were already sent to the client */
  streamed: boolean;
}

async function streamTurn(deps: AskDeps, body: any, emit0: (e: StreamEvent) => void, usage: Usage, hold = false): Promise<TurnResult> {
  const held: StreamEvent[] = [];
  let streamed = false;
  const emit = (e: StreamEvent) => {
    if (e.t === "delta") {
      if (hold) {
        held.push(e);
        return;
      }
      streamed = true;
    }
    emit0(e);
  };
  const f = deps.fetchImpl ?? fetch;
  const res = await f(`${deps.apiBase ?? "https://api.anthropic.com"}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": deps.apiKey, "anthropic-version": API_VERSION },
    body: JSON.stringify(body),
    signal: deps.signal,
  });
  if (!res.ok || !res.body) {
    let detail = "";
    try {
      const j: any = await res.json();
      detail = j?.error?.message ?? JSON.stringify(j);
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new Error(`Anthropic API ${res.status}: ${detail}`.slice(0, 600));
  }
  const blocks: any[] = [];
  let stop_reason = "end_turn";
  for await (const { event, data } of sseEvents(res.body)) {
    switch (data.type ?? event) {
      case "message_start": {
        const u = data.message?.usage ?? {};
        usage.input_tokens += u.input_tokens ?? 0;
        usage.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
        usage.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
        break;
      }
      case "content_block_start": {
        const b = structuredClone(data.content_block);
        if (b.type === "text") b.text ??= "";
        if (b.type === "thinking") b.thinking ??= ""; // 5.5 may omit the text but still needs the field (and the signature) on replay
        if (b.type === "tool_use" || b.type === "server_tool_use") b.__json = "";
        if (b.type === "server_tool_use" && b.name === "web_search") emit({ t: "status", text: "Webで確認しています…" });
        blocks[data.index] = b;
        break;
      }
      case "content_block_delta": {
        const b = blocks[data.index];
        const d = data.delta;
        if (!b) break;
        if (d.type === "text_delta") {
          b.text += d.text;
          emit({ t: "delta", text: d.text });
        } else if (d.type === "input_json_delta") b.__json += d.partial_json;
        else if (d.type === "citations_delta") (b.citations ??= []).push(d.citation);
        else if (d.type === "thinking_delta") b.thinking = (b.thinking ?? "") + d.thinking;
        else if (d.type === "signature_delta") b.signature = (b.signature ?? "") + d.signature;
        break;
      }
      case "content_block_stop": {
        const b = blocks[data.index];
        if (b && "__json" in b) {
          b.input = b.__json ? JSON.parse(b.__json) : {};
          delete b.__json;
        }
        break;
      }
      case "message_delta": {
        if (data.delta?.stop_reason) stop_reason = data.delta.stop_reason;
        const u = data.usage ?? {};
        usage.output_tokens += u.output_tokens ?? 0;
        usage.web_search_requests += u.server_tool_use?.web_search_requests ?? 0;
        break;
      }
      case "error":
        throw new Error(`Anthropic stream error: ${data.error?.type ?? ""} ${data.error?.message ?? ""}`.trim());
    }
  }
  return { content: blocks.filter(Boolean), stop_reason, held, streamed };
}

/** Blocks that may be sent back as the assistant turn: the API rejects empty text blocks. Thinking blocks stay untouched. */
function echoable(content: any[]): any[] {
  return content.filter((b) => !(b.type === "text" && !String(b.text ?? "").trim()));
}

function cleanQueries(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 5);
}

export async function runAsk(deps: AskDeps, input: AskInput, emit: (e: StreamEvent) => void): Promise<void> {
  const usage: Usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    web_search_requests: 0,
    book_searches: 0,
  };
  const registry = new Map<string, SourceMeta>();
  const cards = new Map<string, SourceCard>();
  // the sections this answer could have drawn from (memory only, for the number check)
  const retrieved = new Map<string, { text: string; page_label: string }>();
  const maxTurns = deps.maxTurns ?? 6;
  const maxSearches = deps.maxBookSearches ?? 4;

  /**
   * Failure path (API error, broken stream, turn limit, refusal). Unless the user cancelled, hand over the sections found
   * so far, or search the question's content words once more (no LLM involved). With nothing to show, it stays an error.
   */
  const degrade = async (message: string): Promise<void> => {
    if (deps.signal?.aborted) {
      emit({ t: "error", message });
      return;
    }
    let items = [...cards.values()];
    if (!items.length) {
      const terms = contentTerms(input.hint ?? input.question).slice(0, input.hint ? 8 : undefined);
      const queries = [terms.length ? terms.join(" ") : (input.hint ?? input.question).slice(0, 200)];
      try {
        const parents = await searchParents(deps.db, queries, { bookIds: input.bookIds });
        items = parents.map((p) => {
          const { meta } = toSearchResult(p, queries);
          return { source: meta.source, parent_id: meta.parent_id, book_id: meta.book_id, title: meta.title, page_label: meta.page_label, flags: meta.flags, queries };
        });
      } catch {
        items = [];
      }
    }
    emit(items.length ? { t: "degraded", message, items } : { t: "error", message });
  };

  const messages: any[] = [];
  for (const h of (input.history ?? []).slice(-8)) {
    if (h.text?.trim()) messages.push({ role: h.role, content: h.text });
  }
  messages.push({ role: "user", content: input.caseBlock ? `${input.caseBlock}\n\n【依頼】${input.question}` : input.question });
  // Anthropic requires alternating roles starting with user; collapse accidental repeats from the client.
  for (let i = messages.length - 2; i >= 0; i--) {
    if (messages[i].role === messages[i + 1].role) {
      messages[i + 1].content = `${messages[i].content}\n\n${messages[i + 1].content}`;
      messages.splice(i, 1);
    }
  }
  if (messages[0].role !== "user") messages.shift();

  try {
    let last: TurnResult | null = null;
    let turns = 0;
    let nudged = false;
    for (turns = 1; turns <= maxTurns; turns++) {
      const searched = usage.book_searches > 0;
      emit({ t: "status", text: !searched ? "書籍を検索します…" : "検索結果を読んでいます…" });
      // Until the library has been searched, hold the text back: an answer written from memory must never reach the screen.
      const body = buildRequestBody(deps, input, messages, turns, nudged && !searched);
      last = await streamTurn(deps, body, emit, usage, !searched);
      const assistantContent = echoable(last.content);
      if (last.stop_reason === "tool_use") {
        if (last.streamed) emit({ t: "reset" }); // text before a tool call was commentary, not the answer
        messages.push({ role: "assistant", content: assistantContent });
        const results: any[] = [];
        for (const b of assistantContent) {
          if (b.type !== "tool_use") continue;
          if (b.name !== SEARCH_TOOL.name) {
            results.push({ type: "tool_result", tool_use_id: b.id, is_error: true, content: `未対応のツール: ${b.name}` });
            continue;
          }
          if (usage.book_searches >= maxSearches) {
            results.push({
              type: "tool_result",
              tool_use_id: b.id,
              content: "検索回数の上限に達しました。これまでの検索結果だけで回答してください。足りない点はその旨を明記してください。",
            });
            continue;
          }
          usage.book_searches++;
          const queries = cleanQueries(b.input?.queries);
          if (!queries.length) {
            results.push({ type: "tool_result", tool_use_id: b.id, is_error: true, content: "queries が空です。キーワードを1つ以上渡してください。" });
            continue;
          }
          emit({ t: "status", text: `書籍を検索: ${queries.join(" / ")}` });
          try {
            const bookIds = Array.isArray(b.input?.book_ids) && b.input.book_ids.length ? b.input.book_ids.map(String) : input.bookIds;
            const parents = await searchParents(deps.db, queries, { bookIds, includeReferences: !!b.input?.include_references });
            if (!parents.length) {
              results.push({
                type: "tool_result",
                tool_use_id: b.id,
                content: "該当する記載が見つかりませんでした。別のキーワード（同義語・英語・略語）で再検索するか、書籍に記載が無いことを回答で明示してください。",
              });
              continue;
            }
            const blocks = parents.map((p) => toSearchResult(p, queries));
            for (const { meta } of blocks) registry.set(meta.source, meta);
            for (const p of parents) retrieved.set(p.parent_id, { text: p.text, page_label: pageLabelOf(p) });
            const items: SourceCard[] = blocks.map(({ meta }) => ({
              source: meta.source,
              parent_id: meta.parent_id,
              book_id: meta.book_id,
              title: meta.title,
              page_label: meta.page_label,
              flags: meta.flags,
              queries,
            }));
            for (const it of items) if (!cards.has(it.source)) cards.set(it.source, it);
            emit({ t: "sources", items });
            results.push({ type: "tool_result", tool_use_id: b.id, content: blocks.map((x) => x.block) });
          } catch (e) {
            results.push({ type: "tool_result", tool_use_id: b.id, is_error: true, content: `検索に失敗しました: ${(e as Error).message}`.slice(0, 300) });
          }
        }
        messages.push({ role: "user", content: results });
        continue;
      }
      if (last.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: assistantContent });
        continue;
      }
      if (!searched && last.stop_reason === "end_turn" && !nudged) {
        // The model answered without calling search_books.  Discard that answer and ask once more, explicitly.
        nudged = true;
        emit({ t: "status", text: "書籍を検索せずに回答しようとしたため、検索からやり直します…" });
        continue;
      }
      for (const e of last.held) emit(e); // still no search after the nudge: show it (the UI flags the missing citations)
      break;
    }
    if (!last) throw new Error("no response");
    if (last.stop_reason === "tool_use" || last.stop_reason === "pause_turn") {
      await degrade(`検索の往復が上限（${maxTurns}回）に達しても回答が完了しませんでした。質問を絞って再度お試しください。`);
      return;
    }
    const blocks = last.content
      .filter((b) => b.type === "text" && b.text?.trim())
      .map((b) => ({
        text: b.text as string,
        citations: ((b.citations ?? []) as any[]).map((c) => resolveCitation(c, registry)).filter((x): x is UiCitation => !!x),
      }));
    if (last.stop_reason === "refusal") {
      await degrade("モデルが回答を拒否しました（stop_reason=refusal）。質問を言い換えてください。");
      return;
    }
    const answerText = blocks.map((b) => b.text).join("\n");
    const overlap = input.checkOverlap ? findOverlaps(answerText, [...retrieved.values()]) : undefined;
    const numbers = input.checkOverlap ? [] : checkNumbers({
      answer: answerText,
      cited: blocks.flatMap((b) => b.citations.map((c) => ({ cited_text: c.cited_text, page: c.page, kind: c.kind }))),
      retrieved: [...retrieved.values()],
      inputs: [input.question, ...(input.caseInputs ?? (input.caseBlock ? [input.caseBlock] : [])), ...(input.history ?? []).filter((h) => h.role === "user").map((h) => h.text)],
    });
    emit({ t: "final", blocks, usage, turns: Math.min(turns, maxTurns), stop_reason: last.stop_reason, searched_books: usage.book_searches > 0, numbers, ...(overlap ? { overlap } : {}) });
  } catch (e) {
    await degrade((e as Error).message);
  }
}
