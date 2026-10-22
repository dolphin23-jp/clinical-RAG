import { CITE_CLOSE, CITE_OPEN, renderMarkdown, stripCiteMarks } from "./md.js";

// ---------------------------------------------------------------- config
const EXAMPLES = ["AKIの定義と病期分類（KDIGO）を、見逃しやすい点も含めて教えて", "高カリウム血症を見たとき最初に確認すること", "検査前確率と尤度比の使い方"];
// USD per million tokens — rough, for the footer estimate only. Edit when pricing changes.
const PRICES = {
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-opus-5-5": { in: 4, out: 20 },
};
const CACHE_READ = 0.05; // x input price
const CACHE_WRITE = 1.25; // x input price (5-minute cache)
const WEB_SEARCH_USD = 0.01; // per request

// ---------------------------------------------------------------- tiny helpers
const $ = (s, root = document) => root.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const mem = {};
const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return mem[k] ?? null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      mem[k] = v;
    }
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {
      delete mem[k];
    }
  },
};

const S = {
  token: store.get("mb.token") || "",
  model: store.get("mb.model") || "",
  web: store.get("mb.web") === "1",
  bookIds: (() => {
    try {
      const v = JSON.parse(store.get("mb.books") || "[]");
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      return [];
    }
  })(),
  books: [],
  history: [], // [{q, a}] plain text only; never persisted
  busy: false,
  ctrl: null,
};

// ---------------------------------------------------------------- api
class AuthError extends Error {}
async function api(path, init = {}) {
  const headers = { authorization: `Bearer ${S.token}`, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers || {}) };
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401 || res.status === 500) {
    const j = await res
      .clone()
      .json()
      .catch(() => ({}));
    if (res.status === 401) throw new AuthError("アクセストークンが正しくありません");
    if (j?.error) throw new Error(j.error);
  }
  return res;
}

async function readSse(res, onEvent) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) onEvent(JSON.parse(data));
    }
  }
}

// ---------------------------------------------------------------- dialogs
function openDialog(d) {
  if (!d.open) d.showModal();
}
for (const d of document.querySelectorAll("dialog")) {
  d.addEventListener("click", (e) => {
    if (e.target === d || e.target.closest("[data-close]")) d.close();
  });
}
const sheet = $("#sheet");
const settings = $("#settings");
sheet.addEventListener("close", () => {
  for (const u of sheet.querySelectorAll("img[data-blob]")) URL.revokeObjectURL(u.dataset.blob);
});

// ---------------------------------------------------------------- settings
function setMsg(text, kind = "") {
  const m = $("#settings-msg");
  m.hidden = !text;
  m.textContent = text || "";
  m.className = "msg" + (kind ? " " + kind : "");
}

function renderBooks() {
  const box = $("#books-list");
  box.replaceChildren();
  if (!S.books.length) {
    box.append(el("p", "help", "書籍一覧はまだ読み込まれていません。"));
    return;
  }
  for (const b of S.books) {
    const label = el("label");
    const cb = el("input");
    cb.type = "checkbox";
    cb.value = b.book_id;
    cb.checked = S.bookIds.includes(b.book_id);
    const span = el("span");
    span.append(document.createTextNode(`${b.title}${b.edition ? ` 第${b.edition}版` : ""}`));
    const small = el("small", null, `${b.chapters}章・${b.chunks}チャンク${b.open_issues ? `・要確認 ${b.open_issues}件` : ""}`);
    span.append(small);
    label.append(cb, span);
    box.append(label);
  }
}

function updateChips() {
  const web = $("#chip-web");
  web.setAttribute("aria-pressed", String(S.web));
  const n = S.bookIds.length;
  $("#chip-books").textContent = n ? `書籍: ${n}冊に限定` : S.books.length ? `書籍: すべて(${S.books.length})` : "書籍: すべて";
}

async function loadBooks() {
  const res = await api("/api/books");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  S.books = (await res.json()).books ?? [];
  const known = new Set(S.books.map((b) => b.book_id));
  S.bookIds = S.bookIds.filter((id) => known.has(id));
  renderBooks();
  updateChips();
}

function openSettings(message, kind) {
  $("#in-token").value = S.token;
  $("#in-model").value = S.model;
  $("#in-web").checked = S.web;
  renderBooks();
  setMsg(message, kind);
  openDialog(settings);
}

$("#btn-settings").addEventListener("click", () => openSettings());
$("#chip-books").addEventListener("click", () => openSettings());
$("#chip-web").addEventListener("click", () => {
  S.web = !S.web;
  store.set("mb.web", S.web ? "1" : "0");
  updateChips();
});
$("#btn-save").addEventListener("click", async () => {
  S.token = $("#in-token").value.trim();
  S.model = $("#in-model").value;
  S.web = $("#in-web").checked;
  S.bookIds = [...document.querySelectorAll("#books-list input:checked")].map((i) => i.value);
  store.set("mb.token", S.token);
  store.set("mb.model", S.model);
  store.set("mb.web", S.web ? "1" : "0");
  store.set("mb.books", JSON.stringify(S.bookIds));
  updateChips();
  if (!S.token) return setMsg("アクセストークンを入力してください。", "err");
  setMsg("接続を確認しています…");
  try {
    await loadBooks();
    setMsg(`接続できました（書籍 ${S.books.length} 冊）。`, "ok");
  } catch (e) {
    setMsg(e.message || "接続に失敗しました。", "err");
  }
});
$("#btn-forget").addEventListener("click", () => {
  store.del("mb.token");
  S.token = "";
  S.books = [];
  $("#in-token").value = "";
  renderBooks();
  updateChips();
  setMsg("この端末のトークンを消去しました。", "ok");
});

// ---------------------------------------------------------------- empty state
const empty = $("#empty");
for (const ex of EXAMPLES) {
  const b = el("button", null, ex);
  b.type = "button";
  b.addEventListener("click", () => {
    $("#q").value = ex;
    autosize();
    $("#q").focus();
  });
  $("#examples").append(b);
}

// ---------------------------------------------------------------- composer
const qEl = $("#q");
const sendBtn = $("#send");
function autosize() {
  qEl.style.height = "auto";
  qEl.style.height = Math.min(qEl.scrollHeight + 2, window.innerHeight * 0.4) + "px";
}
qEl.addEventListener("input", autosize);
qEl.addEventListener("keydown", (e) => {
  // iPhone/iPad soft keyboards: Return = newline. Hardware keyboards: Cmd/Ctrl+Return sends.
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing) {
    e.preventDefault();
    $("#composer").requestSubmit();
  }
});
$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  if (S.busy) {
    S.ctrl?.abort();
    return;
  }
  const q = qEl.value.trim();
  if (!q) return;
  if (!S.token) return openSettings("最初にアクセストークンを入力してください。");
  qEl.value = "";
  autosize();
  ask(q);
});
$("#btn-new").addEventListener("click", () => {
  if (S.busy) S.ctrl?.abort();
  S.history = [];
  for (const t of document.querySelectorAll(".turn")) t.remove();
  empty.hidden = false;
});

function setBusy(b) {
  S.busy = b;
  sendBtn.classList.toggle("stop", b);
  sendBtn.setAttribute("aria-label", b ? "中止" : "送信");
  sendBtn.replaceChildren();
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", b ? "M7 7h10v10H7z" : "M12 19V5M5 12l7-7 7 7");
  svg.append(p);
  sendBtn.append(svg);
}

// ---------------------------------------------------------------- turns
function makeTurn(question) {
  const root = el("article", "turn");
  const q = el("div", "q");
  q.append(el("small", null, "質問"), document.createTextNode(question));
  const a = el("div", "a");
  const status = el("div", "status");
  status.setAttribute("role", "status");
  status.append(el("span", "dot"), el("span", "txt", "送信しています…"));
  const notices = el("div", "notices");
  const body = el("div", "body");
  const refs = el("div", "refs");
  const hits = el("details", "hits");
  hits.hidden = true;
  const foot = el("div", "foot");
  a.append(status, body, notices, refs, hits, foot);
  root.append(q, a);
  const turn = { root, status, statusTxt: status.querySelector(".txt"), notices, body, refs, hits, foot, raw: "", sources: new Map(), cites: new Map(), question, queued: false, last: 0 };
  root.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-cite]");
    if (btn) openCite(turn.cites.get(btn.dataset.cite));
    const hit = e.target.closest("[data-hit]");
    if (hit) openSource(turn.sources.get(hit.dataset.hit));
  });
  return turn;
}

function renderStreaming(turn) {
  if (turn.queued) return;
  turn.queued = true;
  const wait = Math.max(0, 90 - (performance.now() - turn.last));
  setTimeout(() => {
    turn.queued = false;
    if (turn.done) return; // the final (citation-annotated) render must never be overwritten by a late streaming tick
    turn.last = performance.now();
    turn.body.replaceChildren(renderMarkdown(turn.raw));
  }, wait);
}

function citeKey(c) {
  return c.kind === "web" ? `w:${c.url}` : `b:${c.parent_id}|${c.page ?? ""}`;
}

function registerCite(turn, c) {
  const k = citeKey(c);
  let e = turn.cites.get(k);
  if (!e) {
    e = { key: k, n: turn.cites.size + 1, kind: c.kind, title: c.title, page: c.page ?? null, parent_id: c.parent_id, book_id: c.book_id, flags: c.flags ?? [], url: c.url, excerpts: [] };
    turn.cites.set(k, e);
  }
  const t = (c.cited_text || "").trim();
  if (t && !e.excerpts.includes(t)) e.excerpts.push(t);
  return k;
}

function chipNode(turn, keys) {
  const wrap = el("span", "cites");
  for (const k of keys) {
    const e = turn.cites.get(k);
    const b = el("button", "cite" + (e.kind === "web" ? " web" : ""), `[${e.n}]`);
    b.type = "button";
    b.dataset.cite = k;
    b.setAttribute("aria-label", `根拠${e.n}: ${e.title}${e.page ? ` ${e.page}` : ""}`);
    wrap.append(b);
  }
  return wrap;
}

function notice(turn, text, kind = "") {
  const n = el("div", "notice" + (kind ? " " + kind : ""), text);
  turn.notices.append(n);
  return n;
}

function badges(flags) {
  const frag = document.createDocumentFragment();
  for (const f of flags || []) frag.append(el("span", "badge", f));
  return frag;
}

function finish(turn, ev) {
  turn.done = true;
  turn.status.hidden = true;
  const groups = [];
  let md = "";
  let plain = "";
  for (const b of ev.blocks) {
    const keys = [];
    for (const c of b.citations || []) {
      const k = registerCite(turn, c);
      if (!keys.includes(k)) keys.push(k);
    }
    plain += b.text;
    if (keys.length) {
      groups.push(keys);
      md += b.text.replace(/(\s*)$/, `${CITE_OPEN}${groups.length - 1}${CITE_CLOSE}$1`);
    } else md += b.text;
  }
  if (!ev.blocks.length) {
    md = plain = turn.raw;
  }
  turn.answer = plain || turn.raw;
  turn.body.replaceChildren(renderMarkdown(md, { onCite: (i) => (groups[i] ? chipNode(turn, groups[i]) : null) }));

  const cites = [...turn.cites.values()];
  const bookCites = cites.filter((c) => c.kind === "book");
  if (ev.searched_books === false) notice(turn, "書籍の検索が行われないまま回答が作成されました。手元の書籍に基づく回答ではありません。もう一度質問し直すか、書籍名を指定してください。", "err");
  if (ev.stop_reason === "max_tokens") notice(turn, "出力の上限に達したため、回答が途中で終わっている可能性があります。「続きを」と送るか、質問を絞ってください。");
  if (!bookCites.length) notice(turn, "この回答には書籍からの引用がありません。書籍に記載が見つからなかったか、一般知識に基づく部分です。内容は必ず原典で確認してください。");
  if (bookCites.some((c) => c.flags.includes("数値注意"))) notice(turn, "引用元に用量・閾値などの数値が含まれる可能性があります。投与前に原本の頁で必ず確認してください。");
  if (bookCites.some((c) => c.flags.includes("転写者補助含む"))) notice(turn, "引用元の節には、転写者による図の補助説明が含まれます。図の構造説明は原本の記述ではありません。");
  if (bookCites.some((c) => c.flags.includes("照合未完"))) notice(turn, "引用元の章は、転写の二重照合が未完了です。");

  if (cites.length) {
    turn.refs.append(el("h3", null, "根拠"));
    for (const c of cites) {
      const b = el("button", "ref-btn");
      b.type = "button";
      b.dataset.cite = c.key;
      b.append(el("span", "ref-n" + (c.kind === "web" ? " web" : ""), String(c.n)));
      const t = el("span", "ref-t");
      t.append(document.createTextNode(cleanTitle(c.title)));
      if (c.kind === "book") {
        const s = el("small");
        if (c.page) s.append(document.createTextNode(`引用箇所 ${c.page}　`));
        s.append(badges(c.flags));
        t.append(s);
      } else if (c.kind === "web") t.append(el("small", null, hostOf(c.url)));
      b.append(t);
      turn.refs.append(b);
    }
  }

  const used = new Set(bookCites.map((c) => c.parent_id));
  if (turn.sources.size) {
    turn.hits.hidden = false;
    turn.hits.append(el("summary", null, `検索でヒットした節（${turn.sources.size}）`));
    for (const s of turn.sources.values()) {
      const b = el("button", "hit" + (used.has(s.parent_id) ? " used" : ""), `${used.has(s.parent_id) ? "引用 · " : ""}${cleanTitle(s.title)}`);
      b.type = "button";
      b.dataset.hit = s.source;
      turn.hits.append(b);
    }
  }

  const copy = el("button", null, "回答をコピー");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    const text = stripCiteMarks(turn.answer);
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = "コピーしました";
    } catch {
      const ta = el("textarea");
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand?.("copy");
      ta.remove();
      copy.textContent = "コピーしました";
    }
    setTimeout(() => (copy.textContent = "回答をコピー"), 1800);
  });
  turn.foot.append(copy, el("span", null, usageText(ev)));
  S.history.push({ q: turn.question, a: turn.answer });
}

/** Titles sent to the model end with ［flag］ tags; the UI shows them as badges instead. */
function cleanTitle(t) {
  return String(t ?? "").replace(/(\s*［[^］]*］)+\s*$/, "");
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function usageText(ev) {
  const u = ev.usage;
  const p = PRICES[S.model] ?? PRICES["claude-sonnet-5-5"];
  const usd = (u.input_tokens * p.in + u.cache_creation_input_tokens * p.in * CACHE_WRITE + u.cache_read_input_tokens * p.in * CACHE_READ + u.output_tokens * p.out) / 1e6 + u.web_search_requests * WEB_SEARCH_USD;
  const yen = Math.round(usd * 150 * 10) / 10;
  return `書籍検索${u.book_searches}回${u.web_search_requests ? `・Web検索${u.web_search_requests}回` : ""}・入力${u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens}tok・出力${u.output_tokens}tok・概算 $${usd.toFixed(3)}（約${yen}円）`;
}

async function ask(question) {
  empty.hidden = true;
  const turn = makeTurn(question);
  $("#thread").append(turn.root);
  turn.root.scrollIntoView({ block: "start", behavior: "smooth" });
  setBusy(true);
  S.ctrl = new AbortController();

  const history = [];
  for (const h of S.history.slice(-4)) history.push({ role: "user", text: h.q }, { role: "assistant", text: h.a.slice(0, 6000) });
  const payload = { question, history, web: S.web, ...(S.model ? { model: S.model } : {}), ...(S.bookIds.length ? { book_ids: S.bookIds } : {}) };

  let finished = false;
  try {
    const res = await api("/api/ask", { method: "POST", body: JSON.stringify(payload), signal: S.ctrl.signal });
    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    await readSse(res, (ev) => {
      switch (ev.t) {
        case "status":
          turn.statusTxt.textContent = ev.text;
          break;
        case "sources":
          for (const s of ev.items) if (!turn.sources.has(s.source)) turn.sources.set(s.source, s);
          break;
        case "reset":
          turn.raw = "";
          turn.body.replaceChildren();
          break;
        case "delta":
          turn.raw += ev.text;
          turn.statusTxt.textContent = "回答を作成しています…";
          renderStreaming(turn);
          break;
        case "final":
          finished = true;
          finish(turn, ev);
          break;
        case "error":
          finished = true;
          turn.done = true;
          turn.status.hidden = true;
          if (turn.raw) turn.body.replaceChildren(renderMarkdown(turn.raw));
          notice(turn, ev.message, "err");
          break;
      }
    });
    if (!finished) {
      turn.done = true;
      turn.status.hidden = true;
      notice(turn, "応答が途中で途切れました。通信状況を確認して、もう一度お試しください。", "err");
    }
  } catch (e) {
    turn.done = true;
    turn.status.hidden = true;
    if (turn.raw) turn.body.replaceChildren(renderMarkdown(turn.raw));
    if (e.name === "AbortError") notice(turn, "中止しました。");
    else if (e instanceof AuthError) {
      notice(turn, e.message, "err");
      openSettings(e.message, "err");
    } else notice(turn, e.message || "エラーが発生しました。", "err");
  } finally {
    setBusy(false);
    S.ctrl = null;
  }
}

// ---------------------------------------------------------------- sheet content
function pagesOf(label) {
  const m = /p\.(\d+)(?:-(\d+))?/.exec(label || "");
  if (!m) return [];
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  const out = [];
  for (let p = a; p <= Math.min(b, a + 5); p++) out.push(p);
  return out;
}

function sheetOpen(title) {
  $("#sheet-title").textContent = title;
  const body = $("#sheet-body");
  body.replaceChildren();
  openDialog(sheet);
  body.scrollTop = 0;
  return body;
}

function openCite(c) {
  if (!c) return;
  const body = sheetOpen(c.kind === "web" ? `根拠 ${c.n}（Web）` : `根拠 ${c.n}${c.page ? `　${c.page}` : ""}`);
  body.append(el("p", "src-title", cleanTitle(c.title)));
  if (c.kind === "web") {
    body.append(el("p", "sec-title", "引用された記載"));
    for (const t of c.excerpts) body.append(el("div", "excerpt", t));
    const row = el("div", "btn-row");
    if (/^https?:\/\//.test(c.url || "")) {
      const a = el("a", "btn primary link", `ページを開く（${hostOf(c.url)}）`);
      a.href = c.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      row.append(a);
    }
    body.append(row, el("p", "help", "Web上の情報です。ガイドライン原文など一次資料の該当箇所で確認してください。"));
    return;
  }
  if (c.flags.length) {
    const p = el("p");
    p.append(badges(c.flags));
    body.append(p);
  }
  body.append(el("p", "sec-title", "引用された記載"));
  for (const t of c.excerpts) body.append(el("div", "excerpt", t));
  const row = el("div", "btn-row");
  const extra = el("div");
  const bFull = el("button", "btn primary", "節の全文を見る");
  bFull.type = "button";
  bFull.addEventListener("click", () => showParent(c.parent_id, extra));
  row.append(bFull);
  for (const n of pagesOf(c.page)) {
    const b = el("button", "btn", `原本 p.${n}`);
    b.type = "button";
    b.addEventListener("click", () => showPage(c.book_id, n, extra));
    row.append(b);
  }
  body.append(row, extra);
}

function openSource(s) {
  if (!s) return;
  const body = sheetOpen(`検索でヒットした節　${s.page_label || ""}`);
  body.append(el("p", "src-title", cleanTitle(s.title)));
  if (s.flags?.length) {
    const p = el("p");
    p.append(badges(s.flags));
    body.append(p);
  }
  const extra = el("div");
  body.append(extra);
  showParent(s.parent_id, extra);
}

async function showParent(parentId, host) {
  host.replaceChildren(el("p", "help", "読み込み中…"));
  try {
    const res = await api(`/api/parent/${encodeURIComponent(parentId)}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const p = await res.json();
    host.replaceChildren();
    host.append(el("p", "sec-title", `節の全文 — ${p.book_title} / ${p.path} / ${p.page_label}`));
    for (const n of p.notes ?? []) if (n.code !== "I_CHUNK_NOTE") host.append(el("div", "notice", `[${n.code}] ${n.message}`));
    const body = el("div", "body");
    body.append(renderMarkdown(p.text, { book: true }));
    host.append(body);
    if (p.refs?.length) {
      host.append(el("p", "sec-title", "この節の文献"));
      const ul = el("ul", "body");
      for (const r of p.refs) {
        const li = el("li", null, `${r.label ? r.label + " " : ""}${r.text}`);
        if (r.pmid && /^\d+$/.test(r.pmid)) {
          const a = el("a", null, ` PMID ${r.pmid}`);
          a.href = `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          li.append(a);
        }
        ul.append(li);
      }
      host.append(ul);
    }
  } catch (e) {
    host.replaceChildren(el("div", "notice err", e.message || "読み込めませんでした。"));
  }
}

async function showPage(bookId, n, host) {
  host.replaceChildren(el("p", "help", `p.${n} を読み込み中…`));
  try {
    const res = await api(`/api/page/${encodeURIComponent(bookId)}/${n}`);
    if (!res.ok) {
      const msg = res.status === 404 ? "この頁の画像は登録されていません（R2 に pages/<book_id>/<頁>.webp を置くと表示されます）。" : `HTTP ${res.status}`;
      host.replaceChildren(el("div", "notice", msg));
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const img = el("img");
    img.src = url;
    img.dataset.blob = url;
    img.alt = `原本 p.${n}`;
    const box = el("div", "pageimg");
    box.append(img);
    const zoom = el("button", "btn", "拡大/縮小");
    zoom.type = "button";
    zoom.addEventListener("click", () => box.classList.toggle("zoom"));
    host.replaceChildren(el("p", "sec-title", `原本 p.${n}`), zoom, box);
  } catch (e) {
    host.replaceChildren(el("div", "notice err", e.message || "読み込めませんでした。"));
  }
}

// ---------------------------------------------------------------- boot
updateChips();
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
if (!S.token) openSettings("最初にアクセストークンを入力してください。");
else loadBooks().catch((e) => (e instanceof AuthError ? openSettings(e.message, "err") : null));
