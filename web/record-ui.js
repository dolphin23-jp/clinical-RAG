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
import { AI_MARK, REFS_NOTE, REF_VIA_LABEL, ROLES, toText } from "./note-assemble.js";
import { COURSE_LIMITS, DAY_FIELDS, DISCHARGE_FIELDS, MED_CHANGES, OUTPATIENT_DAY_FIELDS, SUMMARY_FIELDS, TASK_KINDS, TREND, addMed, addTask, asOf, canWriteDay, dayLabelFor, nextDay, removeDay, removeMed, removeTask, setDayField, setDayTurning, setDischarge, setMed, setSummary, setTask, setToday, setTrend, trendAt } from "./case-course.js";
import { dischargeNote, firstVisitNote, interimNote, progressNote, revisitNote } from "./record-notes.js";
import { briefDay, recordBrief } from "./record-brief.js";
import { ADM_FIELDS, CERTAINTY, DX_CLASSES, LIMITS, PLAN_STATES, addAdopted, addEntry, addProblem, admissionNote, attach, checks, cleanRecord, entryModified, flowOf, isOutpatient, isRecordCase, moveProblem, newRecord, pastePlan, pinRef, refKey, refsOf, relativizeRecord, removeEntry, removeProblem, setAdm, setCase, setEntry, setProblem, setReading, timeline, unpinRef, waiting } from "./case-record.js";
import { initCasebook } from "./casebook-ui.js";
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
const END_ASK = "この症例の記録を終えます（サーバーから削除します）。元に戻せません。なお、質問に付けて会話に保存された症例の入力は、会話を消すか保存期間が過ぎるまで残ります。よいですか？";
const citeText = (c) => `${c.kind === "web" ? "Web" : "書籍"}${c.page ? ` ${c.page}` : ""}`;

export function initRecords(ctx) {
  const { api, el, $, openDialog, copyText, caseCtl, hasThread, newConversation } = ctx;
  const dlg = $("#record");
  const body = $("#record-body");
  let FLOWS = null;
  // gen: which opened record this is (a response for an earlier one is ignored); pending: the save in flight; unconfirmed: what was sent
  // since the last answer we read (a write whose answer was lost may have landed); unlinking: the pinned case was cleared and the record is being let go
  const S = { list: null, retention: null, id: null, rev: 0, rec: null, save: "saved", version: 0, timer: null, gen: 0, pending: null, unconfirmed: [], unlinking: false, creating: false, msg: "", msgKind: "", opts: { ai: true, src: true, soap: false }, noteDay: null, sumDay: null, open: {}, refSearch: {} };
  const casebook = initCasebook({ el, copyText }); // the "Casebook へ送る" part: ticks, the packet and what was typed live in its own memory
  let derived = null; // { checks, preview, progress, interim, discharge } nodes that change while typing
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
    // the case of the record becomes the pinned case.  When the thread on screen is not this case's (another patient's questions and answers
    // would ride along with the next question, and the next turn would be saved into that conversation), a new conversation starts first.
    const pinned = caseCtl.pinned();
    const same = !!pinned && isRecordCase(rec, pinned);
    const thread = hasThread?.() ?? false;
    if (!same && (thread || (pinned && caseKey(pinned) !== caseKey(rec.ed.case)))) {
      const ask = thread
        ? "この記録を開くと、いまの会話を閉じて新しい会話を始めます（質問済みの会話は「会話」から開けます）。別の患者の質問や回答が、この症例に混ざらないようにするためです。よいですか？"
        : "いま固定している症例を、この記録の症例に置き換えます。よいですか？";
      if (!confirm(ask)) return;
      if (thread) newConversation?.();
    }
    await loadFlows();
    S.gen += 1;
    S.id = id;
    S.rev = r.j.rev;
    S.rec = rec;
    S.save = "saved";
    S.unconfirmed = [];
    S.refSearch = {};
    say("");
    caseCtl.set(rec.ed.case, { keepLink: true });
    markLinked();
    render();
  }

  /** Makes a record of a case (the doctor's act).  Returns true when it was made and is now the open record. */
  async function createFrom(kase, kind = {}) {
    if (S.creating) return false; // a second tap while the first is on its way
    const made = newRecord(kase, kind);
    const rec = made && relativizeRecord(made).rec; // a case that did not go through the pin may still hold a date
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
    S.creating = true;
    const r = await call(`/api/records/${id}`, { method: "PUT", body: JSON.stringify({ record: rec }) });
    S.creating = false;
    if (!r.ok) {
      say(r.j.error || "記録を作れませんでした", "err");
      render();
      return false;
    }
    await loadFlows();
    S.gen += 1;
    S.id = id;
    S.rev = r.j.rev;
    S.rec = rec;
    S.save = "saved";
    S.unconfirmed = [];
    say("");
    S.list = null;
    markLinked();
    return true;
  }

  function touch() {
    S.version += 1;
    // a record that can not be saved (another screen saved it, or it is gone) stays that way: no doomed save, no "auto-save" that is not
    if (S.save === "conflict" || S.save === "gone") return showStatus();
    S.save = "dirty";
    clearTimeout(S.timer);
    S.timer = setTimeout(save, SAVE_DELAY);
    showStatus();
  }

  /** Saves what changed.  One save at a time: a call while one is on its way waits for it, then sends what changed since. */
  function save() {
    clearTimeout(S.timer);
    if (!S.rec || !S.id || S.unlinking || S.save === "conflict" || S.save === "gone") return Promise.resolve();
    if (S.pending) return S.pending.then(() => (S.save === "dirty" ? save() : undefined));
    S.pending = doSave().finally(() => {
      S.pending = null;
    });
    return S.pending;
  }

  async function doSave() {
    // the last pass before saving: no calendar date is kept (the fields already convert when pasted into or left; this catches the rest).
    // The screen is not redrawn (that would drop the focus and an IME composition): the field converts when it is left.
    const rel = relativizeRecord(S.rec);
    if (rel.changes.length) {
      S.rec = rel.rec;
      S.version += 1;
      if (dateNote) dateNote.textContent = changesNote(rel.changes);
    }
    const kinds = new Set();
    for (const t of strings(S.rec)) for (const h of scan(t)) kinds.add(h.label);
    if (kinds.size) {
      S.save = "blocked";
      say(`患者を特定できる情報の可能性があるため、保存していません（${[...kinds].join("、")}）。直すと保存されます。`, "err");
      return showStatus();
    }
    S.save = "saving";
    showStatus();
    const gen = S.gen;
    const id = S.id;
    const sent = S.version;
    const body = JSON.stringify(S.rec);
    S.unconfirmed.push(body);
    const r = await call(`/api/records/${id}`, { method: "PUT", body: JSON.stringify({ rev: S.rev, record: S.rec }) });
    if (S.gen !== gen) return; // another record was opened (or this one ended) while this was on its way
    if (r.ok) {
      S.rev = r.j.rev;
      S.unconfirmed = [];
      S.save = S.version === sent ? "saved" : "dirty";
      if (S.msgKind === "err") say("");
      if (S.save === "dirty") S.timer = setTimeout(save, SAVE_DELAY);
    } else if (r.status === 409 && r.j.code === "conflict") {
      // a write of ours whose answer was lost may have landed: when the server holds exactly something we sent, it is ours, not another screen's
      const g = await call(`/api/records/${id}`);
      if (S.gen !== gen) return;
      if (g.ok && S.unconfirmed.includes(JSON.stringify(g.j.record))) {
        S.rev = g.j.rev;
        S.unconfirmed = [];
        S.version += 1; // send again with the revision that is the server's now
        S.save = "dirty";
        S.timer = setTimeout(save, 0);
      } else {
        S.save = "conflict";
        say("別の画面で更新されています。この画面の変更は保存されていません。記録を開き直してください（開き直すと、この画面で書いた分は消えます）。", "err");
      }
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

  /** Waits for the save in flight and sends what is still unsaved.  True when everything is saved. */
  async function settle() {
    for (let i = 0; i < 4; i++) {
      clearTimeout(S.timer);
      if (S.pending) await S.pending;
      if (S.save === "dirty" || S.save === "error") await save();
      else break;
    }
    return S.save === "saved";
  }
  const flush = () => settle();

  /** Before the record is let go: true when it may be (everything saved, or the doctor accepts losing what is not). */
  async function leave() {
    if (!S.rec) return true;
    if (await settle()) return true;
    return confirm("保存されていない変更があります。破棄して閉じますか？（「キャンセル」で戻ります）");
  }

  /** The record is let go: nothing refers to it any more. */
  function reset() {
    S.gen += 1;
    S.id = null;
    S.rec = null;
    S.list = null;
    S.unconfirmed = [];
    S.save = "saved";
    S.noteDay = S.sumDay = null;
    S.open = {};
    S.refSearch = {};
    markLinked();
  }

  async function endRecord() {
    if (!S.id || !confirm(END_ASK)) return;
    clearTimeout(S.timer);
    if (S.pending) await S.pending; // a save on its way must not arrive after the delete
    const r = await call(`/api/records/${S.id}`, { method: "DELETE" });
    if (!r.ok) {
      say(r.j.error || "終えられませんでした", "err");
      return render();
    }
    reset();
    say("記録を終えました（削除しました）。", "ok");
    await loadList();
  }

  async function deleteFromList(id) {
    if (!confirm(END_ASK)) return;
    const r = await call(`/api/records/${id}`, { method: "DELETE" });
    say(r.ok ? "記録を終えました（削除しました）。" : r.j.error || "終えられませんでした", r.ok ? "ok" : "err");
    if (S.id === id) reset();
    await loadList();
  }

  /** The casebar's "記録" button says when the pinned case is the open record's (its edits are saved into the record). */
  const markLinked = () => {
    const b = $("#casebar-record");
    b.textContent = S.rec ? "記録（連動中）" : "記録";
    b.classList.toggle("linked", !!S.rec);
    const note = $("#case-linked");
    if (note) note.hidden = !S.rec; // the case dialog says the pinned case is the open record's
    const now = S.rec ? S.id : null;
    if (now !== lastLinked) {
      lastLinked = now;
      changed();
    }
  };
  let lastLinked = null;
  // the scene choices of the draft follow the open record (case.js): told when a record is opened, made or let go, and when the dialog closes
  const listeners = [];
  const changed = () => {
    for (const f of listeners) {
      try {
        f();
      } catch {
        /* a listener's failure never reaches the record */
      }
    }
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
      el("p", "help", `症例の記録は、診察をまたいで残る症例のデータです。サーバーに保存され、最後の更新から${S.retention ?? "一定の"}日で自動的に消えます。「終える」で消せます。入れてよいのは、年齢（歳）・主要所見・検査値の数値までで、氏名・ID・日付は入れません（時間は「4日前」「入院3日目」の形で）。`),
    );
    const pinned = caseCtl.pinned();
    if (pinned) {
      const row = el("div", "btn-row");
      const make = btn("いま固定している症例を記録にする", "btn primary", async () => {
        make.disabled = true;
        await createFrom(pinned);
        render();
      });
      row.append(make);
      body.append(row);
      const out = el("div", "btn-row rec-out-start");
      const first = btn("外来の記録にする（この症例を初診として）", "btn", async () => {
        first.disabled = true;
        await createFrom(pinned, { kind: "outpatient", start: "first" });
        render();
      });
      first.dataset.act = "start-first";
      const revisit = btn("外来の記録を、再診から始める（前回の方針を貼る）", "btn", async () => {
        revisit.disabled = true;
        await createFrom(pinned, { kind: "outpatient", start: "revisit" });
        render();
      });
      revisit.dataset.act = "start-revisit";
      out.append(first, revisit);
      body.append(el("p", "help", "外来の記録は、初診からの経過を「基準日からN日後」の形で積み上げます（日付は入れません）。初診が別の場所の記録のときは、再診から始め、前回の方針を貼ってください。"), out);
    } else body.append(el("p", "help", "新しく記録を作るには、先に「症例」を固定してください（ヘッダーの「症例」）。固定した症例が、入院の記録の「救急」、または外来の記録の初診（再診から始めるときは再診の目的）になります。"));
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
      if (!(await leave())) return;
      reset();
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

    if (isOutpatient(rec)) {
      renderOutpatientBase(rec);
      renderCourse(rec);
      body.append(el("p", "help rec-casebook-note", "外来の記録は、Casebook へは送れません（外来の受診には受診日の暦日が要り、この記録は日付を持たないためです）。"));
    } else {
      renderEd(rec);
      renderAdmission(rec);
      renderCourse(rec);
      renderSummaries(rec);
      renderCasebook();
    }

    const end = el("div", "btn-row");
    end.append(btn("この症例を終える（削除）", "btn danger", endRecord));
    body.append(end);
    showStatus();
  }

  function renderCasebook() {
    const d = sec("Casebook へ送る（試作）", false);
    d.id = "rec-casebook";
    const box = el("div", "cb-box");
    d.append(box);
    body.append(d);
    const draw = () => casebook.draw(box, { getRec: () => S.rec, id: S.id, mutate: mutateAndRender });
    draw();
    // typing in the record does not draw the screen again, so the list is drawn again when the part is opened
    d.addEventListener("toggle", () => {
      if (d.open) draw();
    });
  }

  const sec = (title, open = true) => {
    const d = el("details", "rec-sec");
    d.open = S.open[title] ?? open; // a section the doctor opened or closed stays so when the screen is redrawn
    d.addEventListener("toggle", () => (S.open[title] = d.open));
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
      const t = timeline(fa.flow, fa.answers, rec.ed.case, rec.ed.reading);
      if (t.originMissing) d.append(el("p", "help", `${fa.flow.origin.label}の時刻が未入力のため、時刻だけを並べています（分は出ません）。`));
      if (!t.rows.length) d.append(el("p", "help", "時刻の入力はまだありません。"));
      const ol = el("ol", "rec-axis");
      const origin = fa.flow.origin.label;
      for (const r of t.rows) {
        const li = el("li", "rec-axis-row");
        li.dataset.q = r.id;
        const mins = r.min === null ? "" : r.min === 0 ? "0分" : `${r.min > 0 ? "+" : ""}${r.min}分`;
        li.append(el("span", "rec-min", mins), el("span", "rec-clock", r.time), el("span", "rec-what", r.label));
        if (r.assumed) {
          // a clock time has no date: the order of the clock disagrees with the usual order, so this is a reading, and the doctor can flip it
          li.append(el("span", "rec-note", `（日付のない時刻のため、${origin}の${r.reading === "after" ? "後（翌日）" : "前"}として計算）`));
          const other = r.reading === "after" ? "before" : "after";
          li.append(btn(`${origin}の${other === "after" ? "後（翌日）" : "前"}として読む`, "btn rec-small rec-reading", () => mutateAndRender((rec2) => setReading(rec2, r.id, other))));
        }
        if (r.details.length) li.append(el("span", "rec-detail", r.details.join(" ／ ")));
        ol.append(li);
      }
      d.append(ol, el("p", "help", "時刻は記録するだけです。遅い・早いの判定や、基準の時間との比較はしません。時刻には日付がないので、時刻の並びと食い違うものは仮の読み方をしています（印のある行）。違うときは、読み方を変えてください。"));
    }
    d.append(el("h4", "rec-sub", "注意（入力の状態を数えたもの。判定ではありません）"));
    const checksBox = el("div", "rec-checks");
    d.append(checksBox);
    derived = { checks: checksBox, preview: null };
    body.append(d);
  }

  /** The adopted draft items and the doctor's choice of where each goes (the doctor's act).  `title` and `none`: the heading and the empty-state sentence. */
  function carryRows(d, rec, { title, none, to }) {
    d.append(el("h4", "rec-sub", title));
    if (!rec.ed.adopted.length) d.append(el("p", "help", none));
    for (const a of rec.ed.adopted) {
      const row = el("div", "rec-adopted");
      row.append(el("span", "rec-role", ROLES[a.role]?.heading ?? a.role), el("span", "rec-text", a.text));
      if (a.cites?.length) row.append(el("span", "rec-cite", `出典: ${a.cites.map(citeText).join("、")}`));
      const sel = el("select", "rec-carry");
      sel.setAttribute("aria-label", `持ってくる先: ${a.text.slice(0, 20)}`);
      const opts = [["", "（まだ決めていない）"]];
      if (a.role === "problems") opts.push(["new", "新しい問題にする"]);
      if (a.role === "contingency") opts.push(["outlook", "再評価・コール基準に付ける"]);
      else rec.problems.forEach((p, i) => p.id !== a.made && opts.push([p.id, `#${i + 1} ${p.label || "（名前なし）"} の${a.role === "plan" ? "計画（予定）" : "評価"}に付ける`]));
      opts.push(["none", "持ってこない"]);
      for (const [v, l] of opts) sel.append(new Option(l, v));
      sel.value = a.made && a.to === a.made ? "new" : a.to; // the problem the item made is "新しい問題にする", not an assessment of itself
      sel.addEventListener("change", () => {
        // moving keeps what the doctor changed in the entry; taking it back loses that, so ask
        const takesBack = ["", "none", "new"].includes(sel.value);
        if (takesBack && entryModified(S.rec, a.id) && !confirm("この項目から作った行は、先生が編集済みです。持ってくる先を外すと、その編集内容は消えます。よいですか？")) {
          sel.value = a.made && a.to === a.made ? "new" : a.to;
          return;
        }
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
  }

  /** The base of an outpatient record: the visit it began at, the plan of the last visit (pasted), the problem board and the first-visit draft. */
  function renderOutpatientBase(rec) {
    const first = rec.start === "first";
    const d = sec(first ? "初診（基準日・症例・問題の板）" : "再診から始めた記録（基準日・前回の方針・問題の板）");
    d.append(
      el(
        "p",
        "help",
        first
          ? "初診の症例は、固定中の症例そのものです（基準日＝初診の日）。変えるときは「症例」の画面で直して固定し直します（この記録に反映されます）。以降の再診は、基準日から何日後かで記録します。"
          : "初診は別の場所の記録なので、この記録には入っていません。基準日は、前回の診察の日です。前回の方針を下に貼ると、基準日の計画（予定・検討）として入り、再診で結果（実施・変更・中止）を記録できます。固定中の症例の「主訴」は、最初の再診の目的として使えます。",
      ),
    );
    const edit = el("div", "btn-row");
    edit.append(btn("症例を開く", "btn", () => $("#btn-case").click()));
    d.append(edit);
    d.append(el("h4", "rec-sub", "注意（入力の状態を数えたもの。判定ではありません）"));
    const checksBox = el("div", "rec-checks");
    d.append(checksBox);
    derived = { checks: checksBox, preview: null };

    if (first) carryRows(d, rec, { title: "初診で採用した項目を、問題の板へ持ってくる", none: "採用した項目はまだありません。アセスメントとプランの草案の回答にある「症例の記録へ」で、採用した項目を取り込めます。持ってくるかどうかは、1件ずつ先生が決めます（自動では写しません）。" });

    // the plan of the last visit: pasted by the doctor, line by line
    d.append(el("h4", "rec-sub", "前回の方針を貼る"));
    d.append(el("p", "help", `1行に1つの方針として、基準日の計画（予定・検討）に足します（先生の言葉のまま。日付は「N日前」に直します）。実施・変更・中止は、再診の日に先生が選んで記録します。1つの問題に${LIMITS.entries}件までです。`));
    const paste = el("div", "rec-paste");
    const ta = el("textarea", "case-text rec-paste-text");
    ta.rows = 4;
    ta.maxLength = 4000;
    ta.placeholder = "前回の方針を、1行に1つずつ";
    ta.setAttribute("aria-label", "前回の方針");
    ta.setAttribute("autocomplete", "off");
    bindDates(ta, (changes) => (dateNote.textContent = changesNote(changes)));
    const target = el("select", "rec-kind");
    target.setAttribute("aria-label", "貼る先の問題");
    target.append(new Option("新しい問題にする", ""));
    rec.problems.forEach((p, i) => target.append(new Option(`#${i + 1} ${p.label || "（名前なし）"}`, p.id)));
    const name = el("input", "rec-label");
    name.type = "text";
    name.maxLength = LIMITS.label;
    name.placeholder = "新しい問題の名前（任意）";
    name.setAttribute("aria-label", "新しい問題の名前");
    bindDates(name, (changes) => (dateNote.textContent = changesNote(changes)));
    const go = btn("基準日の計画（予定・検討）として足す", "btn primary", () => {
      const r = pastePlan(S.rec, target.value || null, ta.value, name.value);
      if (!r.id && ta.value.trim()) {
        say("足せませんでした（問題の数が上限です）。", "err");
        return render();
      }
      if (!r.added) return;
      S.rec = r.rec;
      touch();
      say(`${r.added} 件を、基準日の計画（予定・検討）として足しました。${r.left ? `入りきらなかった ${r.left} 行は、足していません（1つの問題に${LIMITS.entries}件まで）。` : ""}`, r.left ? "err" : "ok");
      render();
    });
    go.dataset.act = "paste-plan";
    paste.append(ta, el("div", "rec-entry-meta", ""), go);
    paste.children[1].append(target, name);
    d.append(paste);

    boardRows(d, rec);

    if (first) {
      d.append(el("h4", "rec-sub", "初診の記載の下書き（外来初診 A01）"));
      d.append(el("p", "help", "固定中の症例と、場面・症候の入力（振り分け）と、問題の板へ持ってきた採用項目だけから組み立てます（AI は使いません）。未入力の必須欄は「（未入力）」、日付・患者ID・氏名は空欄です。実際のカルテに貼る前に、先生が確認・修正してください。"));
      const pre = el("pre", "note-text rec-note-text rec-first-text", "");
      const copy = btn("コピー", "btn primary", async () => {
        await copyText(pre.textContent);
        copy.textContent = "コピーしました";
      });
      const row = el("div", "btn-row");
      row.append(copy);
      d.append(pre, row);
      derived.first = { pre, copy };
    }
    body.append(d);
  }

  /** The problem board: the problems in priority order, each with its cards, and the button to add one. */
  function boardRows(d, rec) {
    d.append(el("h4", "rec-sub", "問題の板（優先順位の順）"));
    d.append(el("p", "help", "問題には番号（p1…）が付き、消しても同じ番号は使いません。診断の確度は先生が選びます（選ばなければ空欄）。AI草案から持ってきた行には印が付きます。"));
    for (const [i, p] of rec.problems.entries()) d.append(problemCard(p, i, rec.problems.length));
    const add = el("div", "btn-row");
    add.append(btn("＋ 問題を足す", "btn", () => mutateAndRender((r) => addProblem(r, "").rec)));
    d.append(add);
  }

  function renderAdmission(rec) {
    const d = sec("入院時（引き継ぎ・問題の板・記載の下書き）");
    // 1. carrying over what was adopted in the emergency encounter: the doctor's act
    carryRows(d, rec, { title: "救急で採用した項目を、入院時へ持ってくる", none: "採用した項目はまだありません。アセスメントとプランの草案の回答にある「症例の記録へ」で、採用した項目を取り込めます。持ってくるかどうかは、1件ずつ先生が決めます（自動では写しません）。" });

    // 2. the problem board
    boardRows(d, rec);

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
    for (const [key, text] of [["ai", `${AI_MARK}の印を残す`], ["src", "出どころの印（［推論］・書籍の頁・救急から）を残す"], ["soap", "S/O/A/P で表示する（入院時・経過・外来の記載。中身は同じで、並べ方だけを変えます）"]]) {
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
    label.addEventListener("input", () => {
      mutate((r) => setProblem(r, p.id, { label: label.value }));
      // the search by the problem's name follows what is typed
      const find = card.querySelector("[data-act=find-refs]");
      if (find && !S.refSearch[p.id]?.busy) find.disabled = !searchWords(label.value);
    });
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
    const dx = el("div", "chips rec-cert rec-dx");
    dx.setAttribute("role", "group");
    dx.setAttribute("aria-label", "退院時サマリーでの扱い");
    dx.append(el("span", "rec-cert-label", "退院時サマリーでの扱い"));
    for (const c of DX_CLASSES) {
      const b = el("button", "chip", c.label);
      b.type = "button";
      b.dataset.opt = c.id;
      b.setAttribute("aria-pressed", String(p.dx === c.id));
      b.addEventListener("click", () => mutateAndRender((r) => setProblem(r, p.id, { dx: p.dx === c.id ? "" : c.id })));
      dx.append(b);
    }
    card.append(dx);

    card.append(el("div", "rec-sub", "評価"));
    for (const e of p.assess) card.append(entryRow(p, "assess", e));
    card.append(btn("＋ 評価を足す", "btn rec-small", () => mutateAndRender((r) => addEntry(r, p.id, "assess", "").rec)));
    card.append(el("div", "rec-sub", "計画"));
    for (const e of p.plan) card.append(entryRow(p, "plan", e));
    card.append(btn("＋ 計画を足す", "btn rec-small", () => mutateAndRender((r) => addEntry(r, p.id, "plan", "").rec)));
    card.append(refsSection(p));
    return card;
  }

  // ---------------------------------------------------------------- the books' pages kept for a problem (docs/enhancement-plan.md 8.16)
  const REF_FULL = { bad: "題名か頁がないため、残せません", duplicate: "この頁は、すでにこの問題にあります", full: `残せる頁は、1つの問題に ${LIMITS.refs} 件までです`, missing: "この問題は見つかりません" };
  /** The words a search starts from: the problem's name without the marks of origin ([推論] etc.). */
  const searchWords = (label) => String(label ?? "").replace(/\s*\[(?:推論|標準・出典未確認|施設依存)\]/g, "").replace(/\s+/g, " ").trim().slice(0, 200);

  async function findRefs(p) {
    // the name as it is now in the record (the card was drawn before the doctor last typed)
    const q = searchWords(S.rec?.problems.find((x) => x.id === p.id)?.label);
    if (!q) return;
    const kinds = new Set(scan(q).map((h) => h.label));
    if (kinds.size) {
      S.refSearch[p.id] = { msg: `患者を特定できる情報の可能性があるため、検索しません（${[...kinds].join("、")}）。問題の名前を直してください。` };
      return render();
    }
    const gen = S.gen;
    S.refSearch[p.id] = { busy: true };
    render();
    const r = await call("/api/search", { method: "POST", body: JSON.stringify({ queries: [q], parents: 6 }) });
    if (S.gen !== gen || !S.rec) return; // another record was opened while this was on its way
    S.refSearch[p.id] = r.ok ? { query: q, results: (r.j.results ?? []).slice(0, 6) } : { msg: r.j.error || "検索できませんでした" };
    render();
  }

  /** Leaves a found page for the problem: the doctor's act.  Only the book's title, the page and the section's name are kept, never the text. */
  function keepRef(p, hit) {
    const out = pinRef(S.rec, p.id, { title: hit.book_title, page: hit.page_label, section: String(hit.path ?? "") });
    if (out.ok) {
      S.rec = out.rec;
      touch();
      say("");
    } else say(REF_FULL[out.reason] ?? "残せませんでした", "err");
    render();
  }

  function refsSection(p) {
    const box = el("div", "rec-refs");
    box.dataset.refs = p.id;
    box.append(el("div", "rec-sub", "書籍の根拠（どこを見たか）"));
    const refs = refsOf(p);
    if (!refs.length) box.append(el("p", "help", "まだありません。「書籍を引く」で、この問題の名前で手元の書籍を検索し、見た頁を残せます。残した頁は、後の日にも見られ、退院時サマリーの診断ごとに出せます。"));
    for (const r of refs) {
      const row = el("div", "rec-ref");
      row.dataset.key = refKey(r);
      row.append(el("span", "rec-ref-title", `${r.title} ${r.page}`));
      if (r.section) row.append(el("span", "rec-ref-sec", r.section));
      row.append(el("span", "rec-tag", REF_VIA_LABEL[r.via] ?? ""), el("span", "rec-ref-day", dayLabel(r.added)));
      if (r.pinned) row.append(btn("外す", "btn rec-small", () => mutateAndRender((rec) => unpinRef(rec, p.id, refKey(r)))));
      box.append(row);
    }
    if (refs.length) box.append(el("p", "help", `${REFS_NOTE}。`));
    const st = S.refSearch[p.id];
    const find = btn(st?.busy ? "検索しています…" : "書籍を引く", "btn rec-small", () => findRefs(p));
    find.dataset.act = "find-refs";
    find.disabled = !searchWords(p.label) || !!st?.busy;
    if (!searchWords(p.label)) find.title = "問題の名前を入れると、その名前で検索できます";
    box.append(find);
    if (st?.msg) box.append(el("p", "msg err", st.msg));
    if (st?.results) {
      const list = el("div", "rec-found");
      list.append(el("p", "help", st.results.length ? `「${st.query}」で見つかった節（近い順）。頁を残すと、題名・頁・節の名前だけを記録に残します（本文は残しません）。` : `「${st.query}」では、手元の書籍に見つかりませんでした。`));
      for (const hit of st.results) {
        const row = el("div", "rec-ref found");
        const kept = refsOf(p).some((x) => refKey(x) === refKey({ title: hit.book_title, page: hit.page_label }));
        row.append(el("span", "rec-ref-title", `${hit.book_title ?? ""} ${hit.page_label ?? ""}`), el("span", "rec-ref-sec", String(hit.path ?? "")));
        const keep = btn(kept ? "残してあります" : "この問題の根拠に残す", "btn rec-small", () => keepRef(p, hit));
        keep.dataset.act = "keep-ref";
        keep.disabled = kept || !hit.page_label || !hit.book_title;
        if (!hit.page_label) keep.title = "頁の情報がないため残せません";
        row.append(keep);
        if (hit.snippet) {
          const more = el("details", "rec-ref-snippet");
          more.append(el("summary", null, "節の冒頭"), el("p", null, String(hit.snippet)));
          row.append(more);
        }
        list.append(row);
      }
      box.append(list);
    }
    return box;
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

  // ------------------------------------------- the course: one entry per hospital day
  /** A text input or textarea that writes into the record as the doctor types (dates are made relative when pasted or left). */
  function textField(tag, value, max, onInput, label, cls) {
    const input = el(tag, cls);
    if (tag === "input") input.type = "text";
    else input.rows = 2;
    input.maxLength = max;
    input.value = value;
    input.setAttribute("autocomplete", "off");
    if (label) input.setAttribute("aria-label", label);
    input.addEventListener("input", () => onInput(input.value));
    bindDates(input, (changes) => (dateNote.textContent = changesNote(changes)));
    return input;
  }
  const dayLabel = (n) => dayLabelFor(S.rec, n);
  const trendText = (t) => (t ? `${dayLabel(t.day)} ${TREND.find((x) => x.id === t.state)?.label ?? ""}${t.note ? `（${t.note}）` : ""}` : "");

  function renderCourse(rec) {
    const out = isOutpatient(rec);
    const d = sec(out ? "再診の記録（基準日からの日数ごと・課題）" : "経過（日ごと・課題）");
    const today = rec.course.today;
    if (out) d.append(el("p", "help", "時間は「基準日からN日後」だけで記録します（基準日が1日目。日付は入れません）。ここで記録した推移・計画の結果・診断の確度の変更は、いまの日からの記録として残り、それより前の日の記載には出ません（その日の時点の記録から記載を作ります）。推移は、先生が選んだものだけが入ります（選ばなければ記載に推移の行は出ず、注意では「未評価」と数えます。「不変」にはなりません）。最後の更新から保存期間（一覧に表示）を過ぎると記録は消えるので、長く空くときは、次の再診で前回の方針を貼って始め直せます。"));
    else d.append(el("p", "help", "時間は「入院N日目」だけで記録します（入院した日が1日目。日付は入れません）。ここで記録した推移・計画の結果・診断の確度の変更は、いまの日からの記録として残り、それより前の日の記載には出ません（その日の時点の記録から記載を作ります）。前の日に戻って判断を直したときは、すでに記録した最後の日からの記録になります。問題名・評価・計画・先生が入力した文は、直すと前の日の記載にも直した文で出ます。推移は、先生が選んだものだけが入ります（選ばなければ記載に推移の行は出ず、注意では「未評価」と数えます。「不変」にはなりません）。"));

    // the working day
    const bar = el("div", "rec-daybar");
    bar.append(el("span", "rec-daybar-label", `いまの日: ${dayLabel(today)}`));
    if (out) {
      // an outpatient visit is placed by how many days after the base day it is
      const after = el("input", "rec-dayin");
      after.type = "number";
      after.min = "0";
      after.max = String(COURSE_LIMITS.maxDay - 1);
      after.value = String(today - 1);
      after.setAttribute("aria-label", "基準日から何日後か");
      after.dataset.act = "days-after";
      after.addEventListener("change", () => {
        const n = Number(after.value);
        if (after.value === "" || !Number.isInteger(n) || n < 0 || n > COURSE_LIMITS.maxDay - 1) {
          say(`基準日から何日後かは、0〜${COURSE_LIMITS.maxDay - 1}の整数で入れてください。`, "err");
          return render();
        }
        S.noteDay = null;
        say("");
        mutateAndRender((r) => setToday(r, n + 1));
      });
      bar.append(el("span", null, "基準日から"), after, el("span", null, "日後"));
    } else {
      const prev = btn("← 前の日", "btn rec-small", () => mutateAndRender((r) => setToday(r, today - 1)));
      prev.disabled = today <= 1;
      const next = btn(`${dayLabel(nextDay(rec))}へ →`, "btn rec-small primary", () => {
        S.noteDay = S.sumDay = null;
        mutateAndRender((r) => setToday(r, nextDay(r)));
      });
      next.dataset.act = "next-day";
      bar.append(prev, next);
    }
    d.append(bar);
    if (rec.course.days.length) {
      const chips = el("div", "chips rec-days");
      chips.setAttribute("role", "group");
      chips.setAttribute("aria-label", "記録のある日");
      for (const x of rec.course.days) {
        const b = el("button", "chip", out ? (x.day <= 1 ? "基準日" : `+${x.day - 1}日`) : `${x.day}日目${x.turning ? "★" : ""}`);
        b.type = "button";
        b.dataset.day = String(x.day);
        b.setAttribute("aria-pressed", String(x.day === today));
        b.addEventListener("click", () => {
          S.noteDay = S.sumDay = null;
          mutateAndRender((r) => setToday(r, x.day));
        });
        chips.append(b);
      }
      d.append(chips);
    }
    const view = asOf(rec, today);
    const day = view.course.days.find((x) => x.day === today);
    const writable = canWriteDay(rec, today);
    if (!writable) {
      const full = el("p", "notice err", `記録のある日が上限（${COURSE_LIMITS.days}日）に達しているため、${dayLabel(today)}の記録は保存できません。古い日の記録を消すと、足せます。`);
      full.setAttribute("role", "alert");
      d.append(full);
    }

    // 1. the plans of earlier days: what happened to them
    d.append(el("h4", "rec-sub", "前の日までの計画の結果"));
    const open = view.problems.flatMap((p) => p.plan.filter((e) => e.state === "planned" && (e.added ?? 1) < today).map((e) => [p, e]));
    if (!open.length) d.append(el("p", "help", "前の日までに立てた計画で、結果を記録していないもの（予定のまま）はありません。"));
    for (const [p, e] of open) {
      const row = el("div", "rec-entry rec-outcome");
      row.dataset.i = e.id;
      row.append(el("div", "rec-outcome-text", `${p.label || "（名前なし）"}: ${e.text}`), el("div", "rec-cite", `${dayLabel(e.added ?? 1)}に予定。結果は、先生が選んだとおりに記録します。`));
      const why = textField("input", "", LIMITS.reason, () => {}, "理由・補足（任意）", "rec-reason");
      why.placeholder = "理由・補足（任意。変更・中止のときは書いてください）";
      const chips = el("div", "chips rec-state");
      for (const st of PLAN_STATES.filter((x) => x.id !== "planned")) {
        const b = el("button", "chip", st.label);
        b.type = "button";
        b.dataset.opt = st.id;
        b.addEventListener("click", () => mutateAndRender((r) => setEntry(r, p.id, "plan", e.id, { state: st.id, ...(why.value.trim() ? { reason: why.value } : {}) })));
        chips.append(b);
      }
      row.append(why, chips);
      d.append(row);
    }

    // 2. the day's own texts
    d.append(el("h4", "rec-sub", `${dayLabel(today)}の記録（先生の入力）`));
    for (const f of out ? OUTPATIENT_DAY_FIELDS : DAY_FIELDS) {
      const lab = el("label", "field", f.label);
      const ta = textField("textarea", day?.[f.key] ?? "", f.max, (v) => mutate((r) => setDayField(r, today, f.key, v)), f.label, "case-text rec-day-text");
      ta.dataset.key = f.key;
      ta.disabled = !writable;
      lab.append(ta);
      d.append(lab);
    }
    if (!out) {
      const turn = el("label", "rec-turn");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = !!day?.turning;
      cb.dataset.act = "turning";
      cb.disabled = !writable && !day;
      cb.addEventListener("change", () => mutateAndRender((r) => setDayTurning(r, today, cb.checked)));
      turn.append(cb, el("span", null, `${dayLabel(today)}を、経過の転換点としてマークする（中間サマリー・退院時サマリーの「経過」に入ります）`));
      d.append(turn);
    }
    if (day) {
      const rm = btn(`${dayLabel(today)}の記録を消す`, "btn rec-small danger", () => {
        if (confirm(`${dayLabel(today)}の記録（文・推移）を消します。よいですか？`)) mutateAndRender((r) => removeDay(r, today));
      });
      d.append(rm);
    }

    // 3. how each problem is going: the doctor's reading, blank when not chosen
    d.append(el("h4", "rec-sub", `問題ごとの推移（${dayLabel(today)}）`));
    const named = view.problems.filter((p) => p.label || p.assess.length || p.plan.length);
    if (!named.length) d.append(el("p", "help", out ? "問題がまだありません（上の「問題の板」で足します）。" : "問題がまだありません（上の「入院時」で足します）。"));
    for (const p of named) {
      const row = el("div", "rec-trend");
      row.dataset.p = p.id;
      row.append(el("span", "rec-trend-name", p.label || "（名前なし）"));
      const cur = day?.trend[p.id] ?? { state: "", note: "" };
      const chips = el("div", "chips");
      chips.setAttribute("role", "group");
      chips.setAttribute("aria-label", `${p.label || "問題"}の推移`);
      for (const t of TREND) {
        const b = el("button", "chip", t.label);
        b.type = "button";
        b.dataset.opt = t.id;
        b.setAttribute("aria-pressed", String(cur.state === t.id));
        b.disabled = !writable;
        b.addEventListener("click", () => mutateAndRender((r) => setTrend(r, today, p.id, cur.state === t.id ? "" : t.id)));
        chips.append(b);
      }
      row.append(chips);
      const note = textField("input", cur.note ?? "", LIMITS.reason, (v) => mutate((r) => setTrend(r, today, p.id, undefined, v)), `${p.label || "問題"}の推移のメモ`, "rec-reason");
      note.placeholder = "メモ（任意）";
      note.disabled = !writable;
      row.append(note);
      const before = trendAt(rec, p.id, today - 1);
      if (before) row.append(el("span", "rec-cite", `前回: ${trendText(before)}`));
      d.append(row);
    }

    // 4. tasks
    d.append(el("h4", "rec-sub", "課題（結果待ち・返事・フォロー）"));
    d.append(el("p", "help", out ? "完了にするのは先生です（結果や返事が届いても、自動では完了になりません）。担当者と期限を入れておくと、次の再診で見落としにくくなります（期限は「基準日から2週後」「次回再診」のように）。" : "完了にするのは先生です（結果や返事が届いても、自動では完了になりません）。担当者と期限は、退院時サマリーの「未解決」に使います（期限は「入院5日目」「退院後2週」のように）。"));
    for (const k of view.course.tasks) d.append(taskRow(k, view));
    const addRow = el("div", "btn-row");
    const addTaskBtn = btn("＋ 課題を足す", "btn", () => mutateAndRender((r) => addTask(r, { text: "" }).rec));
    addTaskBtn.disabled = rec.course.tasks.length >= COURSE_LIMITS.tasks;
    addRow.append(addTaskBtn);
    if (addTaskBtn.disabled) addRow.append(el("span", "help", `課題は ${COURSE_LIMITS.tasks} 件までです。完了した課題を消すと、足せます。`));
    d.append(addRow);
    const fa = flowOf(rec, FLOWS);
    if (fa) {
      // 結果待ち (the doctor chose it) becomes a "結果待ち" task; one that cannot be told from 未実施 does not get that kind (the doctor picks)
      const asTask = (w) => (w.kind === "pend" ? { text: `${w.label}の結果`, kind: "result" } : { text: w.label });
      const made = new Set(view.course.tasks.map((k) => k.text));
      const wait = waiting(fa.flow, fa.answers, rec.ed.case).filter((w) => !made.has(asTask(w).text));
      if (wait.length) {
        d.append(el("p", "help", `${out ? "初診" : "救急"}で「結果待ち」を選んだ項目は「結果待ち」の課題に、「結果待ち」か「未実施」か区別できない項目は種類を選ばない課題に、先生が選んで足せます。`));
        const row = el("div", "btn-row");
        for (const w of wait) row.append(btn(`課題にする: ${w.label}`, "btn rec-small", () => mutateAndRender((r) => addTask(r, asTask(w)).rec)));
        d.append(row);
      }
    }

    // 5. the progress note (A06) / the revisit note (A02) for a day (as that day stood)
    d.append(el("h4", "rec-sub", out ? "再診の記載の下書き（外来再診 A02）" : "経過の記載の下書き（病棟の経過 A06）"));
    d.append(el("p", "help", "選んだ日の時点の記録だけから、AI を使わずに組み立てます（その日より後の確度・計画の結果・推移・課題は入りません）。未入力の必須欄は「（未入力）」、日付・患者ID・氏名は空欄です。実際のカルテに貼る前に、先生が確認・修正してください。"));
    const pick = dayPicker(rec, "noteDay", "記載の日", "rec-noteday");
    const pre = el("pre", "note-text rec-note-text rec-progress-text", "");
    const copy = btn("コピー", "btn primary", async () => {
      await copyText(pre.textContent);
      copy.textContent = "コピーしました";
    });
    const copyRow = el("div", "btn-row");
    copyRow.append(copy);
    d.append(pick, pre, copyRow);
    if (out) derived.revisit = { pre, copy };
    else derived.progress = { pre, copy };
    body.append(d);
  }

  /** A select of the days a note can be made for (the days with an entry, and the working day); the choice is kept in S[key]. */
  function dayPicker(rec, key, label, cls) {
    const pick = el("select", cls);
    pick.setAttribute("aria-label", label);
    // a revisit note is for a day after the base day (the base day is the visit before, or the first visit: its note is the first-visit note)
    const days = [...new Set([...rec.course.days.map((x) => x.day), rec.course.today])].filter((n) => !isOutpatient(rec) || n >= 2).sort((a, b) => a - b);
    for (const n of days) pick.append(new Option(dayLabel(n), String(n)));
    pick.value = String(S[key] && days.includes(S[key]) ? S[key] : rec.course.today);
    pick.addEventListener("change", () => {
      S[key] = Number(pick.value);
      renderDerived();
    });
    return pick;
  }
  const pickedDay = (key) => (S[key] && (S.rec.course.days.some((x) => x.day === S[key]) || S[key] === S.rec.course.today) && (!isOutpatient(S.rec) || S[key] >= 2) ? S[key] : S.rec.course.today);

  /** A preview box: the text, and a copy button. */
  function previewBox(cls) {
    const pre = el("pre", `note-text rec-note-text ${cls}`, "");
    const copy = btn("コピー", "btn primary", async () => {
      await copyText(pre.textContent);
      copy.textContent = "コピーしました";
    });
    const row = el("div", "btn-row");
    row.append(copy);
    return { pre, copy, row };
  }

  // ------------------------------------------- the interim summary (A07) and the discharge summary (A08)
  function renderSummaries(rec) {
    const today = rec.course.today;
    // the interim summary / transfer note
    const a = sec("中間サマリー・転棟（A07）", false);
    a.append(el("p", "help", "転棟や引継ぎのときの要約です。「これまでの経過と転換点」には、上の「経過」で転換点としてマーク（★）した日の記録が入ります。下の4つは先生の入力で、日ごとの履歴は持たず、いまの文が使われます。問題・計画・推移・課題は、選んだ日の時点のものだけです（それより後に記録したことは入りません）。"));
    for (const f of SUMMARY_FIELDS) {
      const lab = el("label", "field", f.label);
      const ta = textField("textarea", rec.course.summary[f.key] ?? "", f.max, (v) => mutate((r) => setSummary(r, f.key, v)), f.label, "case-text rec-sum-text");
      ta.dataset.key = f.key;
      lab.append(ta);
      a.append(lab);
    }
    a.append(el("h4", "rec-sub", "中間サマリーの下書き（転棟・中間サマリ A07）"));
    const pickA = dayPicker(rec, "sumDay", "中間サマリーの日", "rec-sumday");
    const boxA = previewBox("rec-interim-text");
    a.append(pickA, boxA.pre, boxA.row);
    derived.interim = boxA;
    body.append(a);

    // the discharge summary: only once the doctor has decided the discharge and its day
    const dc = rec.course.discharge;
    const b = sec("退院時サマリー（A08）", false);
    b.append(el("p", "help", "退院を決めて、退院の日を入れたときだけ、下書きが出ます（記録が終わっただけでは退院になりません）。下書きは、その日の時点の記録だけから作ります（それより後に記録した確度・計画の結果・推移・課題は入りません）。主病名・副病名は、各問題の「退院時サマリーでの扱い」で選びます。選ばなかった問題は「区分を選んでいない問題」として並びます。"));
    const bar = el("div", "rec-daybar");
    const dayIn = el("input", "rec-dc-day");
    dayIn.type = "number";
    dayIn.min = "1";
    dayIn.max = String(COURSE_LIMITS.maxDay);
    dayIn.value = dc.day ? String(dc.day) : "";
    dayIn.placeholder = String(today);
    dayIn.setAttribute("aria-label", "退院の日（入院N日目）");
    dayIn.addEventListener("change", () => {
      const n = dayIn.value === "" ? 0 : Number(dayIn.value);
      if (dayIn.value !== "" && !(Number.isInteger(n) && n >= 1 && n <= COURSE_LIMITS.maxDay)) say(`退院の日は、1〜${COURSE_LIMITS.maxDay} の整数（入院N日目）で入れてください。入れ直すまで、退院は決まっていません。`, "err");
      mutateAndRender((r) => setDischarge(r, { day: n }));
    });
    const decide = btn(dc.decided ? `退院を決めた（${dayLabel(dc.day)}）・取り消す` : `退院を決める（${dayLabel(dc.day ?? today)}）`, "btn rec-small primary", () => mutateAndRender((r) => setDischarge(r, { decided: !dc.decided })));
    decide.dataset.act = "discharge-decide";
    decide.setAttribute("aria-pressed", String(dc.decided));
    bar.append(el("span", "rec-daybar-label", "退院の日 入院"), dayIn, el("span", null, "日目"), decide);
    b.append(bar);
    for (const f of DISCHARGE_FIELDS) {
      const lab = el("label", "field", f.label);
      const ta = textField("textarea", dc[f.key] ?? "", f.max, (v) => mutate((r) => setDischarge(r, { [f.key]: v })), f.label, "case-text rec-dc-text");
      ta.dataset.key = f.key;
      lab.append(ta);
      b.append(lab);
    }
    b.append(el("h4", "rec-sub", "退院時処方（新規・変更・中止・継続と、その理由）"));
    b.append(el("p", "help", "用量・用法は、先生が書いたとおりに入ります（ここでは作りません）。新規・変更・中止・継続のどれかを先生が選びます（選ばなければ「区分未記入」です）。変更・中止は理由を書いてください。"));
    for (const m of dc.meds) b.append(medRow(m));
    const addMedBtn = btn("＋ 処方を足す", "btn rec-small", () => mutateAndRender((r) => addMed(r, {}).rec));
    addMedBtn.disabled = dc.meds.length >= COURSE_LIMITS.meds;
    b.append(addMedBtn);
    if (addMedBtn.disabled) b.append(el("span", "help", `処方は ${COURSE_LIMITS.meds} 件までです。`));
    b.append(el("h4", "rec-sub", "退院時サマリーの下書き（退院時サマリ A08）"));
    const boxB = previewBox("rec-discharge-text");
    b.append(boxB.pre, boxB.row);
    derived.discharge = boxB;
    body.append(b);
  }

  function medRow(m) {
    const row = el("div", "rec-task rec-med");
    row.dataset.m = m.id;
    row.append(textField("textarea", m.text, COURSE_LIMITS.medText, (v) => mutate((r) => setMed(r, m.id, { text: v })), "処方", "case-text rec-entry-text"));
    const meta = el("div", "rec-entry-meta");
    const chips = el("div", "chips rec-state");
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", "処方の扱い");
    for (const c of MED_CHANGES) {
      const bt = el("button", "chip", c.label);
      bt.type = "button";
      bt.dataset.opt = c.id;
      bt.setAttribute("aria-pressed", String(m.change === c.id));
      bt.addEventListener("click", () => mutateAndRender((r) => setMed(r, m.id, { change: m.change === c.id ? "" : c.id })));
      chips.append(bt);
    }
    const why = textField("input", m.reason ?? "", COURSE_LIMITS.medText, (v) => mutate((r) => setMed(r, m.id, { reason: v })), "理由", "rec-reason");
    why.placeholder = "理由（変更・中止のときは書いてください）";
    meta.append(chips, why, btn("削除", "btn rec-small danger", () => mutateAndRender((r) => removeMed(r, m.id))));
    row.append(meta);
    return row;
  }

  function taskRow(k, view) {
    const row = el("div", "rec-task");
    row.dataset.k = k.id;
    row.append(textField("textarea", k.text, 600, (v) => mutate((r) => setTask(r, k.id, { text: v })), "課題", "case-text rec-entry-text"));
    const meta = el("div", "rec-entry-meta");
    const kind = el("select", "rec-kind");
    kind.setAttribute("aria-label", "課題の種類");
    kind.append(new Option("（種類を選ばない）", ""));
    for (const t of TASK_KINDS) kind.append(new Option(t.label, t.id));
    kind.value = k.kind;
    kind.addEventListener("change", () => mutateAndRender((r) => setTask(r, k.id, { kind: kind.value })));
    const prob = el("select", "rec-kind");
    prob.setAttribute("aria-label", "関係する問題");
    prob.append(new Option("（問題を選ばない）", ""));
    for (const p of view.problems) prob.append(new Option(p.label || "（名前なし）", p.id));
    prob.value = k.problem ?? "";
    prob.addEventListener("change", () => mutateAndRender((r) => setTask(r, k.id, { problem: prob.value })));
    const owner = textField("input", k.owner, 60, (v) => mutate((r) => setTask(r, k.id, { owner: v })), "担当者", "rec-reason");
    owner.placeholder = "担当者";
    const due = textField("input", k.due, 60, (v) => mutate((r) => setTask(r, k.id, { due: v })), "期限", "rec-reason");
    due.placeholder = "期限（入院5日目 など）";
    const state = btn(k.state === "done" ? `完了（${dayLabel(k.closed ?? k.added)}）・戻す` : "完了にする", "btn rec-small", () => mutateAndRender((r) => setTask(r, k.id, { state: k.state === "done" ? "open" : "done" })));
    state.dataset.act = "task-state";
    state.setAttribute("aria-pressed", String(k.state === "done"));
    meta.append(kind, prob, owner, due, state, btn("削除", "btn rec-small danger", () => mutateAndRender((r) => removeTask(r, k.id))));
    row.append(meta, el("span", "rec-cite", `${dayLabel(k.added)}に追加`));
    return row;
  }

  // ------------------------------------------- the parts that change while typing: the checks, the identifier warning, the draft
  function renderDerived() {
    casebook.refresh(); // the Casebook part follows the record while it is typed in (drawn again a moment later, unless it is being used)
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
      derived.preview.pre.textContent = toText(admissionNote(S.rec), { aiMark: S.opts.ai, sourceMarks: S.opts.src, soap: S.opts.soap });
      derived.preview.copy.textContent = "コピー";
    }
    const marks = { aiMark: S.opts.ai, sourceMarks: S.opts.src, soap: S.opts.soap }; // the summaries (A07, A08) have no S/O/A/P view: toText leaves them as they are
    if (derived.progress) {
      derived.progress.pre.textContent = toText(progressNote(S.rec, pickedDay("noteDay")), marks);
      derived.progress.copy.textContent = "コピー";
    }
    if (derived.first) {
      const fa = flowOf(S.rec, FLOWS);
      const n = firstVisitNote(S.rec, fa?.flow ?? null);
      derived.first.pre.textContent = n ? toText(n, marks) : "";
      derived.first.copy.textContent = "コピー";
    }
    if (derived.revisit) {
      const day = pickedDay("noteDay");
      derived.revisit.pre.textContent = day >= 2 ? toText(revisitNote(S.rec, day), marks) : "（基準日の次の日以降に、再診の記載の下書きが出ます。上の「基準日から何日後か」で再診の日を選んでください）";
      derived.revisit.copy.disabled = day < 2;
      derived.revisit.copy.textContent = "コピー";
    }
    if (derived.interim) {
      derived.interim.pre.textContent = toText(interimNote(S.rec, pickedDay("sumDay")), marks);
      derived.interim.copy.textContent = "コピー";
    }
    if (derived.discharge) {
      const n = dischargeNote(S.rec);
      derived.discharge.pre.textContent = n ? toText(n, marks) : "（退院を決めて、退院の日を入れると、ここに下書きが出ます）";
      derived.discharge.copy.disabled = !n;
      derived.discharge.copy.textContent = "コピー";
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
    changed();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });

  /** The open record when it is the pinned case's: a record of another case is never summarised for this one. */
  const recordFor = (kase) => (S.rec && S.id && !S.unlinking && !isOutpatient(S.rec) && kase && isRecordCase(S.rec, kase) ? S.rec : null); // the scenes after the admission do not follow an outpatient record

  return {
    open,
    /** the id of the record the pinned case belongs to, or null */
    linked: () => S.id,
    /** whether a record is open for this case (the draft of a scene after the admission can be made) */
    hasRecordFor: (kase) => !!recordFor(kase),
    /**
     * The summary of the open record for a scene's draft (web/record-brief.js): { text, day, truncated, omitted } or null.  Built from the record as it
     * is on the screen now (not what was last saved), as of the day of the scene (record-brief.js briefDay), with what the scene is about.
     */
    brief(scene, kase) {
      const rec = recordFor(kase);
      return rec ? recordBrief(rec, briefDay(rec, scene), { scene }) : null;
    },
    /** told when the open record changes (case.js refreshes the scene choices) */
    onChange: (fn) => listeners.push(fn),
    /**
     * The pinned case was pinned again.  When it belongs to the open record, the record follows it; a different age or sex says it may be
     * another patient: the doctor decides (OK updates this record, cancel lets the record go and keeps the case pinned on its own).
     */
    onCasePinned(kase) {
      if (!S.rec || !S.id || S.unlinking) return;
      const cur = S.rec.ed.case;
      if ((kase.age !== cur.age || kase.sex !== cur.sex) && !confirm("年齢・性別が、この記録の症例と違います。同じ患者の症例を直したのなら［OK］（この記録の症例を更新します）、別の患者なら［キャンセル］（この記録との連動を外します。記録はそのまま残ります）。")) {
        this.onCaseCleared();
        return;
      }
      mutate((r) => setCase(r, kase));
      if (dlg.open) render();
    },
    /** The pinned case was cleared or replaced from somewhere else: the record stays saved and is let go once what is unsaved has been sent. */
    onCaseCleared() {
      if (!S.rec || S.unlinking) return;
      S.unlinking = true;
      markLinked();
      settle().then((ok) => {
        S.unlinking = false;
        reset();
        if (!ok) say("前に開いていた記録の、保存できなかった変更は破棄しました。", "err");
        if (dlg.open) render();
      });
    },
    /**
     * Takes adopted draft items into the record of this case (making the record first when the case has none: the doctor pressed the button).
     * An answer asked with a case this record never had may be another patient's: the doctor is asked.  Returns { ok, added, message }.
     */
    async addAdopted(kase, items) {
      if (S.rec && !isRecordCase(S.rec, kase) && !confirm("この回答は、いま開いている記録の症例とは違う症例で作られています（別の患者の可能性があります）。この記録に取り込みますか？")) {
        return { ok: false, added: 0, message: "取り込みませんでした（別の症例の回答）" };
      }
      if (!S.rec) {
        // a case entered as an outpatient one starts an outpatient record (its first visit); every other starts an admission's
        if (!(await createFrom(kase, kase?.setting === "外来" ? { kind: "outpatient", start: "first" } : {}))) return { ok: false, added: 0, message: S.msg };
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
