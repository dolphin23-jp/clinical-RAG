// "測定・評価" screen: the numeric transcription-error worksheet (T1-7) and the evaluation set (T1-8), so both can be
// done on an iPad (docs/evaluation.md 5).  Storage, as the doctor decided (2026-10-24, docs/clinical-use.md 1c):
//   - worksheet judgments: this device only (localStorage, key mb.numeric.v1); nothing is sent back
//   - evaluation questions: the server (D1, /api/eval/questions), checked like the PC tools before they are written
//   - evaluation results (ranks, answers): this tab's memory only
// All text from books and from the doctor is put on screen with textContent.
import { listFrom, pagesFrom, parsePageLabel, retrievalMetrics, scoreAsk, summarizeNumeric, wilson } from "./eval-tools.js";

const NUM_KEY = "mb.numeric.v1";
const KINDS = ["桁", "小数点", "単位", "範囲", "記号", "その他"];
const FLAG_LABEL = { dose_unit: "用量", lab_threshold: "閾値" };
const GROUPS = ["keyword", "paraphrase", "abbreviation", "ja-en", "concept", "numeric", "figure-table", "cross-book", "negative"];

export function initTools(ctx) {
  const { api, el, $, openDialog, sheetOpen, showParent, showPage, pagesOf, books } = ctx;
  const dlg = $("#tools");
  const paneNum = $("#pane-num");
  const paneEval = $("#pane-eval");

  // ------------------------------------------------------------ tabs
  for (const tab of dlg.querySelectorAll("[role=tab]")) {
    tab.addEventListener("click", () => {
      for (const t of dlg.querySelectorAll("[role=tab]")) t.setAttribute("aria-selected", String(t === tab));
      paneNum.hidden = tab.id !== "tab-num";
      paneEval.hidden = tab.id !== "tab-eval";
      if (!paneEval.hidden) loadQuestions();
    });
  }
  $("#btn-tools").addEventListener("click", () => {
    renderNum();
    openDialog(dlg);
  });

  const msg = (host, text, kind = "") => {
    const p = el("div", "notice" + (kind ? " " + kind : ""), text);
    host.prepend(p);
    return p;
  };
  const btn = (label, cls = "btn") => {
    const b = el("button", cls, label);
    b.type = "button";
    return b;
  };
  const pct = (k, n) => (n ? `${((100 * k) / n).toFixed(1)}%` : "-");
  const ci = (k, n) => {
    if (!n) return "";
    const [lo, hi] = wilson(k, n);
    return `（95%CI ${(100 * lo).toFixed(1)}–${(100 * hi).toFixed(1)}%）`;
  };

  // ------------------------------------------------------------ numeric worksheet (device storage)
  let sheetState = null;
  let onlyOpen = false;
  let storageOk = true;
  const load = () => {
    try {
      const raw = localStorage.getItem(NUM_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };
  const save = () => {
    try {
      if (sheetState) localStorage.setItem(NUM_KEY, JSON.stringify(sheetState));
      else localStorage.removeItem(NUM_KEY);
      storageOk = true;
    } catch {
      storageOk = false;
    }
  };

  function renderNum() {
    sheetState = sheetState || load();
    paneNum.replaceChildren();
    if (!storageOk) msg(paneNum, "この端末に保存できません。記入は、この画面を閉じると消えます。", "err");
    if (!sheetState) return renderNumStart();
    const { rows, judged } = sheetState;
    const head = el("div", "tools-head");
    const progress = el("p", "help num-progress");
    head.append(progress);
    const row = el("div", "btn-row");
    const bOpen = btn(onlyOpen ? "すべて表示" : "未記入だけ");
    bOpen.addEventListener("click", () => {
      onlyOpen = !onlyOpen;
      renderNum();
    });
    const bReport = btn("集計", "btn primary");
    bReport.id = "num-report";
    bReport.addEventListener("click", () => renderReport());
    const bClear = btn("作業表を消す");
    bClear.addEventListener("click", () => {
      if (!confirm("作業表と記入を、この端末から消しますか？")) return;
      sheetState = null;
      save();
      renderNum();
    });
    row.append(bOpen, bReport, bClear);
    head.append(row);
    paneNum.append(head);
    updateProgress();
    const list = el("div", "nrows");
    for (const r of rows) if (!onlyOpen || !judged[r.no]?.verdict) list.append(numRow(r));
    paneNum.append(list);
  }

  function updateProgress() {
    const p = paneNum.querySelector(".num-progress");
    if (!p || !sheetState) return;
    const done = sheetState.rows.filter((r) => sheetState.judged[r.no]?.verdict).length;
    p.textContent = `記入 ${done}/${sheetState.rows.length}（この iPad の中にだけ保存。${sheetState.created.slice(0, 10)} に作成、seed ${sheetState.params.seed}）`;
  }

  function renderNumStart() {
    paneNum.append(
      el("p", null, "本番の索引から、数値つきの節を書籍ごとに均等に抜き、1行ずつ原本と見比べて記入します。記入はこの iPad の中にだけ保存します。"),
    );
    const f = el("div", "tools-form");
    const field = (label, id, value) => {
      const l = el("label", "field", label);
      l.htmlFor = id;
      const i = el("input");
      i.type = "number";
      i.id = id;
      i.value = String(value);
      i.inputMode = "numeric";
      f.append(l, i);
      return i;
    };
    const iChunks = field("抜く節の数", "num-chunks", 40);
    const iPer = field("1節あたりの行の上限", "num-per", 3);
    const iSeed = field("seed（同じ値なら同じ標本）", "num-seed", 1);
    const b = btn("作業表を作る", "btn primary");
    b.id = "num-create";
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        const q = new URLSearchParams({ chunks: iChunks.value, per_chunk: iPer.value, seed: iSeed.value });
        const res = await api(`/api/numeric/sample?${q}`);
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        const j = await res.json();
        if (!j.rows.length) throw new Error("数値つきの節が見つかりませんでした。");
        sheetState = { created: new Date().toISOString(), params: { chunks: +iChunks.value, per_chunk: +iPer.value, seed: +iSeed.value }, rows: j.rows, judged: {} };
        save();
        renderNum();
      } catch (e) {
        b.disabled = false;
        msg(paneNum, e.message || "作れませんでした。", "err");
      }
    });
    f.append(el("div", "btn-row"));
    f.lastChild.append(b);
    paneNum.append(f);
  }

  function numRow(r) {
    const j = (sheetState.judged[r.no] = sheetState.judged[r.no] || {});
    const card = el("article", "nrow");
    card.dataset.no = r.no;
    card.append(el("p", "nrow-head", `${r.no} · ${r.book_title || r.book_id} · ${r.page_label} · ${FLAG_LABEL[r.flag] || r.flag}`));
    const ctxP = el("p", "ctx");
    const m = /^(.*)【(.*)】(.*)$/s.exec(r.context);
    if (m) ctxP.append(document.createTextNode(m[1]), el("mark", null, m[2]), document.createTextNode(m[3]));
    else ctxP.textContent = r.context;
    card.append(ctxP);

    const seg = el("div", "seg");
    for (const [v, label] of [["ok", "一致"], ["err", "誤り"], ["skip", "判定不能"]]) {
      const b = btn(label, "btn seg-btn");
      b.dataset.verdict = v;
      b.setAttribute("aria-pressed", String(j.verdict === v));
      b.addEventListener("click", () => {
        j.verdict = j.verdict === v ? undefined : v;
        if (j.verdict !== "err") {
          delete j.kind;
          delete j.correct;
        }
        save();
        card.replaceWith(numRow(r));
        updateProgress();
      });
      seg.append(b);
    }
    card.append(seg);

    if (j.verdict === "err") {
      const extra = el("div", "tools-form");
      const sel = el("select");
      sel.setAttribute("aria-label", "誤りの種類");
      sel.append(el("option", null, "誤りの種類"));
      sel.firstChild.value = "";
      for (const k of KINDS) {
        const o = el("option", null, k);
        o.value = k;
        o.selected = j.kind === k;
        sel.append(o);
      }
      sel.addEventListener("change", () => {
        j.kind = sel.value || undefined;
        save();
      });
      const inp = el("input");
      inp.type = "text";
      inp.placeholder = "原本の正しい表記";
      inp.value = j.correct || "";
      inp.addEventListener("change", () => {
        j.correct = inp.value.trim() || undefined;
        save();
      });
      extra.append(sel, inp);
      card.append(extra);
    }
    const shift = el("label", "check");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = !!j.shift;
    cb.addEventListener("change", () => {
      j.shift = cb.checked;
      save();
    });
    shift.append(cb, el("span", null, "この頁に数値がなかった（頁ずれ）"));
    card.append(shift);

    const links = el("div", "btn-row");
    for (const n of pagesOf(r.page_label)) {
      const b = btn(`原本 p.${n}`);
      b.addEventListener("click", () => {
        const host = sheetOpen(`${r.no}　原本 p.${n}`);
        const box = el("div");
        host.append(el("p", "excerpt", r.context), box);
        showPage(r.book_id, n, box);
      });
      links.append(b);
    }
    if (r.parent_id) {
      const b = btn("節の全文");
      b.addEventListener("click", () => {
        const host = sheetOpen(`${r.no}　節の全文`);
        const box = el("div");
        host.append(box);
        showParent(r.parent_id, box);
      });
      links.append(b);
    }
    card.append(links);
    return card;
  }

  function renderReport() {
    const s = summarizeNumeric(sheetState.rows, sheetState.judged);
    const host = sheetOpen("数値の照合の集計");
    const line = (label, k, n) => el("p", null, n ? `${label}: 誤り ${k}/${n} = ${pct(k, n)} ${ci(k, n)}` : `${label}: 判定 0 件`);
    host.append(
      el("p", "help", `行 ${s.rows}・一致 ${s.ok}・誤り ${s.err}・判定不能 ${s.skip}・未記入 ${s.unjudged}`),
      line("全体（数値単位）", s.err, s.ok + s.err),
      line("全体（チャンク単位）", s.chunks[0], s.chunks[1]),
      el("p", "sec-title", "書籍別"),
    );
    const title = Object.fromEntries(sheetState.rows.map((r) => [r.book_id, r.book_title || r.book_id]));
    for (const [b, [k, n]] of Object.entries(s.by_book).sort()) host.append(line(title[b], k, n));
    host.append(el("p", "sec-title", "旗別（用量の単位／検査値の閾値）"));
    for (const [f, [k, n]] of Object.entries(s.by_flag).sort()) host.append(line(FLAG_LABEL[f] || f, k, n));
    const kinds = Object.entries(s.kinds).sort((a, b) => b[1] - a[1]);
    if (kinds.length) host.append(el("p", null, "誤りの種類: " + kinds.map(([k, v]) => `${k} ${v}`).join("、")));
    if (s.page_shift[1]) host.append(el("p", null, `頁ずれ（数値がその頁になかった）: ${s.page_shift[0]}/${s.page_shift[1]}`));
    host.append(
      el("p", "help", "標本は書籍ごとに均等に割り付けたもので、全体の率は書籍の大きさで重み付けしていない。0 件でも誤りがないとは言えない（区間の上限を見る）。どの率なら頁画像の照合（B3）に進むかは、先生が決める。"),
    );
  }

  // ------------------------------------------------------------ evaluation set (server storage)
  let questions = [];
  let editing = null;
  const parse = (line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  };

  async function loadQuestions() {
    try {
      const res = await api("/api/eval/questions");
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      questions = (await res.json()).questions.map((r) => ({ ...r, q: parse(r.line) })).filter((r) => r.q);
      renderEval();
    } catch (e) {
      paneEval.replaceChildren(el("div", "notice err", e.message || "読み込めませんでした。"));
    }
  }

  function renderEval(note) {
    paneEval.replaceChildren();
    if (note) paneEval.append(el("div", "notice" + (note.err ? " err" : ""), note.text));
    paneEval.append(el("p", "help", `保存済み ${questions.length} 問（サーバーに保存。識別情報らしき文字がある問いは保存しない）`));
    const row = el("div", "btn-row");
    const bAdd = btn("問いを追加", "btn primary");
    bAdd.id = "eval-add";
    bAdd.addEventListener("click", () => openForm(null));
    const bImport = btn("まとめて取り込む");
    bImport.addEventListener("click", () => openImport());
    const bCopy = btn("JSONL をコピー");
    bCopy.addEventListener("click", async () => {
      try {
        const res = await api("/api/eval/questions?format=jsonl");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await navigator.clipboard.writeText(await res.text());
        bCopy.textContent = "コピーしました";
      } catch {
        bCopy.textContent = "コピーできませんでした";
      }
      setTimeout(() => (bCopy.textContent = "JSONL をコピー"), 1800);
    });
    row.append(bAdd, bImport, bCopy);
    paneEval.append(row);

    const runs = el("div", "btn-row");
    const bRet = btn("検索を評価（無料）", "btn primary");
    bRet.id = "eval-run-retrieval";
    bRet.disabled = !questions.length;
    bRet.addEventListener("click", () => runRetrieval());
    const nAsk = el("input");
    nAsk.type = "number";
    nAsk.id = "eval-ask-n";
    nAsk.value = String(Math.min(5, questions.length || 5));
    nAsk.setAttribute("aria-label", "回答を評価する問いの数");
    nAsk.className = "n-input";
    const bAsk = btn("回答を評価（費用あり）");
    bAsk.id = "eval-run-ask";
    bAsk.disabled = !questions.length;
    bAsk.addEventListener("click", () => runAsk(Math.max(1, Number(nAsk.value) || 1)));
    runs.append(bRet, el("span", "help", "最初の"), nAsk, el("span", "help", "問"), bAsk);
    paneEval.append(runs);

    const list = el("div", "qrows");
    for (const r of questions) {
      const card = el("article", "qrow");
      card.dataset.id = r.id;
      const q = r.q;
      const head = el("p", "nrow-head", `${r.id} · ${q.group || "all"}${q.severity === "high" ? " · 重要" : ""}${q.negative ? " · 書籍にない問い" : ""}`);
      card.append(head, el("p", null, q.question || (q.queries || []).join(" / ")));
      const gold = [q.expect?.book_id, q.expect?.pages?.length ? `p.${q.expect.pages.join(",")}` : "", (q.expect?.text_contains || []).join("・")].filter(Boolean).join(" ");
      if (gold) card.append(el("p", "help", `正解: ${gold}`));
      const b = el("div", "btn-row");
      const bE = btn("編集");
      bE.addEventListener("click", () => openForm(r));
      const bD = btn("削除");
      bD.addEventListener("click", async () => {
        if (!confirm(`${r.id} を削除しますか？`)) return;
        try {
          const res = await api(`/api/eval/questions/${encodeURIComponent(r.id)}`, { method: "DELETE" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          loadQuestions();
        } catch (e) {
          renderEval({ err: true, text: e.message || "削除できませんでした。" });
        }
      });
      b.append(bE, bD);
      card.append(b);
      list.append(card);
    }
    paneEval.append(list);
    // retrieval and answer results side by side, so one run does not wipe the other
    const results = el("div", "eval-results");
    results.append(el("div", "ret-results"), el("div", "ask-results"));
    paneEval.append(results);
  }

  function openForm(r) {
    editing = r;
    const q = r?.q || {};
    const host = sheetOpen(r ? `問いを編集　${r.id}` : "問いを追加");
    const f = el("div", "tools-form");
    f.id = "eval-form";
    const add = (label, node) => {
      const l = el("label", "field", label);
      if (node.id) l.htmlFor = node.id;
      f.append(l, node);
      return node;
    };
    const text = (id, value = "", ph = "") => {
      const i = el("input");
      i.type = "text";
      i.id = id;
      i.value = value;
      i.placeholder = ph;
      return i;
    };
    const area = (id, value = "", ph = "") => {
      const t = el("textarea");
      t.id = id;
      t.value = value;
      t.placeholder = ph;
      t.rows = 2;
      return t;
    };
    const nextId = `q${String(questions.length + 1).padStart(3, "0")}`;
    const iId = add("ID（英数字）", text("ef-id", r?.id || nextId));
    iId.readOnly = !!r;
    const iGroup = add("組", text("ef-group", q.group || "", "keyword / concept / numeric など"));
    const dl = el("datalist");
    dl.id = "ef-groups";
    for (const g of GROUPS) dl.append(Object.assign(el("option"), { value: g }));
    iGroup.setAttribute("list", "ef-groups");
    f.append(dl);
    const sev = el("select");
    sev.id = "ef-sev";
    for (const [v, l] of [["normal", "ふつう"], ["high", "重要（外すと判断が変わりうる）"]]) {
      const o = el("option", null, l);
      o.value = v;
      o.selected = (q.severity || "normal") === v;
      sev.append(o);
    }
    add("重要度", sev);
    const iQ = add("質問（ふだん打つ形の文。年齢・所見・検査値まで。氏名・ID は書かない）", area("ef-question", q.question || ""));
    const iQs = add("検索の語（1行に1つ。短いキーワード）", area("ef-queries", (q.queries || []).join("\n")));
    const neg = el("label", "check");
    const cbNeg = el("input");
    cbNeg.type = "checkbox";
    cbNeg.id = "ef-negative";
    cbNeg.checked = !!q.negative;
    neg.append(cbNeg, el("span", null, "手元の書籍にない問い（「見つからなかった」と言えるかを見る）"));
    f.append(neg);
    const sel = el("select");
    sel.id = "ef-book";
    sel.append(Object.assign(el("option", null, "（本を指定しない）"), { value: "" }));
    for (const b of books()) {
      const o = el("option", null, b.title);
      o.value = b.book_id;
      o.selected = q.expect?.book_id === b.book_id;
      sel.append(o);
    }
    add("正解の本", sel);
    const iPages = add("正解の頁（印刷頁。複数は読点で）", text("ef-pages", (q.expect?.pages || []).join(", ")));
    const iContains = add("正解の節に必ずある語（読点で区切る。省略可）", text("ef-contains", (q.expect?.text_contains || []).join("、")));
    const iMust = add("回答に出てほしい語（読点で区切る。省略可）", text("ef-must", (q.must_mention || []).join("、")));
    const iNote = add("メモ", text("ef-note", q.note || ""));

    // find the gold page with the plain search (no LLM)
    const finder = el("div", "finder");
    const iFind = text("ef-find", "", "頁を探す語");
    const bFind = btn("頁を探す");
    bFind.id = "ef-find-btn";
    const found = el("div");
    bFind.addEventListener("click", async () => {
      found.replaceChildren(el("p", "help", "検索しています…"));
      try {
        const res = await api("/api/search", { method: "POST", body: JSON.stringify({ queries: [iFind.value || iQs.value.split("\n")[0] || iQ.value], parents: 8, max_per_book: 8 }) });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        const j = await res.json();
        found.replaceChildren();
        if (!j.results.length) found.append(el("p", "help", "見つかりませんでした。"));
        for (const h of j.results) {
          const b = btn(`${h.page_label}　${h.book_title} ${h.path}`, "hit");
          b.addEventListener("click", () => {
            sel.value = h.book_id;
            const p = parsePageLabel(h.page_label).page_start;
            if (p !== null) iPages.value = [...new Set([...pagesFrom(iPages.value), p])].join(", ");
          });
          found.append(b);
        }
      } catch (e) {
        found.replaceChildren(el("div", "notice err", e.message || "検索できませんでした。"));
      }
    });
    finder.append(iFind, bFind);
    f.append(el("p", "sec-title", "正解の頁を探す（検索だけ。押すと本と頁が入る）"), finder, found);

    const err = el("div");
    const bSave = btn("保存", "btn primary");
    bSave.id = "ef-save";
    bSave.addEventListener("click", async () => {
      // one search query per line (a query may hold several space-separated keywords)
      const obj = { id: iId.value.trim(), group: iGroup.value.trim() || undefined, severity: sev.value, queries: iQs.value.split("\n").map((t) => t.trim()).filter(Boolean) };
      if (iQ.value.trim()) obj.question = iQ.value.trim();
      if (!obj.queries.length && obj.question) obj.queries = [obj.question.slice(0, 200)];
      if (cbNeg.checked) obj.negative = true;
      const expect = {};
      if (sel.value) expect.book_id = sel.value;
      const pages = pagesFrom(iPages.value);
      if (pages.length) expect.pages = pages;
      const contains = listFrom(iContains.value);
      if (contains.length) expect.text_contains = contains;
      obj.expect = expect;
      const must = listFrom(iMust.value);
      if (must.length) obj.must_mention = must;
      if (iNote.value.trim()) obj.note = iNote.value.trim();
      const res = await api(`/api/eval/questions/${encodeURIComponent(obj.id)}`, { method: "PUT", body: JSON.stringify({ line: JSON.stringify(obj) }) });
      if (!res.ok) {
        err.replaceChildren(el("div", "notice err", (await res.json().catch(() => ({}))).error || `HTTP ${res.status}`));
        return;
      }
      $("#sheet").close();
      loadQuestions();
    });
    f.append(err, el("div", "btn-row"));
    f.lastChild.append(bSave);
    host.append(f);
  }

  function openImport() {
    const host = sheetOpen("まとめて取り込む");
    host.append(el("p", "help", "eval/clinical.template.jsonl と同じ形で、1行に1問。同じ ID は上書き。1行でも問題があれば、何も取り込まない。"));
    const t = el("textarea");
    t.rows = 8;
    t.className = "wide";
    const out = el("div");
    const b = btn("取り込む", "btn primary");
    b.addEventListener("click", async () => {
      const res = await api("/api/eval/import", { method: "POST", body: JSON.stringify({ text: t.value }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return out.replaceChildren(el("div", "notice err", j.error || `HTTP ${res.status}`));
      out.replaceChildren(el("div", "notice", `${j.imported} 問を取り込みました。`));
      loadQuestions();
    });
    const row = el("div", "btn-row");
    row.append(b);
    host.append(t, row, out);
  }

  // retrieval: one request per question (keeps each Worker call small); results stay in this tab
  async function runRetrieval() {
    const box = paneEval.querySelector(".ret-results");
    box.replaceChildren(el("p", "help", "評価しています…"));
    const results = [];
    for (const [i, r] of questions.entries()) {
      box.firstChild.textContent = `評価しています… ${i + 1}/${questions.length}`;
      const res = await api("/api/eval/retrieval", { method: "POST", body: JSON.stringify({ id: r.id }) });
      if (!res.ok) {
        box.append(el("div", "notice err", `${r.id}: ${(await res.json().catch(() => ({}))).error || res.status}`));
        continue;
      }
      results.push(await res.json());
    }
    box.replaceChildren(el("p", "sec-title", "検索の評価（辞書あり / なし）"));
    const on = retrievalMetrics(results, "on");
    const off = retrievalMetrics(results, "off");
    const table = el("table", "report");
    const tr = (cells, th = false) => {
      const row = el("tr");
      for (const c of cells) row.append(el(th ? "th" : "td", null, c));
      return row;
    };
    table.append(tr(["組", "n", "hit@1", "hit@3", "hit@5", "MRR"], true));
    const keys = Object.keys(on).sort((a, b) => (a === "ALL" ? 1 : b === "ALL" ? -1 : a.localeCompare(b)));
    const f = (s, k) => (s ? `${Math.round((100 * s[k]) / s.n)}%` : "-");
    for (const k of keys) {
      const a = on[k];
      const b = off[k];
      table.append(tr([k, String(a.n), `${f(a, "h1")} / ${f(b, "h1")}`, `${f(a, "h3")} / ${f(b, "h3")}`, `${f(a, "hN")} / ${f(b, "hN")}`, `${(a.rr / a.n).toFixed(2)} / ${b ? (b.rr / b.n).toFixed(2) : "-"}`]));
    }
    const wrap = el("div", "tbl");
    wrap.append(table);
    box.append(wrap);
    const rk = (x) => (x === null ? "外れ" : `${x}位`);
    const changed = results.filter((r) => !r.negative && r.rank_on !== r.rank_off);
    box.append(el("p", "sec-title", changed.length ? "辞書で順位が変わった問い（あり ← なし）" : "辞書で順位が変わった問いはない"));
    for (const r of changed) box.append(el("p", null, `${r.id}: ${rk(r.rank_on)} ← ${rk(r.rank_off)}`));
    const misses = results.filter((r) => !r.negative && r.rank_on === null);
    if (misses.length) box.append(el("p", "sec-title", "外れた問い（上位の節）"));
    for (const r of misses) box.append(el("p", null, `${r.id}${r.severity === "high" ? "（重要）" : ""}: ${r.top_on.map((h) => `${h.page_label} ${h.path}`).join(" / ") || "ヒットなし"}`));
    const negs = results.filter((r) => r.negative).length;
    if (negs) box.append(el("p", "help", `書籍にない問い ${negs} 問は、ここでは数えない（回答の評価で見る）。`));
  }

  // answers: costs money and counts toward the daily cap, so it asks first; results stay in this tab
  async function runAsk(n) {
    const qs = questions.slice(0, n);
    if (!confirm(`${qs.length} 問を送ります。費用の目安は ${qs.length * 5}〜${qs.length * 15} 円（概算・未実測）で、1日の上限に数えます。送りますか？`)) return;
    const box = paneEval.querySelector(".ask-results");
    box.replaceChildren(el("p", "sec-title", "回答の評価"));
    const rows = [];
    for (const r of qs) {
      const q = r.q;
      const p = el("p", null, `${r.id}: 送っています…`);
      box.append(p);
      const o = await askOnce(q);
      const s = scoreAsk(q, o);
      rows.push({ q, o, s });
      const gold = s.cited_gold === null ? "" : s.cited_gold ? "・正解の頁を引用" : "・正解の頁を引用せず";
      const mm = q.must_mention?.length ? `・語 ${s.mention_hit.length}/${q.must_mention.length}` : "";
      const neg = q.negative ? (s.abstained ? "・「見つからなかった」と回答" : "・書籍にない問いに回答した") : "";
      p.textContent = `${r.id}: ${o.kind}・引用 ${s.book_citations}${gold}${mm}${neg}${o.message ? `（${o.message.slice(0, 60)}）` : ""}`;
      if (o.kind === "limit") {
        box.append(el("div", "notice err", "1日の上限に達したので、ここで止めました。"));
        break;
      }
    }
    const pos = rows.filter((r) => r.o.kind === "final" && !r.q.negative);
    const gold = pos.filter((r) => r.s.cited_gold !== null);
    box.append(
      el("p", "help", `書籍を引用した回答 ${pos.filter((r) => r.s.book_citations > 0).length}/${pos.length}・正解の頁を引用 ${gold.filter((r) => r.s.cited_gold).length}/${gold.length}`),
      el("p", "help", "結果はこの画面のメモリにだけ置き、保存しない。回答は同じ問いでも揺れるので、大事な問いは複数回見る。"),
    );
  }

  async function askOnce(q) {
    try {
      const res = await api("/api/ask", { method: "POST", body: JSON.stringify({ question: q.question || q.queries.join(" ") }) });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        return { kind: j.code === "possible_identifier" ? "refused" : j.code === "daily_limit" ? "limit" : "http_error", answer: "", citations: [], message: j.error || `HTTP ${res.status}` };
      }
      const text = await res.text();
      let deltas = "";
      let out = { kind: "error", answer: "", citations: [], message: "応答が途中で切れました" };
      for (const raw of text.split("\n\n")) {
        const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const ev = JSON.parse(data);
        if (ev.t === "delta") deltas += ev.text;
        else if (ev.t === "reset") deltas = "";
        else if (ev.t === "final") out = { kind: "final", answer: ev.blocks.map((b) => b.text).join(""), citations: ev.blocks.flatMap((b) => b.citations || []) };
        else if (ev.t === "degraded") out = { kind: "degraded", answer: deltas, citations: [], message: ev.message };
        else if (ev.t === "error") out = { kind: "error", answer: deltas, citations: [], message: ev.message };
      }
      return out;
    } catch (e) {
      return { kind: "http_error", answer: "", citations: [], message: e.message };
    }
  }
}
