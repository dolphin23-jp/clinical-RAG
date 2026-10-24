// The "症例の記録" dialog (docs/enhancement-plan.md 8; the doctor's decision of 2026-10-24, docs/clinical-use.md 1e).  A case that builds up
// across encounters, kept on the server (Worker: recordstore.ts) so it survives closing the app: the emergency encounter (the pinned case,
// its time axis, what is still blank) and the admission note built from it (the problems with stable ids, what the doctor carried over,
// the doctor's own texts, the A05 draft).  The model and every rule are in case-record.js (pure); this file is the screen and the saving.
//
// Saving: every change is saved after a short pause (and when the dialog closes or the page is hidden); the revision the edit was based
// on travels with it, so a save from another screen is never overwritten (the Worker answers 409).  Identifier-like text is refused here
// before sending and again by the Worker.  The record is not kept in the browser's own storage.
// Every string reaches the DOM through textContent / .value.
import { caseKey } from "./case-model.js";
import { scan } from "./id-guard.js";
import { AI_MARK, ROLES, toText } from "./note-assemble.js";
import { ADM_FIELDS, CERTAINTY, LIMITS, PLAN_STATES, addAdopted, addEntry, addProblem, admissionNote, attach, checks, cleanRecord, flowOf, moveProblem, newRecord, relativizeRecord, removeEntry, removeProblem, setAdm, setCase, setEntry, setProblem, timeline } from "./case-record.js";
import { bindDates, changesNote } from "./intake-ui.js";

const SAVE_DELAY = 1200;
const newId = () => {
  try {
    if (globalThis.crypto?.randomUUID) return `r${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 30)}`;
  } catch {
    /* fall through */
  }
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
};
const daysAgo = (iso) => {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const d = Math.floor((Date.now() - t) / 86_400_000);
  return d <= 0 ? "今日" : `${d}日前`;
};
/** Every string value in a record (for the identifier check before sending). */
const strings = (v, out = []) => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
};
const citeText = (c) => `${c.kind === "web" ? "Web" : "書籍"}${c.page ? ` ${c.page}` : ""}`;

export function initRecords(ctx) {
  const { api, el, $, openDialog, copyText, caseCtl } = ctx;
  const dlg = $("#record");
  const body = $("#record-body");
  let FLOWS = null;
  const S = { list: null, retention: null, id: null, rev: 0, rec: null, save: "saved", version: 0, timer: null, inflight: false, msg: "", msgKind: "", opts: { ai: true, src: true } };
  let derived = null; // { checks, preview } nodes that change while typing
  let dateNote = null;

  const btn = (label, cls, onClick) => {
    const b = el("button", cls ?? "btn", label);
    b.type = "button";
    if (onClick) b.addEventListener("click", onClick);
    return b;
  };
  const say = (text, kind = "") => {
    S.msg = text;
    S.msgKind = kind;
  };

  // ---------------------------------------------------------------- the server
  async function call(path, init) {
    try {
      const res = await api(path, init);
      return { ok: res.ok, status: res.status, j: await res.json().catch(() => ({})) };
    } catch (e) {
      return { ok: false, status: 0, j: { error: e?.message || "通信できませんでした" } };
    }
  }
  async function loadFlows() {
    if (FLOWS) return;
    try {
      FLOWS = (await import("./flow-schema.js")).FLOWS;
    } catch {
      FLOWS = null; // the time axis and the core-question check are left out; the rest works
    }
  }

  async function loadList() {
    const r = await call("/api/records");
    if (r.ok) {
      S.list = r.j.records ?? [];
      S.retention = r.j.retention_days ?? null;
    } else {
      S.list = [];
      say(r.j.error || "記録の一覧を読み込めませんでした", "err");
    }
    render();
  }

  async function openRecord(id) {
    const r = await call(`/api/records/${encodeURIComponent(id)}`);
    const rec = r.ok ? cleanRecord(r.j.record) : null;
    if (!rec) {
      say(r.ok ? "この記録は読み込めませんでした（形式が合いません）" : r.j.error || "記録を読み込めませんでした", "err");
      return render();
    }
    // the case of the record becomes the pinned case; ask before it replaces another pinned case
    const pinned = caseCtl.pinned();
    if (pinned && caseKey(pinned) !== caseKey(rec.ed.case) && !confirm("いま固定している症例を、この記録の症例に置き換えます。よいですか？")) return;
    await loadFlows();
    S.id = id;
    S.rev = r.j.rev;
    S.rec = rec;
    S.save = "saved";
    say("");
    caseCtl.set(rec.ed.case, { keepLink: true });
    markLinked();
    render();
  }

  /** Makes a record of a case (the doctor's act).  Returns true when it was made and is now the open record. */
  async function createFrom(kase) {
    const rec = newRecord(kase);
    if (!rec) {
      say("主訴・バイタル・所見・既往・場面ごとの質問のどれかを入れた症例を固定してから、記録にしてください。", "err");
      render();
      return false;
    }
    if (strings(rec).some((t) => scan(t).length)) {
      say("患者を特定できる情報の可能性があるため、記録にできません。症例の画面で直してください。", "err");
      render();
      return false;
    }
    const id = newId();
    const r = await call(`/api/records/${id}`, { method: "PUT", body: JSON.stringify({ record: rec }) });
    if (!r.ok) {
      say(r.j.error || "記録を作れませんでした", "err");
      render();
      return false;
    }
    await loadFlows();
    S.id = id;
    S.rev = r.j.rev;
    S.rec = rec;
    S.save = "saved";
    say("");
    S.list = null;
    markLinked();
    return true;
  }

  function touch() {
    S.version += 1;
    S.save = "dirty";
    clearTimeout(S.timer);
    S.timer = setTimeout(save, SAVE_DELAY);
    showStatus();
  }

  async function save() {
    clearTimeout(S.timer);
    if (!S.rec || !S.id || S.inflight || S.save === "conflict" || S.save === "gone") return;
    // the last pass before saving: no calendar date is kept (the fields already convert when pasted into or left; this catches the rest)
    const rel = relativizeRecord(S.rec);
    if (rel.changes.length) {
      S.rec = rel.rec;
      S.version += 1;
      if (dlg.open) {
        render();
        dateNote.textContent = changesNote(rel.changes);
      }
    }
    const kinds = new Set();
    for (const t of strings(S.rec)) for (const h of scan(t)) kinds.add(h.label);
    if (kinds.size) {
      S.save = "blocked";
      say(`患者を特定できる情報の可能性があるため、保存していません（${[...kinds].join("、")}）。直すと保存されます。`, "err");
      return showStatus();
    }
    S.inflight = true;
    S.save = "saving";
    showStatus();
    const sent = S.version;
    const id = S.id;
    const r = await call(`/api/records/${id}`, { method: "PUT", body: JSON.stringify({ rev: S.rev, record: S.rec }) });
    S.inflight = false;
    if (S.id !== id) return; // another record was opened (or this one ended) while this was on its way
    if (r.ok) {
      S.rev = r.j.rev;
      S.save = S.version === sent ? "saved" : "dirty";
      if (S.msgKind === "err") say("");
      if (S.save === "dirty") S.timer = setTimeout(save, SAVE_DELAY);
    } else if (r.status === 409 && r.j.code === "conflict") {
      S.save = "conflict";
      say("別の画面で更新されています。この画面の変更は保存されていません。記録を開き直してください。", "err");
    } else if (r.status === 404) {
      S.save = "gone";
      say("この記録は見つかりません（保持期間が過ぎたか、別の画面で終えた可能性があります）。この画面の内容は保存されていません。", "err");
    } else {
      S.save = r.j.code === "possible_identifier" ? "blocked" : "error";
      say(r.j.error || "保存できませんでした。もう一度編集すると再試行します。", "err");
    }
    showStatus();
    if (S.msgKind === "err") renderMsg();
  }
  const flush = () => (S.save === "dirty" || S.save === "error" ? save() : Promise.resolve());

  async function endRecord() {
    if (!S.id || !confirm("この症例の記録を終えます（サーバーから削除します）。元に戻せません。よいですか？")) return;
    clearTimeout(S.timer);
    const r = await call(`/api/records/${S.id}`, { method: "DELETE" });
    if (!r.ok) {
      say(r.j.error || "終えられませんでした", "err");
      return render();
    }
    S.id = null;
    S.rec = null;
    S.list = null;
    say("記録を終えました（削除しました）。", "ok");
    await loadList();
  }

  async function deleteFromList(id) {
    if (!confirm("この症例の記録を終えます（サーバーから削除します）。元に戻せません。よいですか？")) return;
    const r = await call(`/api/records/${id}`, { method: "DELETE" });
    say(r.ok ? "記録を終えました（削除しました）。" : r.j.error || "終えられませんでした", r.ok ? "ok" : "err");
    if (S.id === id) {
      S.id = null;
      S.rec = null;
    }
    await loadList();
  }

  /** The casebar's "記録" button says when the pinned case is the open record's (its edits are saved into the record). */
  const markLinked = () => {
    const b = $("#casebar-record");
    b.textContent = S.rec ? "記録（連動中）" : "記録";
    b.classList.toggle("linked", !!S.rec);
  };
  const mutate = (fn) => {
    S.rec = fn(S.rec);
    touch();
  };
  const mutateAndRender = (fn) => {
    mutate(fn);
    render();
  };

  // ---------------------------------------------------------------- the screen
  const sheetBody = () => dlg.querySelector(".sheet-body");
  function render() {
    markLinked();
    const keep = sheetBody()?.scrollTop ?? 0;
    body.replaceChildren();
    derived = null;
    dateNote = null;
    if (S.rec) renderRecord();
    else renderList();
    renderMsg();
    const sb = sheetBody();
    if (sb) sb.scrollTop = keep;
  }
  function renderMsg() {
    let box = body.querySelector(".rec-msg");
    if (!box) {
      box = el("p", "msg rec-msg");
      body.prepend(box);
    }
    box.hidden = !S.msg;
    box.textContent = S.msg;
    box.className = `msg rec-msg${S.msgKind ? ` ${S.msgKind}` : ""}`;
  }
  function showStatus() {
    const chip = body.querySelector(".rec-status");
    if (!chip) return;
    const t = { saved: "保存済み", dirty: "未保存（自動で保存します）", saving: "保存中…", error: "保存できませんでした", blocked: "保存していません（識別情報の可能性）", conflict: "保存していません（別の画面で更新）", gone: "保存していません（記録が見つかりません）" }[S.save] ?? "";
    chip.textContent = t;
    chip.dataset.state = S.save;
    renderDerived();
  }

  // ------------------------------------------- the list
  function renderList() {
    body.append(
      el("p", "help", `症例の記録は、診察をまたいで残る症例のデータです。サーバーに保存され、最後の更新から${S.retention ?? "一定の"}日で自動的に消えます。「終える」で消せます。入れてよいのは、年代・主要所見・検査値の数値までで、氏名・ID・日付は入れません（時間は「4日前」「入院3日目」の形で）。`),
    );
    const pinned = caseCtl.pinned();
    if (pinned) {
      const row = el("div", "btn-row");
      row.append(btn("いま固定している症例を記録にする", "btn primary", async () => {
        await createFrom(pinned);
        render();
      }));
      body.append(row);
    } else body.append(el("p", "help", "新しく記録を作るには、先に「症例」を固定してください（ヘッダーの「症例」）。固定した症例が、記録の「救急」になります。"));
    if (S.list === null) {
      body.append(el("p", "help", "読み込み中…"));
      loadList();
      return;
    }
    if (!S.list.length) body.append(el("p", "help", "保存した記録はありません。"));
    const ul = el("ul", "rec-list");
    for (const r of S.list) {
      const li = el("li", "rec-item");
      const head = el("div", "rec-item-head");
      head.append(el("span", "rec-item-title", r.title), el("span", "rec-item-meta", `最終更新 ${daysAgo(r.updated_at)}`));
      const acts = el("div", "btn-row");
      acts.append(btn("開く", "btn", () => openRecord(r.id)), btn("終える", "btn danger", () => deleteFromList(r.id)));
      li.append(head, acts);
      ul.append(li);
    }
    body.append(ul);
  }

  // ------------------------------------------- the open record
  function renderRecord() {
    const rec = S.rec;
    const top = el("div", "rec-top");
    top.append(btn("← 記録の一覧", "btn", async () => {
      await flush();
      S.id = null;
      S.rec = null;
      S.list = null;
      render();
    }));
    const status = el("span", "rec-status", "");
    status.setAttribute("role", "status");
    top.append(status);
    body.append(top, el("h3", "rec-title", rec.title));
    const warn = el("div", "notice err", "");
    warn.hidden = true;
    warn.setAttribute("role", "alert");
    warn.id = "rec-warn";
    dateNote = el("p", "help", "");
    dateNote.setAttribute("role", "status");
    body.append(warn, dateNote);

    renderEd(rec);
    renderAdmission(rec);

    const end = el("div", "btn-row");
    end.append(btn("この症例を終える（削除）", "btn danger", endRecord));
    body.append(end);
    showStatus();
  }

  const sec = (title, open = true) => {
    const d = el("details", "rec-sec");
    d.open = open;
    d.append(el("summary", null, title));
    return d;
  };

  function renderEd(rec) {
    const d = sec("救急（時間軸・未入力・結果待ち）");
    const fa = flowOf(rec, FLOWS);
    d.append(el("p", "help", "救急の症例は、固定中の症例そのものです。変えるときは「症例」の画面で直して固定し直します（この記録に反映されます）。"));
    const edit = el("div", "btn-row");
    edit.append(btn("症例を開く", "btn", () => $("#btn-case").click()));
    d.append(edit);
    d.append(el("h4", "rec-sub", "時間軸（病着からの分）"));
    if (!fa) d.append(el("p", "help", "救急の質問（症例の画面の「場面・症候の質問で入力する」）を使っていないので、時間軸はありません。時刻を入れると、ここに並びます。"));
    else {
      const t = timeline(fa.flow, fa.answers, rec.ed.case);
      if (t.originMissing) d.append(el("p", "help", `${fa.flow.origin.label}の時刻が未入力のため、時刻だけを並べています（分は出ません）。`));
      if (!t.rows.length) d.append(el("p", "help", "時刻の入力はまだありません。"));
      const ol = el("ol", "rec-axis");
      for (const r of t.rows) {
        const li = el("li", "rec-axis-row");
        li.append(el("span", "rec-min", r.min === null ? "" : r.isOrigin ? "0分" : `+${r.min}分`), el("span", "rec-clock", r.time), el("span", "rec-what", r.label));
        if (r.wrapped) li.append(el("span", "rec-note", "（翌日と見なした）"));
        if (r.details.length) li.append(el("span", "rec-detail", r.details.join(" ／ ")));
        ol.append(li);
      }
      d.append(ol, el("p", "help", "時刻は記録するだけです。遅い・早いの判定や、基準の時間との比較はしません。"));
    }
    d.append(el("h4", "rec-sub", "注意（入力の状態を数えたもの。判定ではありません）"));
    const checksBox = el("div", "rec-checks");
    d.append(checksBox);
    derived = { checks: checksBox, preview: null };
    body.append(d);
  }

  function renderAdmission(rec) {
    const d = sec("入院時（引き継ぎ・問題の板・記載の下書き）");
    // 1. carrying over what was adopted in the emergency encounter: the doctor's act
    d.append(el("h4", "rec-sub", "救急で採用した項目を、入院時へ持ってくる"));
    if (!rec.ed.adopted.length) d.append(el("p", "help", "採用した項目はまだありません。アセスメントとプランの草案の回答にある「症例の記録へ」で、採用した項目を取り込めます。持ってくるかどうかは、1件ずつ先生が決めます（自動では写しません）。"));
    for (const a of rec.ed.adopted) {
      const row = el("div", "rec-adopted");
      row.append(el("span", "rec-role", ROLES[a.role]?.heading ?? a.role), el("span", "rec-text", a.text));
      if (a.cites?.length) row.append(el("span", "rec-cite", `出典: ${a.cites.map(citeText).join("、")}`));
      const sel = el("select", "rec-carry");
      sel.setAttribute("aria-label", `持ってくる先: ${a.text.slice(0, 20)}`);
      const opts = [["", "（まだ決めていない）"]];
      if (a.role === "problems") opts.push(["new", "新しい問題にする"]);
      if (a.role === "contingency") opts.push(["outlook", "再評価・コール基準に付ける"]);
      else rec.problems.forEach((p, i) => opts.push([p.id, `#${i + 1} ${p.label || "（名前なし）"} の${a.role === "plan" ? "計画（予定）" : "評価"}に付ける`]));
      opts.push(["none", "持ってこない"]);
      for (const [v, l] of opts) sel.append(new Option(l, v));
      sel.value = a.to;
      sel.addEventListener("change", () => {
        const r = attach(S.rec, a.id, sel.value);
        if (!r.ok) {
          say("この項目は、そこには付けられません。", "err");
          return render();
        }
        say("");
        S.rec = r.rec;
        touch();
        render();
      });
      row.append(sel);
      d.append(row);
    }

    // 2. the problem board
    d.append(el("h4", "rec-sub", "問題の板（優先順位の順）"));
    d.append(el("p", "help", "問題には番号（p1…）が付き、消しても同じ番号は使いません。診断の確度は先生が選びます（選ばなければ空欄）。AI草案から持ってきた行には印が付きます。"));
    for (const [i, p] of rec.problems.entries()) d.append(problemCard(p, i, rec.problems.length));
    const add = el("div", "btn-row");
    add.append(btn("＋ 問題を足す", "btn", () => mutateAndRender((r) => addProblem(r, "").rec)));
    d.append(add);

    // 3. the doctor's own texts
    d.append(el("h4", "rec-sub", "先生の入力（入院時の記載の欄）"));
    for (const f of ADM_FIELDS) {
      const lab = el("label", "field", f.label);
      const ta = el("textarea", "case-text rec-adm");
      ta.rows = 3;
      ta.maxLength = LIMITS.adm;
      ta.value = rec.adm[f.key];
      ta.setAttribute("autocomplete", "off");
      lab.append(ta);
      ta.addEventListener("input", () => mutate((r) => setAdm(r, f.key, ta.value)));
      bindDates(ta, (changes) => (dateNote.textContent = changesNote(changes)));
      d.append(lab);
    }

    // 4. the draft of the admission note
    d.append(el("h4", "rec-sub", "入院時の記載の下書き（病棟入院時 A05）"));
    d.append(el("p", "help", "固定中の症例と、この板と、先生の入力だけから組み立てます（AI は使いません）。持ってきていない採用項目は入りません。未入力の必須欄は「（未入力）」、日付・患者ID・氏名は空欄です。実際のカルテに貼る前に、先生が確認・修正してください。"));
    const opts = el("div", "note-opts");
    for (const [key, text] of [["ai", `${AI_MARK}の印を残す`], ["src", "出どころの印（［推論］・書籍の頁・救急から）を残す"]]) {
      const label = el("label", "check");
      const box = el("input");
      box.type = "checkbox";
      box.checked = S.opts[key];
      box.addEventListener("change", () => {
        S.opts[key] = box.checked;
        renderDerived();
      });
      label.append(box, el("span", null, text));
      opts.append(label);
    }
    const pre = el("pre", "note-text rec-note-text", "");
    const copy = btn("コピー", "btn primary", async () => {
      await copyText(pre.textContent);
      copy.textContent = "コピーしました";
    });
    const copyRow = el("div", "btn-row");
    copyRow.append(copy);
    d.append(opts, pre, copyRow);
    derived.preview = { pre, copy };
    body.append(d);
  }

  function problemCard(p, i, n) {
    const card = el("div", "rec-problem");
    card.dataset.p = p.id;
    const head = el("div", "rec-problem-head");
    head.append(el("span", "rec-num", String(i + 1)), el("span", "rec-id", p.id));
    const label = el("input", "rec-label");
    label.type = "text";
    label.maxLength = LIMITS.label;
    label.value = p.label;
    label.placeholder = "問題名（例: 腎前性AKI）";
    label.setAttribute("aria-label", `問題${i + 1}の名前`);
    label.addEventListener("input", () => mutate((r) => setProblem(r, p.id, { label: label.value })));
    bindDates(label, (changes) => (dateNote.textContent = changesNote(changes)));
    head.append(label);
    if (p.from === "ed") head.append(el("span", "rec-tag", "救急から"));
    const up = btn("↑", "btn rec-small", () => mutateAndRender((r) => moveProblem(r, p.id, -1)));
    up.disabled = i === 0;
    up.setAttribute("aria-label", "優先順位を上げる");
    const down = btn("↓", "btn rec-small", () => mutateAndRender((r) => moveProblem(r, p.id, 1)));
    down.disabled = i === n - 1;
    down.setAttribute("aria-label", "優先順位を下げる");
    const del = btn("削除", "btn rec-small danger", () => {
      if (!p.label && !p.assess.length && !p.plan.length) return mutateAndRender((r) => removeProblem(r, p.id));
      if (confirm(`問題「${p.label || "（名前なし）"}」と、その評価・計画を削除します。よいですか？`)) mutateAndRender((r) => removeProblem(r, p.id));
    });
    head.append(up, down, del);
    card.append(head);

    const cert = el("div", "chips rec-cert");
    cert.setAttribute("role", "group");
    cert.setAttribute("aria-label", "診断の確度");
    cert.append(el("span", "rec-cert-label", "診断の確度"));
    for (const c of CERTAINTY) {
      const b = el("button", "chip", c.label);
      b.type = "button";
      b.dataset.opt = c.id;
      b.setAttribute("aria-pressed", String(p.certainty === c.id));
      b.addEventListener("click", () => mutateAndRender((r) => setProblem(r, p.id, { certainty: p.certainty === c.id ? "" : c.id })));
      cert.append(b);
    }
    card.append(cert);

    card.append(el("div", "rec-sub", "評価"));
    for (const e of p.assess) card.append(entryRow(p, "assess", e));
    card.append(btn("＋ 評価を足す", "btn rec-small", () => mutateAndRender((r) => addEntry(r, p.id, "assess", "").rec)));
    card.append(el("div", "rec-sub", "計画"));
    for (const e of p.plan) card.append(entryRow(p, "plan", e));
    card.append(btn("＋ 計画を足す", "btn rec-small", () => mutateAndRender((r) => addEntry(r, p.id, "plan", "").rec)));
    return card;
  }

  function entryRow(p, which, e) {
    const row = el("div", "rec-entry");
    row.dataset.i = e.id;
    const ta = el("textarea", "case-text rec-entry-text");
    ta.rows = 2;
    ta.maxLength = LIMITS.text;
    ta.value = e.text;
    ta.setAttribute("autocomplete", "off");
    ta.setAttribute("aria-label", which === "plan" ? "計画" : "評価");
    ta.addEventListener("input", () => mutate((r) => setEntry(r, p.id, which, e.id, { text: ta.value })));
    bindDates(ta, (changes) => (dateNote.textContent = changesNote(changes)));
    const meta = el("div", "rec-entry-meta");
    if (e.from === "ai") {
      meta.append(el("span", "rec-tag ai", "AI草案"));
      if (e.cites?.length) meta.append(el("span", "rec-cite", `出典: ${e.cites.map(citeText).join("、")}`));
    }
    if (which === "plan") {
      const chips = el("div", "chips rec-state");
      chips.setAttribute("role", "group");
      chips.setAttribute("aria-label", "計画の状態");
      for (const s of PLAN_STATES) {
        const b = el("button", "chip", s.label);
        b.type = "button";
        b.dataset.opt = s.id;
        b.setAttribute("aria-pressed", String((e.state ?? "planned") === s.id));
        b.addEventListener("click", () => mutateAndRender((r) => setEntry(r, p.id, "plan", e.id, { state: s.id })));
        chips.append(b);
      }
      meta.append(chips);
      if ((e.state ?? "planned") !== "planned") {
        const reason = el("input", "rec-reason");
        reason.type = "text";
        reason.maxLength = LIMITS.reason;
        reason.value = e.reason ?? "";
        reason.placeholder = "理由・補足（任意）";
        reason.setAttribute("aria-label", "理由");
        reason.addEventListener("input", () => mutate((r) => setEntry(r, p.id, "plan", e.id, { reason: reason.value })));
        bindDates(reason, (changes) => (dateNote.textContent = changesNote(changes)));
        meta.append(reason);
      }
    }
    meta.append(btn("削除", "btn rec-small danger", () => mutateAndRender((r) => removeEntry(r, p.id, which, e.id))));
    row.append(ta, meta);
    return row;
  }

  // ------------------------------------------- the parts that change while typing: the checks, the identifier warning, the draft
  function renderDerived() {
    const warn = body.querySelector("#rec-warn");
    if (warn && S.rec) {
      const kinds = new Set();
      for (const t of strings(S.rec)) for (const h of scan(t)) kinds.add(h.label);
      warn.hidden = !kinds.size;
      warn.textContent = kinds.size ? `患者を特定できる情報の可能性があります（${[...kinds].join("、")}）。氏名・ID などは入れないでください。直すまで保存されません。` : "";
    }
    if (!derived || !S.rec) return;
    const list = checks(S.rec, FLOWS);
    derived.checks.replaceChildren();
    if (!list.length) derived.checks.append(el("p", "help", "いま数えられる未入力・未決定はありません（問題がないという意味ではありません）。"));
    for (const c of list) {
      const box = el("div", "rec-check");
      box.dataset.id = c.id;
      box.append(el("div", "rec-check-text", c.text));
      if (c.items.length) box.append(el("div", "rec-check-items", `${c.items.slice(0, 14).join(" ／ ")}${c.items.length > 14 ? ` ／ ほか${c.items.length - 14}件` : ""}`));
      derived.checks.append(box);
    }
    if (derived.preview) {
      derived.preview.pre.textContent = toText(admissionNote(S.rec), { aiMark: S.opts.ai, sourceMarks: S.opts.src });
      derived.preview.copy.textContent = "コピー";
    }
  }

  // ---------------------------------------------------------------- the entrances
  $("#btn-records").addEventListener("click", open);
  $("#casebar-record").addEventListener("click", open);
  function open() {
    say("");
    if (!S.rec) S.list = null;
    render();
    openDialog(dlg);
  }
  dlg.addEventListener("close", () => {
    flush();
    S.msg = "";
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });

  return {
    open,
    /** the id of the record the pinned case belongs to, or null */
    linked: () => S.id,
    /** the pinned case was pinned again: when it belongs to the open record, the record follows it */
    onCasePinned(kase) {
      if (!S.rec || !S.id) return;
      mutate((r) => setCase(r, kase));
      if (!dlg.open) return;
      render();
    },
    onCaseCleared() {
      // the record stays saved; the pinned case no longer belongs to it
      flush();
      S.id = null;
      S.rec = null;
      S.list = null;
      markLinked();
      if (dlg.open) render();
    },
    /**
     * Takes adopted draft items into the record of this case (making the record first when the case has none: the doctor pressed the button).
     * Returns { ok, added, message }.
     */
    async addAdopted(kase, items) {
      if (!S.rec) {
        if (!(await createFrom(kase))) return { ok: false, added: 0, message: S.msg };
      }
      const r = addAdopted(S.rec, items);
      S.rec = r.rec;
      touch();
      await flush();
      if (dlg.open) render();
      return { ok: S.save === "saved", added: r.added, message: S.save === "saved" ? "" : S.msg };
    },
  };
}
