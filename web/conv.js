// Saved conversations (docs/clinical-use.md 1d): every finished turn is saved to the server (D1) so a conversation
// survives closing or reloading the app, and the "会話" dialog lists them, reopens one, deletes one or all, and jumps
// to any question of the open conversation.  A question the doctor confirmed through the identifier check is not saved.
// All text from the server is put on screen with textContent.

const newId = () => {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
};

const fmtDate = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export function initConversations(ctx) {
  const { api, el, $, openDialog, S, openConversation, scrollToTurn } = ctx;
  const dlg = $("#convs");
  const paneHere = $("#pane-here");
  const paneSaved = $("#pane-saved");
  let retentionDays = null;

  for (const tab of dlg.querySelectorAll("[role=tab]")) {
    tab.addEventListener("click", () => select(tab.id === "tab-saved" ? "saved" : "here"));
  }
  function select(which) {
    dlg.querySelector("#tab-here").setAttribute("aria-selected", String(which === "here"));
    dlg.querySelector("#tab-saved").setAttribute("aria-selected", String(which === "saved"));
    paneHere.hidden = which !== "here";
    paneSaved.hidden = which !== "saved";
    if (which === "here") renderHere();
    else loadSaved();
  }
  $("#btn-convs").addEventListener("click", () => {
    select("here");
    openDialog(dlg);
  });

  const btn = (label, cls = "btn") => {
    const b = el("button", cls, label);
    b.type = "button";
    return b;
  };

  // ------------------------------------------------------------ this conversation: jump to a question
  function renderHere() {
    paneHere.replaceChildren();
    const turns = [...document.querySelectorAll("#thread .turn")];
    if (!turns.length) {
      paneHere.append(el("p", "help", "まだ質問がありません。"));
      return;
    }
    paneHere.append(el("p", "help", `この会話の質問 ${turns.length} 件。押すと、その質問の位置へ移ります。`));
    const ol = el("ol", "qjump");
    turns.forEach((t, i) => {
      const q = t.querySelector(".q");
      const text = (q?.lastChild?.textContent || "").replace(/\s+/g, " ").trim();
      const b = btn(`${i + 1}. ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`, "hit");
      b.addEventListener("click", () => {
        dlg.close();
        scrollToTurn(t);
      });
      const li = el("li");
      li.append(b);
      ol.append(li);
    });
    paneHere.append(ol);
  }

  // ------------------------------------------------------------ saved conversations
  async function loadSaved() {
    paneSaved.replaceChildren(el("p", "help", "読み込んでいます…"));
    try {
      const res = await api("/api/conversations");
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      retentionDays = j.retention_days;
      renderSaved(j.conversations || []);
    } catch (e) {
      paneSaved.replaceChildren(el("div", "notice err", e.message || "読み込めませんでした。"));
    }
  }

  function renderSaved(list, note) {
    paneSaved.replaceChildren();
    if (note) paneSaved.append(el("div", "notice" + (note.err ? " err" : ""), note.text));
    paneSaved.append(
      el(
        "p",
        "help",
        `サーバーに保存されています（この iPad の外）。${retentionDays ? `最後のやりとりから ${retentionDays} 日で自動的に消えます。` : "自分で消すまで残ります。"}識別情報の確認を通した質問は保存されません。`,
      ),
    );
    if (!list.length) {
      paneSaved.append(el("p", null, "保存された会話はありません。"));
      return;
    }
    const ul = el("ul", "convlist");
    for (const c of list) {
      const li = el("li", "conv");
      li.dataset.id = c.id;
      const open = btn("", "conv-open");
      open.append(el("span", "conv-title", c.title || "（無題）"), el("small", null, `${fmtDate(c.updated_at)}・${c.turns} 往復`));
      open.addEventListener("click", async () => {
        open.disabled = true;
        try {
          const res = await api(`/api/conversations/${encodeURIComponent(c.id)}`);
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          dlg.close();
          openConversation(data);
        } catch (e) {
          open.disabled = false;
          renderSaved(list, { err: true, text: e.message || "開けませんでした。" });
        }
      });
      const del = btn("削除", "btn");
      del.setAttribute("aria-label", `${c.title} を削除`);
      del.addEventListener("click", async () => {
        if (!confirm(`この会話をサーバーから削除しますか？\n${c.title}`)) return;
        try {
          const res = await api(`/api/conversations/${encodeURIComponent(c.id)}`, { method: "DELETE" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          if (S.convId === c.id) S.convId = null; // the open conversation keeps its text on screen; its next turn starts a new saved one
          loadSaved();
        } catch (e) {
          renderSaved(list, { err: true, text: e.message || "削除できませんでした。" });
        }
      });
      li.append(open, del);
      ul.append(li);
    }
    paneSaved.append(ul);
    const all = btn("すべて削除");
    all.id = "conv-delete-all";
    all.addEventListener("click", async () => {
      if (!confirm(`保存した会話 ${list.length} 件を、すべてサーバーから削除します。元に戻せません。`)) return;
      try {
        const res = await api("/api/conversations", { method: "DELETE" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        S.convId = null;
        loadSaved();
      } catch (e) {
        renderSaved(list, { err: true, text: e.message || "削除できませんでした。" });
      }
    });
    const row = el("div", "btn-row");
    row.append(all);
    paneSaved.append(row);
  }

  // ------------------------------------------------------------ saving a finished turn
  const setNote = (turn, text, err = false) => {
    if (!turn.saveNote) return;
    turn.saveNote.textContent = text;
    turn.saveNote.classList.toggle("err", err);
  };

  /** payload: { kind: "final" | "degraded", ... } as stored by the Worker (worker/src/convstore.ts) */
  async function saveTurn(turn, payload) {
    if (turn.restored) return;
    if (turn.ack) {
      setNote(turn, "識別情報の確認を通した質問のため、保存していません");
      return;
    }
    const id = (S.convId ||= newId());
    try {
      const res = await api(`/api/conversations/${encodeURIComponent(id)}/turns`, {
        method: "POST",
        body: JSON.stringify({ question: turn.question, answer: turn.answer || turn.raw || "", payload }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setNote(turn, "保存済み");
    } catch (e) {
      setNote(turn, `保存できませんでした（${(e.message || "").slice(0, 60)}）`, true);
    }
  }

  return { saveTurn };
}
