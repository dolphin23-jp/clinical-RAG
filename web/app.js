import { buildAnswerMarkdown } from "./answer-marks.js";
import { initCase } from "./case.js";
import { initCreate } from "./create-ui.js";
import { initNotes } from "./note-ui.js";
import { initRecords } from "./record-ui.js";
import { CREATE_LABEL, MODES, caseForServer, caseKey, caseRows, caseSummary, caseTexts, cleanCase, cleanCreate, createRows } from "./case-model.js";
import { SCENE_LABELS, briefNeed, isScene } from "./draft-scenes.js";
import { scan as scanIdentifiers } from "./id-guard.js";
import { CITE_CLOSE, CITE_OPEN, renderMarkdown, stripCiteMarks } from "./md.js";
import { initConversations } from "./conv.js";
import { initTools } from "./tools.js";

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
  history: [], // [{q, a, ack}] plain text sent back to the model as context
  convId: null, // id of the conversation being saved to the server (set at the first saved turn)
  caseAckKey: "", // the case whose identifier-like words the doctor already confirmed in this tab (caseKey)
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
  submit(q, caseCtl.attached() ? "ask" : null, false);
});

/** A mode button over the composer: the case plus a fixed request (the label), no typed text. */
function runMode(id) {
  if (S.busy) return;
  if (!S.token) return openSettings("最初にアクセストークンを入力してください。");
  const label = MODES.find((m) => m.id === id).label;
  // the assessment/plan draft for a scene (docs/enhancement-plan.md 8.16): its headings, and the open record's summary for the scenes that follow a record
  const scene = id === "assess" ? caseCtl.scene() : "";
  if (!scene) return submit(label, id, false);
  const brief = briefNeed(scene) === "none" ? null : caseCtl.brief();
  // the choice is off without a record; this only keeps a stale choice (the record was let go meanwhile) from being sent, and says so
  if (briefNeed(scene) === "record" && !brief) return caseCtl.notice(`${SCENE_LABELS[scene]}の草案には、症例の記録が要ります。記録を開いて連動させてから、選び直してください。`);
  if (brief && !confirmRecordOf(brief)) return;
  submit(`${label}（${SCENE_LABELS[scene]}）`, id, false, { scene, brief: brief?.text ?? "", briefDay: brief?.day ?? null });
}

/**
 * Before a record's summary goes with a case: whose record it is.  An age and a sex that are the same keep the record linked when the pinned case
 * is edited, so a case edited for the next patient would take the last patient's problems along; the doctor sees the problems' names next to the
 * case and says whether they are the same patient's.  Asked once for each record and case text in this tab (a new conversation forgets it).
 */
const briefAcked = new Set();
function confirmRecordOf(brief) {
  const kase = caseCtl.pinned();
  const key = `${records.linked() ?? ""}|${kase ? caseKey(kase) : ""}`;
  if (briefAcked.has(key)) return true;
  const names = brief.names.length ? brief.names.join("、") : "（問題はまだありません）";
  const ok = confirm(`症例の記録（問題: ${names}${brief.problems > brief.names.length ? " ほか" : ""}）の要約を、いまの症例（${kase ? caseSummary(kase) : ""}）に添えて送ります。\n\nこの記録は、この症例と同じ患者のものですか？\n別の患者なら［キャンセル］し、「記録」を開いて連動を確かめてください。`);
  if (ok) briefAcked.add(key);
  return ok;
}

/** Identifier-like kinds in the question and (in case mode) in every free-text field of the case. */
function idHits(q, kase) {
  return idHitsOf([q, ...(kase ? caseTexts(kase) : [])]);
}
function idHitsOf(texts) {
  const seen = new Map();
  for (const t of texts) for (const h of scanIdentifiers(t)) if (!seen.has(h.label)) seen.set(h.label, h);
  return [...seen.values()];
}

/** mode: null for a plain question, otherwise the case mode ("ask" for a typed question, or a button's id). */
function submit(q, mode, confirmed, extra = {}) {
  if (S.busy) return;
  const kase = mode ? caseCtl.pinned() : null;
  // the record's summary is checked like the case: it is sent to the model too
  const hits = idHitsOf([q, ...(kase ? caseTexts(kase) : []), ...(extra.brief ? [extra.brief] : [])]);
  // the doctor already confirmed this case's words and the new question (and summary) have none of their own
  const known = !!kase && S.caseAckKey === caseKey(kase) && !scanIdentifiers(q).length && !(extra.brief && scanIdentifiers(extra.brief).length);
  if (hits.length && !confirmed && !known) return openGuard({ q, mode, extra }, hits);
  if (!mode || mode === "ask") {
    qEl.value = "";
    autosize();
  }
  ask(q, hits.length > 0, mode, null, extra);
}

/** A creation request ("架空症例を作る"): a theme and wishes, no case. Its free text gets the same identifier check. */
function submitCreate(params, confirmed) {
  if (S.busy) return;
  if (!S.token) return openSettings("最初にアクセストークンを入力してください。");
  const hits = idHitsOf([params.theme, params.goal]);
  if (hits.length && !confirmed) return openGuard({ create: params }, hits);
  ask(`${CREATE_LABEL}（${params.theme}）`, hits.length > 0, "create", params);
}

// ---------------------------------------------------------------- identifier check before sending (docs/clinical-use.md 2.3)
// The input is never edited or stored; the doctor either fixes it or confirms. The Worker runs the same check.
const guard = $("#guard");
let guardPending = null;
let guardSent = false;
function openGuard(pending, hits) {
  guardPending = pending;
  guardSent = false;
  $("#guard-list").replaceChildren(...hits.map((h) => el("li", null, h.label)));
  openDialog(guard);
}
$("#guard-send").addEventListener("click", () => {
  guardSent = true;
  guard.close();
  const p = guardPending;
  if (p.create) return submitCreate(p.create, true);
  const kase = p.mode ? caseCtl.pinned() : null;
  if (kase && caseTexts(kase).some((t) => scanIdentifiers(t).length)) S.caseAckKey = caseKey(kase);
  submit(p.q, p.mode, true, p.extra);
});
guard.addEventListener("close", () => {
  if (!guardSent) qEl.focus();
});
/** A new conversation is a new patient: the thread, its history and the saved-conversation id go, and so does the pinned case. */
function newConversation() {
  if (S.busy) S.ctrl?.abort();
  S.history = [];
  S.convId = null; // the conversation so far stays saved on the server; the next question starts a new one
  S.caseAckKey = "";
  briefAcked.clear();
  caseCtl.clear(); // the last case never rides along by accident
  for (const t of document.querySelectorAll(".turn")) t.remove();
  empty.hidden = false;
}
$("#btn-new").addEventListener("click", () => {
  // a pinned case that was never asked (so never saved) would be lost; one that was asked stays in its saved conversation
  if (caseCtl.pinned() && !S.convId && !confirm("固定した症例は、まだ質問されていないため保存されていません。新しい会話を始めると外れます。よろしいですか？")) return;
  newConversation();
});

function setBusy(b) {
  S.busy = b;
  sendBtn.classList.toggle("stop", b);
  sendBtn.setAttribute("aria-label", b ? "中止" : "送信");
  caseCtl.setBusy(b);
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
const DRAFT_MARK = "草案です。手元の書籍の検索に基づく参考情報で、最終判断は医師が行います。印のない・薄い文は、書籍の記述ではありません。";
const DRAFT_COPY_HEAD = "【AIの草案・参考情報（書籍の検索に基づく）。最終判断は医師】\n";
const FICTION_MARK = "架空症例です。実在の患者・症例ではありません。書籍の典型的な所見をもとに新しく作った草案で、数値は例示です（閾値・用量・書籍の症例文は書かない決まりで、あれば警告が出ます）。診断は「見立て」の節にあり、最初は畳まれています。最終判断は医師が行います。";
const FICTION_COPY_HEAD = "【架空症例（書籍を参考にAIが作成。実在の症例ではありません。数値は例示）】\n";

/** What a turn asked with a case adds to its saved payload (conv.js): the mode and the case exactly as sent. */
// (the scene of the draft is kept with it, to say which headings the answer has; the record's summary is not kept: it is sent once and shown in the turn)
const casePayload = (turn) => (turn.case ? { mode: turn.mode, case: turn.case, ...(turn.scene ? { scene: turn.scene } : {}) } : turn.create ? { mode: "create", create: turn.create } : {});

/** Case-mode drafts have fixed `##` headings: fold the answer into one section per heading (all open; tap a heading to close it). */
function foldSections(body) {
  const nodes = [...body.childNodes];
  if (!nodes.some((n) => n.nodeName === "H3")) return;
  body.replaceChildren();
  let cur = null;
  for (const n of nodes) {
    if (n.nodeName === "H3") {
      cur = el("details", "sec");
      cur.open = true;
      const sum = el("summary");
      sum.append(...n.childNodes);
      cur.append(sum);
      body.append(cur);
    } else (cur ?? body).append(n);
  }
}

function makeTurn(question, caseInfo = null) {
  const root = el("article", "turn");
  const q = el("div", "q");
  q.append(el("small", null, caseInfo?.create ? "架空症例の作成" : caseInfo ? "質問（症例つき）" : "質問"), document.createTextNode(question));
  const a = el("div", "a");
  const status = el("div", "status");
  status.setAttribute("role", "status");
  status.append(el("span", "dot"), el("span", "txt", "送信しています…"));
  const notices = el("div", "notices");
  const body = el("div", "body");
  const numbers = el("div", "numbers");
  numbers.hidden = true;
  const refs = el("div", "refs");
  const hits = el("details", "hits");
  hits.hidden = true;
  const foot = el("div", "foot");
  const saveNote = el("span", "save-note");
  if (caseInfo?.create) {
    // the request a fictional case was made from, and the reminder that it is fictional
    const box = el("details", "casebox");
    box.append(el("summary", null, "この依頼"));
    const dl = el("dl");
    for (const [k, v] of createRows(caseInfo.create)) dl.append(el("dt", null, k), el("dd", null, v));
    box.append(dl);
    a.append(box, el("p", "fictionmark", FICTION_MARK));
  } else if (caseInfo) {
    // the case this answer was written from, and the reminder that it is a draft
    const box = el("details", "casebox");
    box.append(el("summary", null, "この質問に付けた症例"));
    const dl = el("dl");
    for (const [k, v] of caseRows(caseInfo.kase)) dl.append(el("dt", null, k), el("dd", null, v));
    if (caseInfo.scene) dl.append(el("dt", null, "草案の場面"), el("dd", null, SCENE_LABELS[caseInfo.scene] ?? ""));
    box.append(dl);
    if (caseInfo.brief) {
      // what the model was sent besides the case (not saved with the conversation: it is shown here for this session only)
      const sent = el("details", "casebox");
      sent.append(el("summary", null, `送った症例の記録の要約（入院${caseInfo.briefDay ?? ""}日目の時点）`), el("pre", "scene-brief-text", caseInfo.brief));
      box.append(sent);
    }
    a.append(box, el("p", "draftmark", DRAFT_MARK));
  }
  a.append(status, body, notices, numbers, refs, hits, foot);
  root.append(q, a);
  const turn = { root, status, statusTxt: status.querySelector(".txt"), notices, numbers, saveNote, body, refs, hits, foot, raw: "", sources: new Map(), cites: new Map(), question, queued: false, last: 0, mode: caseInfo?.mode ?? null, case: caseInfo?.kase ?? null, scene: caseInfo?.scene ?? "", create: caseInfo?.create ?? null };
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
  // text no book backs is shown lighter, but only when the answer cites a book at all (otherwise the notice below says so)
  const citesBook = ev.blocks.some((b) => (b.citations || []).some((c) => c.kind === "book"));
  const built = buildAnswerMarkdown(
    ev.blocks,
    (b) => {
      const keys = [];
      for (const c of b.citations || []) {
        const k = registerCite(turn, c);
        if (!keys.includes(k)) keys.push(k);
      }
      return keys;
    },
    // a created case is new text by design: its lines have no book behind them, so nothing is shown lighter there
    { citeOpen: CITE_OPEN, citeClose: CITE_CLOSE, mark: citesBook && turn.mode !== "create" },
  );
  const { groups } = built;
  let { md, plain } = built;
  if (!ev.blocks.length) {
    md = plain = turn.raw;
  }
  turn.answer = plain || turn.raw;
  turn.body.replaceChildren(renderMarkdown(md, { onCite: (i) => (groups[i] ? chipNode(turn, groups[i]) : null) }));
  if (turn.mode && turn.mode !== "ask") foldSections(turn.body);

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

  if (citesBook && turn.mode !== "create" && /uncited/.test(turn.body.innerHTML)) notice(turn, "薄い文字は、書籍の引用が付いていない文です（推論・一般知識）。書籍の記載として読まないでください。");
  renderNumbers(turn, ev.numbers);
  renderHits(turn, new Set(bookCites.map((c) => c.parent_id)));

  const copy = el("button", null, "回答をコピー");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    await copyText((turn.case ? DRAFT_COPY_HEAD : turn.create ? FICTION_COPY_HEAD : "") + stripCiteMarks(turn.answer));
    copy.textContent = "コピーしました";
    setTimeout(() => (copy.textContent = "回答をコピー"), 1800);
  });
  turn.foot.append(copy, el("span", null, usageText(ev)), turn.saveNote);
  notes.decorate(turn); // an assessment/plan draft gets a tick on each item the doctor may adopt into a chart note
  if (turn.mode === "create") {
    // the answer with the cited pages written in (pages come from the citation metadata), for reading the created case back
    turn.annotated = ev.blocks
      .map((b) => {
        const pages = [...new Set((b.citations || []).map((c) => (c.kind === "web" ? "Web" : `書籍${c.page ? ` ${c.page}` : ""}`)))];
        return pages.length ? b.text.replace(/(\s*)$/, ` ［${pages.join("］［")}］$1`) : b.text;
      })
      .join("");
    creator.decorate(turn, ev);
  }
  S.history.push({ q: turn.question, a: turn.answer, ack: turn.ack });
  conv.saveTurn(turn, { kind: "final", blocks: ev.blocks, sources: [...turn.sources.values()], numbers: ev.numbers || [], usage: ev.usage, stop_reason: ev.stop_reason, searched_books: ev.searched_books, turns: ev.turns, ...(ev.overlap ? { overlap: ev.overlap } : {}), ...casePayload(turn) });
}

/** Puts text on the clipboard (with a fallback for a browser that refuses the async API). */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = el("textarea");
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand?.("copy");
    ta.remove();
  }
}

const NUM_STATUS = {
  not_found: "検索結果のどこにもありません",
  retrieved: "検索結果の節にありますが、引用された文の外です",
  cited: "引用された文にあります",
};

/** The machine's cross-check of every number with a unit (worker/src/numcheck.ts): a hint, never a verdict. */
function renderNumbers(turn, numbers) {
  if (!numbers?.length) return;
  turn.numbers.hidden = false;
  turn.numbers.replaceChildren(el("h3", null, "数値の突き合わせ（機械による確認。判定ではありません）"));
  const order = { not_found: 0, retrieved: 1, cited: 2 };
  const ul = el("ul");
  for (const n of [...numbers].sort((a, b) => order[a.status] - order[b.status])) {
    const li = el("li", `num ${n.status}`);
    li.append(el("strong", null, n.text), document.createTextNode(`　${n.via === "web" ? "Web の引用にあります" : NUM_STATUS[n.status]}${n.page ? `（${n.page}）` : ""}`));
    ul.append(li);
  }
  turn.numbers.append(ul);
  turn.numbers.append(el("p", "help", "一致しても、単位・対象・条件が合っているとは限りません。書籍の転写の誤りも、ここでは分かりません。用量は必ず原本の頁（または添付文書）で確認してください。"));
  if (numbers.some((n) => n.status === "not_found")) turn.numbers.classList.add("has-missing");
}

function renderHits(turn, used, open = false) {
  if (!turn.sources.size) return;
  turn.hits.hidden = false;
  turn.hits.open = open;
  turn.hits.replaceChildren(el("summary", null, `検索でヒットした節（${turn.sources.size}）`));
  for (const s of turn.sources.values()) {
    const b = el("button", "hit" + (used.has(s.parent_id) ? " used" : ""), `${used.has(s.parent_id) ? "引用 · " : ""}${cleanTitle(s.title)}`);
    b.type = "button";
    b.dataset.hit = s.source;
    turn.hits.append(b);
  }
}

/** The answer failed, but the library search did not: show what was found (and what was already written). */
function degrade(turn, ev) {
  turn.done = true;
  turn.status.hidden = true;
  notice(turn, ev.message, "err");
  if (turn.raw) {
    turn.body.replaceChildren(renderMarkdown(turn.raw));
    notice(turn, "回答は途中で止まりました。ここまでの文には書籍の引用が付いていません。下の節で確かめてください。");
  }
  notice(turn, "回答の生成に失敗したため、書籍の検索で見つかった節を示します（モデルの回答ではありません）。");
  for (const s of ev.items) if (!turn.sources.has(s.source)) turn.sources.set(s.source, s);
  renderHits(turn, new Set(), true);
  turn.foot.append(turn.saveNote);
  if (turn.raw) S.history.push({ q: turn.question, a: turn.raw, ack: turn.ack });
  conv.saveTurn(turn, { kind: "degraded", message: ev.message, items: ev.items, raw: turn.raw, ...casePayload(turn) });
}

/** Rebuilds a saved conversation on screen (docs/clinical-use.md 1d); its turns are not saved again. */
function openConversation(data) {
  if (S.busy) S.ctrl?.abort();
  S.history = [];
  for (const t of document.querySelectorAll(".turn")) t.remove();
  S.convId = data.id;
  S.caseAckKey = "";
  empty.hidden = true;
  let lastCase = null;
  for (const t of data.turns) {
    const p = t.payload || {};
    const info = p.case ? { mode: typeof p.mode === "string" ? p.mode : "ask", kase: cleanCase(p.case), scene: isScene(p.scene) && p.mode === "assess" ? p.scene : "" } : p.create ? { mode: "create", create: cleanCreate(p.create) } : null;
    if (info?.kase) lastCase = info.kase;
    const turn = makeTurn(t.question, info);
    turn.restored = true;
    turn.ack = false;
    $("#thread").append(turn.root);
    for (const s of p.sources || []) if (!turn.sources.has(s.source)) turn.sources.set(s.source, s);
    if (p.kind === "degraded") {
      turn.raw = p.raw || "";
      degrade(turn, { message: p.message || "", items: p.items || [] });
    } else {
      finish(turn, { blocks: p.blocks || [{ text: t.answer, citations: [] }], usage: p.usage || zeroUsage(), numbers: p.numbers || [], stop_reason: p.stop_reason, searched_books: p.searched_books !== false, overlap: p.overlap });
    }
    turn.saveNote.textContent = "保存済み";
  }
  if (lastCase) caseCtl.set(lastCase); // the case the conversation was last asked with is pinned again
  else caseCtl.clear();
  const last = $("#thread").lastElementChild;
  if (last) last.scrollIntoView({ block: "end" });
}

const zeroUsage = () => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, web_search_requests: 0, book_searches: 0 });

function scrollToTurn(t) {
  t.scrollIntoView({ block: "start", behavior: "smooth" });
  t.classList.add("flash");
  setTimeout(() => t.classList.remove("flash"), 1600);
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

async function ask(question, ack = false, mode = null, create = null, extra = {}) {
  empty.hidden = true;
  const kase = mode && mode !== "create" ? caseCtl.pinned() : null;
  const scene = kase && mode === "assess" && isScene(extra.scene) ? extra.scene : "";
  const turn = makeTurn(question, kase ? { mode, kase, scene, brief: scene ? extra.brief : "", briefDay: extra.briefDay } : create ? { mode: "create", create } : null);
  turn.ack = ack;
  $("#thread").append(turn.root);
  turn.root.scrollIntoView({ block: "start", behavior: "smooth" });
  setBusy(true);
  S.ctrl = new AbortController();

  const history = [];
  const recent = S.history.slice(-4);
  for (const h of recent) history.push({ role: "user", text: h.q }, { role: "assistant", text: h.a.slice(0, 6000) });
  // an earlier question the doctor confirmed is re-sent as history, so the confirmation travels with it
  const acked = ack || recent.some((h) => h.ack);
  const payload = { question, history, ...(kase ? { mode, case: caseForServer(kase), ...(scene ? { scene, ...(extra.brief ? { record_brief: extra.brief } : {}) } : {}) } : create ? { mode: "create", create } : {}), web: S.web, ...(S.model ? { model: S.model } : {}), ...(S.bookIds.length ? { book_ids: S.bookIds } : {}), ...(acked ? { ack_identifier: true } : {}) };

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
        case "degraded":
          finished = true;
          degrade(turn, ev);
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
initTools({ api, el, $, openDialog, sheetOpen, showParent, showPage, pagesOf, books: () => S.books });
const conv = initConversations({ api, el, $, openDialog, S, openConversation, scrollToTurn });
const caseCtl = initCase({ el, $, openDialog, runMode, api });
const records = initRecords({ api, el, $, openDialog, copyText, caseCtl, hasThread: () => !!document.querySelector(".turn"), newConversation });
caseCtl.onPinned((k) => records.onCasePinned(k));
// the scene choices and the summary of the open record that the draft of a scene takes (docs/enhancement-plan.md 8.16)
caseCtl.setRecord({ linked: (k) => records.hasRecordFor(k), brief: (scene, k) => records.brief(scene, k) });
records.onChange(() => caseCtl.refreshScene());
caseCtl.onCleared(() => records.onCaseCleared());
const notes = initNotes({ el, $, openDialog, copyText, toRecord: (kase, items) => records.addAdopted(kase, items) });
const creator = initCreate({ el, $, openDialog, copyText, runCreate: (params) => submitCreate(params, false), pinCase: (c) => caseCtl.set(c) });
$("#case-create").addEventListener("click", () => {
  $("#case").close();
  creator.open();
});
$("#casebar-note").addEventListener("click", () => notes.open({ kase: caseCtl.pinned(), label: "固定中の症例だけ", items: () => [] }));
updateChips();
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
if (!S.token) openSettings("最初にアクセストークンを入力してください。");
else loadBooks().catch((e) => (e instanceof AuthError ? openSettings(e.message, "err") : null));
