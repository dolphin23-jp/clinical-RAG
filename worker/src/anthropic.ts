// Streaming tool-use loop against the Anthropic Messages API.
//   question -> (forced) search_books -> search_result blocks -> answer with citations
// The client tool `search_books` runs on our own index; `web_search` (server tool) is optional.
import type { Db } from "./db.ts";
import { resolveCitation, toSearchResult, type SourceMeta, type UiCitation } from "./format.ts";
import { DEFAULT_WEB_DOMAINS, SEARCH_TOOL, SYSTEM_PROMPT } from "./prompt.ts";
import { searchParents } from "./search.ts";

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
  | { t: "final"; blocks: { text: string; citations: UiCitation[] }[]; usage: Usage; turns: number; stop_reason: string }
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
}

const API_VERSION = "2023-06-01";

export function buildRequestBody(deps: AskDeps, input: AskInput, messages: any[], turn: number): any {
  const tools: any[] = [SEARCH_TOOL];
  if (input.web) {
    const domains = deps.webDomains ?? DEFAULT_WEB_DOMAINS;
    tools.push({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 3,
      ...(domains.length ? { allowed_domains: domains } : {}),
    });
  }
  const today = (deps.now ?? new Date()).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  const body: any = {
    model: input.model ?? deps.model,
    max_tokens: deps.maxTokens ?? 8000,
    stream: true,
    system: [{ type: "text", text: `${SYSTEM_PROMPT}\n\n今日の日付: ${today}（日本時間）`, cache_control: { type: "ephemeral" } }],
    tools,
    messages,
  };
  // First turn: force a search so the answer is always grounded in the library, never memory alone.
  if (turn === 1) body.tool_choice = { type: "tool", name: SEARCH_TOOL.name };
  return body;
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
}

async function streamTurn(deps: AskDeps, body: any, emit: (e: StreamEvent) => void, usage: Usage): Promise<TurnResult> {
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
        if (b.type === "text") {
          b.text ??= "";
        }
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
  return { content: blocks.filter(Boolean), stop_reason };
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
  const maxTurns = deps.maxTurns ?? 6;
  const maxSearches = deps.maxBookSearches ?? 4;

  const messages: any[] = [];
  for (const h of (input.history ?? []).slice(-8)) {
    if (h.text?.trim()) messages.push({ role: h.role, content: h.text });
  }
  messages.push({ role: "user", content: input.question });
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
    for (turns = 1; turns <= maxTurns; turns++) {
      emit({ t: "status", text: turns === 1 ? "書籍を検索します…" : "検索結果を読んでいます…" });
      const body = buildRequestBody(deps, input, messages, turns);
      last = await streamTurn(deps, body, emit, usage);
      const assistantContent = last.content;
      if (last.stop_reason === "tool_use") {
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
            emit({
              t: "sources",
              items: blocks.map(({ meta }) => ({
                source: meta.source,
                parent_id: meta.parent_id,
                book_id: meta.book_id,
                title: meta.title,
                page_label: meta.page_label,
                flags: meta.flags,
                queries,
              })),
            });
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
      break;
    }
    if (!last) throw new Error("no response");
    if (last.stop_reason === "tool_use" || last.stop_reason === "pause_turn") {
      emit({ t: "error", message: `検索の往復が上限（${maxTurns}回）に達しても回答が完了しませんでした。質問を絞って再度お試しください。` });
      return;
    }
    const blocks = last.content
      .filter((b) => b.type === "text" && b.text?.trim())
      .map((b) => ({
        text: b.text as string,
        citations: ((b.citations ?? []) as any[]).map((c) => resolveCitation(c, registry)).filter((x): x is UiCitation => !!x),
      }));
    if (last.stop_reason === "refusal") {
      emit({ t: "error", message: "モデルが回答を拒否しました（stop_reason=refusal）。質問を言い換えてください。" });
      return;
    }
    emit({ t: "final", blocks, usage, turns: Math.min(turns, maxTurns), stop_reason: last.stop_reason });
  } catch (e) {
    emit({ t: "error", message: (e as Error).message });
  }
}
