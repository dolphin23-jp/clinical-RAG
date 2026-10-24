import { dbBackend, evalRetrieval, parseQuestions } from "../../eval/lib.ts";
import { runAsk, type StreamEvent } from "./anthropic.ts";
import type { Db } from "./db.ts";
import { splitBlocks, headerText, pageLabel } from "./format.ts";
import { ConvInputError, convStore } from "./convstore.ts";
import { EvalInputError, evalStore, ID_RE, type D1Rw } from "./evalstore.ts";
import { scanAll } from "./idguard.ts";
import { numericWorksheet } from "./numsample.ts";
import { getParent, searchParents } from "./search.ts";
import { expandQueries } from "./synonyms.ts";
import { jstDay, type AskCounter } from "./usage.ts";

export interface PageStore {
  get(key: string): Promise<{ body: ReadableStream | ArrayBuffer | null; contentType?: string } | null>;
}

export interface AppDeps {
  db: Db;
  apiKey: string;
  appToken: string;
  model: string;
  allowedModels?: string[];
  webDomains?: string[];
  pages?: PageStore;
  assets?: (req: Request) => Promise<Response>;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  /** /api/ask calls allowed per day (Japan time). 0 or unset = no cap. */
  dailyAskLimit?: number;
  counter?: AskCounter;
  now?: () => Date;
  /** D1 for the evaluation questions and the conversations (evalstore.ts, convstore.ts); unset = those endpoints answer 501 */
  rw?: D1Rw;
  /** conversations expire this many days after their last turn (0 = never) */
  conversationRetentionDays?: number;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

function authorized(req: Request, token: string): boolean {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return !!m && timingSafeEqual(m[1].trim(), token);
}

/**
 * Identifier guard at the API boundary (docs/clinical-use.md 2.3). The screen checks first and lets the user confirm;
 * a request that still carries a hit without `ack_identifier: true` is refused before anything reaches the model.
 * Only the kinds of match are returned, never the matched text.
 */
function identifierRefusal(texts: unknown[], ack: unknown): Response | null {
  const hits = scanAll(texts);
  if (!hits.length || ack === true) return null;
  const labels = hits.map((h) => h.label);
  return json(
    {
      error: `患者を特定できる情報の可能性があります（${labels.join("、")}）。氏名・ID などを除いてから送ってください。`,
      code: "possible_identifier",
      labels,
    },
    400,
  );
}

/** Daily cap on /api/ask. A counter failure never blocks the doctor (the cap protects the bill, not the patient). */
async function overDailyLimit(deps: AppDeps): Promise<Response | null> {
  const limit = deps.dailyAskLimit ?? 0;
  if (!(limit > 0) || !deps.counter) return null;
  let n: number;
  try {
    n = await deps.counter.increment(jstDay(deps.now?.() ?? new Date()));
  } catch (e) {
    console.warn(`daily ask counter unavailable, continuing without the cap: ${(e as Error).message}`);
    return null;
  }
  if (n <= limit) return null;
  return json({ error: `1日の利用上限（${limit}回）に達しました。日本時間の0時に戻ります。`, code: "daily_limit", limit }, 429);
}

export async function handle(req: Request, deps: AppDeps): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (!path.startsWith("/api/")) {
    return deps.assets ? deps.assets(req) : new Response("not found", { status: 404 });
  }
  if (path === "/api/health") return json({ ok: true });
  if (!deps.appToken || deps.appToken.length < 16) return json({ error: "server misconfigured: APP_TOKEN must be set (>= 16 chars)" }, 500);
  if (!authorized(req, deps.appToken)) return json({ error: "unauthorized" }, 401);

  try {
    if (path === "/api/books" && req.method === "GET") {
      const rows = await deps.db.all(
        `SELECT b.book_id, b.title, b.edition, b.publisher, b.pub_year,
                COUNT(DISTINCT ch.chapter_id) AS chapters,
                (SELECT COUNT(*) FROM chunks c WHERE c.book_id = b.book_id) AS chunks,
                (SELECT COUNT(*) FROM issues i JOIN chapters c2 ON c2.chapter_id = i.chapter_id
                  WHERE c2.book_id = b.book_id AND i.level IN ('error','warn')) AS open_issues
           FROM books b LEFT JOIN chapters ch ON ch.book_id = b.book_id
          GROUP BY b.book_id ORDER BY b.title`,
      );
      return json({ books: rows });
    }

    const pm = /^\/api\/parent\/(.+)$/.exec(path);
    if (pm && req.method === "GET") {
      const p = await getParent(deps.db, decodeURIComponent(pm[1]));
      if (!p) return json({ error: "not found" }, 404);
      const { text: head, flags } = headerText(p);
      return json({
        parent_id: p.parent_id,
        book_id: p.book_id,
        book_title: p.book_title,
        path: p.path,
        page_label: pageLabel(p),
        header: head,
        flags,
        text: p.text,
        blocks: splitBlocks(p.text).blocks,
        refs: p.refs,
        notes: p.notes,
        text_reliability: p.text_reliability,
      });
    }

    const pg = /^\/api\/page\/([A-Za-z0-9._-]{1,40})\/(\d{1,5})$/.exec(path);
    if (pg && req.method === "GET") {
      if (!deps.pages) return json({ error: "page images are not configured" }, 404);
      const obj = await deps.pages.get(`pages/${pg[1]}/${pg[2]}.webp`);
      if (!obj || !obj.body) return json({ error: "page image not found" }, 404);
      return new Response(obj.body as BodyInit, {
        headers: { "content-type": obj.contentType ?? "image/webp", "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" },
      });
    }

    // Retrieval only (no LLM call, no cost): for debugging recall and for evaluating the deployed index.
    if (path === "/api/search" && req.method === "POST") {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      const queries = (Array.isArray(body?.queries) ? body.queries : typeof body?.query === "string" ? [body.query] : [])
        .filter((x: unknown): x is string => typeof x === "string")
        .map((x: string) => x.trim().slice(0, 200))
        .filter(Boolean)
        .slice(0, 5);
      if (!queries.length) return json({ error: "queries must contain 1-5 non-empty strings" }, 400);
      const refused = identifierRefusal(queries, body.ack_identifier);
      if (refused) return refused;
      const bookIds = Array.isArray(body.book_ids) ? body.book_ids.map(String).slice(0, 20) : undefined;
      // `expand: false` turns the dictionary off and `max_per_book` lifts the diversity cap: both exist for evaluation
      // (eval/run_eval.ts --api compares with and without the dictionary); callers that omit them get the defaults.
      const expand = body.expand !== false;
      const maxPerBook = Number.isInteger(body.max_per_book) ? Math.min(Math.max(body.max_per_book, 1), 10) : undefined;
      const parents = await searchParents(deps.db, queries, {
        bookIds,
        includeReferences: !!body.include_references,
        parents: Math.min(Number(body.parents) || 5, 10),
        ...(maxPerBook ? { maxPerBook } : {}),
        ...(expand ? {} : { dictionary: [] }),
      });
      return json({
        queries,
        // dictionary terms that were added to this search (synonyms.ts), so a reader can see why a section came up
        expanded: expand ? expandQueries(queries) : { synonyms: [], related: [] },
        results: parents.map((p) => ({
          parent_id: p.parent_id,
          book_id: p.book_id,
          book_title: p.book_title,
          path: p.path,
          page_label: pageLabel(p),
          score: Number(p.score.toFixed(5)),
          flags: headerText(p).flags,
          matched_chunks: p.matched.length,
          snippet: p.text.slice(0, 240),
        })),
      });
    }

    // Numeric transcription-error worksheet for the app (T1-7 on an iPad). Read-only; judgments stay on the device.
    if (path === "/api/numeric/sample" && req.method === "GET") {
      const int = (k: string, d: number, lo: number, hi: number) => {
        const v = Number(url.searchParams.get(k) ?? d);
        return Number.isInteger(v) ? Math.min(Math.max(v, lo), hi) : d;
      };
      const books = (url.searchParams.get("books") ?? "").split(",").map((b) => b.trim()).filter((b) => /^[A-Za-z0-9._-]{1,40}$/.test(b));
      const sheet = await numericWorksheet(deps.db, { chunks: int("chunks", 40, 1, 100), perChunk: int("per_chunk", 3, 1, 5), seed: int("seed", 1, 0, 2 ** 31 - 1), bookIds: books });
      return json(sheet);
    }

    // Conversations in D1 (doctor's decision 2026-10-24, docs/clinical-use.md 1d)
    if (path === "/api/conversations" || path.startsWith("/api/conversations/")) return await convRoutes(req, url, deps);

    // Evaluation questions in D1 and a one-question retrieval run (T1-8 on an iPad; doctor's decision 2026-10-24).
    if (path.startsWith("/api/eval/")) return await evalRoutes(req, url, deps);

    if (path === "/api/ask" && req.method === "POST") {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      const question = typeof body?.question === "string" ? body.question.trim() : "";
      if (!question || question.length > 4000) return json({ error: "question must be 1-4000 characters" }, 400);
      const history = Array.isArray(body.history)
        ? body.history
            .slice(-16)
            .filter((h: any) => (h?.role === "user" || h?.role === "assistant") && typeof h.text === "string")
            .map((h: any) => ({ role: h.role, text: String(h.text).slice(0, 8000) }))
        : [];
      // assistant turns are the model's own text (they may quote PMIDs etc.); only what the user typed is checked
      const refused = identifierRefusal([question, ...history.filter((h: any) => h.role === "user").map((h: any) => h.text)], body.ack_identifier);
      if (refused) return refused;
      const capped = await overDailyLimit(deps);
      if (capped) return capped;
      const allowed = deps.allowedModels?.length ? deps.allowedModels : [deps.model];
      const model = typeof body.model === "string" && allowed.includes(body.model) ? body.model : deps.model;
      const bookIds = Array.isArray(body.book_ids) ? body.book_ids.map(String).slice(0, 20) : undefined;
      return sse(req, async (emit) => {
        await runAsk(
          { db: deps.db, apiKey: deps.apiKey, model, webDomains: deps.webDomains, fetchImpl: deps.fetchImpl, apiBase: deps.apiBase, signal: req.signal },
          { question, history, web: !!body.web, bookIds, model },
          emit,
        );
      });
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

async function convRoutes(req: Request, url: URL, deps: AppDeps): Promise<Response> {
  if (!deps.rw) return json({ error: "conversation storage is not configured" }, 501);
  const store = convStore(deps.rw, { retentionDays: deps.conversationRetentionDays });
  const now = (deps.now?.() ?? new Date()).toISOString();
  try {
    if (url.pathname === "/api/conversations") {
      if (req.method === "GET") return json({ conversations: await store.list(now), retention_days: store.retentionDays });
      if (req.method === "DELETE") {
        await store.removeAll();
        return json({ deleted: "all" });
      }
    }
    const m = /^\/api\/conversations\/([^/]+)(\/turns)?$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (!m[2] && req.method === "GET") {
        const c = await store.get(id);
        return c ? json(c) : json({ error: "not found" }, 404);
      }
      if (!m[2] && req.method === "DELETE") return json({ deleted: await store.remove(id) });
      if (m[2] && req.method === "POST") {
        let b: any;
        try {
          b = await req.json();
        } catch {
          return json({ error: "invalid JSON" }, 400);
        }
        return json({ seq: await store.append(id, { question: b?.question, answer: b?.answer, payload: b?.payload }, now) });
      }
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    if (e instanceof ConvInputError) return json({ error: e.message, code: e.code }, 400);
    throw e;
  }
}

async function evalRoutes(req: Request, url: URL, deps: AppDeps): Promise<Response> {
  if (!deps.rw) return json({ error: "evaluation storage is not configured" }, 501);
  const store = evalStore(deps.rw);
  const now = (deps.now?.() ?? new Date()).toISOString();
  const body = async () => {
    try {
      return await req.json();
    } catch {
      throw new EvalInputError("invalid JSON");
    }
  };
  try {
    if (url.pathname === "/api/eval/questions" && req.method === "GET") {
      const rows = await store.list();
      if (url.searchParams.get("format") === "jsonl") {
        return new Response(rows.map((r) => r.line).join("\n") + (rows.length ? "\n" : ""), { headers: { ...JSON_HEADERS, "content-type": "text/plain; charset=utf-8" } });
      }
      return json({ questions: rows });
    }
    const qm = /^\/api\/eval\/questions\/([^/]+)$/.exec(url.pathname);
    if (qm) {
      const id = decodeURIComponent(qm[1]);
      if (!ID_RE.test(id)) return json({ error: "bad id" }, 400);
      if (req.method === "PUT") {
        const b: any = await body();
        return json({ question: await store.put(id, b?.line, now) });
      }
      if (req.method === "DELETE") return json({ deleted: await store.remove(id) });
    }
    if (url.pathname === "/api/eval/import" && req.method === "POST") {
      const b: any = await body();
      return json({ imported: await store.importText(b?.text, now) });
    }
    // one stored question, searched with and without the dictionary (one request per question keeps the D1 query count low)
    if (url.pathname === "/api/eval/retrieval" && req.method === "POST") {
      const b: any = await body();
      const id = typeof b?.id === "string" ? b.id : "";
      const row = ID_RE.test(id) ? await store.get(id) : null;
      if (!row) return json({ error: "no such question" }, 404);
      const [q] = parseQuestions(row.line);
      const parents = Number.isInteger(b?.parents) ? Math.min(Math.max(b.parents, 1), 10) : 5;
      const backend = dbBackend(deps.db);
      const [on] = await evalRetrieval(backend, [q], { parents, expand: true });
      const [off] = await evalRetrieval(backend, [q], { parents, expand: false });
      const top = (h: typeof on.hits) => h.slice(0, 3).map((x) => ({ parent_id: x.parent_id, book_id: x.book_id, page_label: x.page_label, path: x.path }));
      return json({ id: q.id, group: q.group, severity: q.severity, negative: q.negative, rank_on: on.rank ?? null, rank_off: off.rank ?? null, top_on: top(on.hits), top_off: top(off.hits) });
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    if (e instanceof EvalInputError) return json({ error: e.message }, 400);
    throw e;
  }
}

function sse(req: Request, run: (emit: (e: StreamEvent) => void) => Promise<void>): Response {
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (s: string) => {
        if (!closed) controller.enqueue(enc.encode(s));
      };
      // keep intermediaries/phone radios from idling out during long upstream waits
      timer = setInterval(() => send(": keepalive\n\n"), 15000);
      try {
        await run((e) => send(`data: ${JSON.stringify(e)}\n\n`));
      } catch (e) {
        send(`data: ${JSON.stringify({ t: "error", message: (e as Error).message })}\n\n`);
      } finally {
        clearInterval(timer);
        closed = true;
        try {
          controller.close();
        } catch {
          /* client went away */
        }
      }
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no", "x-content-type-options": "nosniff" },
  });
}
