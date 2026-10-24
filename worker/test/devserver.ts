// Local UI test harness (NOT deployed): real handler + real search over a SQLite file,
// but the Anthropic API is replaced by a scripted fake so the PWA can be exercised offline.
//   node --no-warnings worker/test/devserver.ts <db.sqlite> [port] [--no-pages]
import { readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { handle } from "../src/handler.ts";
import { openDb, openRw, REPO } from "./nodeDb.ts";

const dbPath = process.argv[2];
const port = Number(process.argv[3] ?? 8787);
const withPages = !process.argv.includes("--no-pages");
if (!dbPath) throw new Error("usage: devserver.ts <db.sqlite> [port]");
export const TOKEN = "test-token-0123456789abcdef";
const db = openDb(dbPath);
const rw = openRw(); // evaluation questions (in memory: gone when the dev server stops)
const WEB = join(REPO, "web");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

type Ev = [string, any];
const sseBody = (evs: Ev[], delay = 12): Response => {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(c) {
        for (const [e, d] of evs) {
          c.enqueue(enc.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`));
          await new Promise((r) => setTimeout(r, delay));
        }
        c.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
};
const ms = (usage: any) => ["message_start", { type: "message_start", message: { usage } }] as Ev;
const md = (stop: string, out: number) => ["message_delta", { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: out } }] as Ev;

let mode = "normal";
export const fakeAnthropic = (async (_url: any, init: any) => {
  const body = JSON.parse(init.body);
  const web = (body.tools ?? []).some((t: any) => t.name === "web_search");
  const last = body.messages[body.messages.length - 1];
  const toolResult = Array.isArray(last.content) ? last.content.find((b: any) => b.type === "tool_result") : null;
  const question: string = typeof body.messages.at(-1).content === "string" ? body.messages.at(-1).content : "";
  if (!toolResult) {
    if (/__apierror__/.test(question)) return new Response(JSON.stringify({ error: { message: "overloaded (fake)" } }), { status: 529 });
    // case mode: the final user message starts with the typed case, and the request itself is only a button label
    const caseLine = /- 主訴と経過: ([^\n]*)/.exec(question)?.[1] ?? /- テーマ: ([^\n]*)/.exec(question)?.[1];
    const q = [(caseLine ?? question).replace(/\s+/g, " ").slice(0, 40)];
    const json = JSON.stringify({ queries: q });
    return sseBody([
      ms({ input_tokens: 700, cache_creation_input_tokens: 2100, cache_read_input_tokens: 0 }),
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: "search_books", input: {} } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      md("tool_use", 25),
    ]);
  }
  const results: any[] = Array.isArray(toolResult.content) ? toolResult.content.filter((b: any) => b.type === "search_result") : [];
  if (!results.length) {
    return sseBody([
      ms({ input_tokens: 800, cache_read_input_tokens: 2100 }),
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "検索した書籍には該当する記載が見つかりませんでした。" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ...(web
        ? ([
            ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
            ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Webでは次の記載が見つかりました（要原典確認）。" } }],
            ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://kdigo.org/guidelines/", title: "KDIGO Guidelines", cited_text: "KDIGO guideline excerpt (fake)", encrypted_index: "x" } } }],
            ["content_block_stop", { type: "content_block_stop", index: 1 }],
          ] as Ev[])
        : []),
      md("end_turn", 30),
    ]);
  }
  const A = results[0];
  const first = typeof body.messages[0]?.content === "string" ? body.messages[0].content : "";
  if (/__midbreak__/.test(first)) {
    // the answer starts streaming, then the upstream stream breaks (exercises the degraded path with partial text)
    return sseBody([
      ms({ input_tokens: 4200, cache_read_input_tokens: 2100 }),
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "途中まで書いた回答の文。" } }],
      ["error", { type: "error", error: { type: "overloaded_error", message: "stream broke (fake)" } }],
    ]);
  }
  const cite = (r: any, s: number, e: number) => ({ type: "search_result_location", source: r.source, title: r.title, cited_text: r.content.slice(s, e).map((b: any) => b.text).join("\n"), search_result_index: 0, start_block_index: s, end_block_index: e });
  const txt = (i: number, t: string) => [["content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } }], ...t.match(/[\s\S]{1,9}/g)!.map((p) => ["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: p } }] as Ev)] as Ev[];
  const stop = (i: number): Ev => ["content_block_stop", { type: "content_block_stop", index: i }];
  const cd = (i: number, c: any): Ev => ["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "citations_delta", citation: c } }];
  if (/__numbers__/.test(first)) {
    // numbers in all three states (cited / only in a retrieved section / nowhere) and one line no book backs
    const loc = (cited_text: string) => ({ type: "search_result_location", source: A.source, title: A.title, cited_text, search_result_index: 0, start_block_index: 1, end_block_index: 2 });
    const out: Ev[] = [ms({ input_tokens: 4200, cache_read_input_tokens: 2100 })];
    out.push(...txt(0, "- 架空薬Xは 10 mg/日 で開始します。"), cd(0, loc("架空薬Xを 10 mg/日 で開始し")), stop(0));
    out.push(...txt(1, "\n- eGFR 30 未満では半量が目安です。"), cd(1, loc("ゼルニア値を確認する")), stop(1));
    out.push(...txt(2, "\n- 最大 500 mg/日 まで増やせるとされています。"), cd(2, loc("別の記載")), stop(2));
    out.push(...txt(3, "\n- ここは書籍に記載のない、一般的な推論の文です。\n"), stop(3));
    out.push(md("end_turn", 100), ["message_stop", { type: "message_stop" }]);
    return sseBody(out, 8);
  }
  const evs: Ev[] = [ms({ input_tokens: 4200, cache_read_input_tokens: 2100 })];
  // case mode: the second system block names the mode and lists its headings; answer with one cited line and tagged uncited lines per heading
  const sys2: string = body.system?.[1]?.text ?? "";
  const modeLabel = /この依頼の型: ([^\n]+)/.exec(sys2)?.[1];
  if (modeLabel === "架空症例の作成") {
    // case creation: every heading and the seven input lines; the theme can ask for a flaw (__copy__ repeats the book, __dose__ writes a dose and
    // a threshold, __id__ writes an identifier-like number), so the checks on the screen can be seen working
    const asked = body.messages.map((m: any) => (typeof m.content === "string" ? m.content : "")).join("\n");
    const theme = [...asked.matchAll(/- テーマ: ([^\n]*)/g)].at(-1)?.[1] ?? "";
    const bookText = A.content.slice(2).map((b: any) => b.text).join(""); // the first two blocks are the meta line and the heading: not the section's own text
    const copied = /__copy__/.test(theme) ? bookText.replace(/\s+/g, "").slice(0, 80) : "患者は夕方に受診し、前日から食欲がなく、ぼんやりしていた。";
    const dose = /__dose__/.test(theme) ? "\n- ヘパリンは 5000 単位 で開始し、Cr 2.0 以上で減量する。" : "";
    const idnum = /__id__/.test(theme) ? "（検体番号 12345678）" : "";
    let k = 0;
    const put = (t: string, c?: Ev) => {
      evs.push(...txt(k, t));
      if (c) evs.push(c);
      evs.push(stop(k));
      k++;
    };
    put(`## 導入文\n\n${copied}救急外来を受診した。\n\n`);
    put(
      `## 症例の入力用\n\n- 年代: 70代\n- 性別: 男性\n- 場面: 救急\n- 主訴と経過: ゼルニア値の低下を指摘され、3日前から発熱と咳が続く。\n- バイタル: BP 92/54, HR 108, SpO2 94%\n- 所見・検査: Cr 2.4 mg/dL, K 5.8 mEq/L, ゼルニア値 18${idnum}\n- 既往・内服: 高血圧。アムロジピン内服。\n\n`,
    );
    put("## 所見の表\n\n| 項目 | 値 | 根拠 |\n|---|---|---|\n| ゼルニア値 | 18 | 典型的に低下する |", cd(k, cite(A, 1, 2)));
    put("\n| Cr | 2.4 mg/dL | [推論] |\n\n");
    put(`## 見立て\n\n- 想定する診断は架空症候群。鑑別は感染に伴う腎前性AKI。${dose}\n\n`);
    put("## 落とし穴\n\n- 内服薬の関与を聞かないと、原因を見誤る。\n\n## 教訓\n\n- 典型的な低下に加えて、背景の薬剤を確かめる。\n\n## 書籍に見つからなかった点\n\n- 該当なし\n");
    evs.push(md("end_turn", 300), ["message_stop", { type: "message_stop" }]);
    return sseBody(evs, 6);
  }
  if (modeLabel && modeLabel !== "症例を踏まえた質問") {
    const heads = [...sys2.matchAll(/^## (.+)$/gm)].map((m) => m[1]).filter((h) => !h.startsWith("この依頼の型") && !h.startsWith("症例が添えられているとき"));
    let k = 0;
    heads.forEach((h, i) => {
      evs.push(...txt(k, `## ${h}\n\n`), stop(k));
      k++;
      if (i === 0) {
        evs.push(...txt(k, "- 検索結果の記載に基づく要点（入力の Cr 2.4 mg/dL を踏まえる）。"), cd(k, cite(A, 1, 2)), stop(k));
        k++;
        evs.push(...txt(k, "\n- 採用薬の選択は施設の運用による。 [施設依存]\n"), stop(k));
        k++;
      }
      if (i === 1) {
        evs.push(...txt(k, "\n| 問題 | 反証 |\n|---|---|\n| 急性腎障害 | 尿量が回復すれば成り立たない |\n"), stop(k));
        k++;
      }
      evs.push(...txt(k, `\n- ${h}について、この症例の入力からの整理。 [推論]\n- 標準的な初期対応として確立している内容。 [標準・出典未確認]\n\n`), stop(k));
      k++;
    });
    evs.push(md("end_turn", 300), ["message_stop", { type: "message_stop" }]);
    return sseBody(evs, 6);
  }
  evs.push(...txt(0, "## 要点\n\n**検索結果の冒頭節**を根拠に整理します。\n\n"), stop(0));
  evs.push(...txt(1, "- 第一に、この節の記載内容を要約する。"), cd(1, cite(A, 1, 2)), stop(1));
  evs.push(...txt(2, "\n- 第二に、別の観点の補足（**数値**は原本確認）。"), cd(2, cite(A, 2, 3)), stop(2));
  evs.push(...txt(3, "\n\n| 項目 | 内容 |\n|---|---|\n| 例1 | 説明A |\n| 例2 | 説明B |"), cd(3, cite(A, 1, 2)), stop(3));
  evs.push(...txt(4, "\n\n※書籍に無い点は推論です。\n"), stop(4));
  let idx = 5;
  if (web) {
    evs.push(...txt(idx, "Web側の補足: ガイドライン改訂に注意。"), cd(idx, { type: "web_search_result_location", url: "https://kdigo.org/guidelines/", title: "KDIGO Guidelines", cited_text: "KDIGO guideline excerpt (fake)", encrypted_index: "x" }), stop(idx));
    idx++;
  }
  evs.push(md("end_turn", 220), ["message_stop", { type: "message_stop" }]);
  return sseBody(evs, 8);
}) as typeof fetch;

const png = readFileSync(join(WEB, "icon-512.png"));
// Apply web/_headers (CSP etc.) to static files exactly as Cloudflare would, so CSP violations show up in tests.
const staticHeaders: Record<string, string> = {};
for (const line of readFileSync(join(WEB, "_headers"), "utf8").split("\n")) {
  const m = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line);
  if (m) staticHeaders[m[1]] = m[2].trim();
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (url.pathname.startsWith("/api/") || url.pathname === "/__mode") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const request = new Request(url, { method: req.method, headers: req.headers as any, body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : Buffer.concat(chunks) });
      const r = await handle(request, {
        db,
        apiKey: "sk-ant-fake",
        appToken: TOKEN,
        model: "claude-sonnet-5-5",
        allowedModels: ["claude-sonnet-5-5", "claude-opus-5-5"],
        fetchImpl: fakeAnthropic,
        rw,
        conversationRetentionDays: 30,
        caseRecordRetentionDays: 60,
        pages: withPages ? { get: async (key) => (/^pages\/[^/]+\/[34]\.webp$/.test(key) ? { body: png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer, contentType: "image/png" } : null) } : undefined,
      });
      res.writeHead(r.status, Object.fromEntries(r.headers));
      if (r.body) {
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
      return;
    }
    let p = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
    if (p === "/" || p === "") p = "/index.html";
    const file = join(WEB, p);
    if (!file.startsWith(WEB) || !existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { ...staticHeaders, "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(readFileSync(file));
  } catch (e) {
    res.writeHead(500).end(String((e as Error).message));
  }
}).listen(port, () => console.log(`dev server on http://localhost:${port}  token=${TOKEN}`));
