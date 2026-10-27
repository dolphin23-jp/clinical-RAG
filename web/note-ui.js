// Chart-note draft screen (docs/enhancement-plan.md 7.3).  Two parts: a tick ("採用") on each item of an assessment/plan draft
// (only under the sections that are chart content), and the "記載の下書き" dialog that shows the note put together from the typed
// case and the ticked items (web/note-assemble.js) and copies it as plain text.  Everything is read-only and in the tab's memory:
// nothing is sent, saved, exported, printed or shared, and a ticked item enters the note only because the doctor ticked it.
// Every string reaches the DOM through textContent.
import { AI_MARK, ENABLED, assemble, hasSoapView, headingRole, isNoneLine, toText } from "./note-assemble.js";
import { routingSummary } from "./note-route.js";
import { NOTE_TYPES } from "./note-types.js";

/** Text of a node without its nested lists and the tick itself; source tags keep their brackets; citation chips become keys. */
function ownContent(node) {
  let text = "";
  const keys = [];
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) text += c.textContent;
      else if (c.nodeType === 1) {
        if (c.matches("ul, ol, .adopt")) continue;
        if (c.matches(".cites")) {
          for (const b of c.querySelectorAll("[data-cite]")) keys.push(b.dataset.cite);
        } else if (c.tagName === "BR") text += " ";
        else if (c.matches(".src-tag")) text += `[${c.textContent}]`;
        else walk(c);
      }
    }
  };
  walk(node);
  return { text: text.replace(/\s+/g, " ").trim(), keys: [...new Set(keys)] };
}

export function initNotes(ctx) {
  const { el, $, openDialog, copyText, toRecord } = ctx;
  const dlg = $("#note");
  const pick = $("#note-type");
  const optAi = $("#note-opt-ai");
  const optSrc = $("#note-opt-src");
  const optSoap = $("#note-opt-soap");
  const pre = $("#note-text");
  const info = $("#note-info");
  const copyBtn = $("#note-copy");
  const itemData = new WeakMap(); // tick's container element -> { role, heading, text, keys }
  let current = null; // { kase, items(): adopted items, label, flow: the structure of the flow the case's answers came from, or null }

  for (const id of ENABLED) {
    const t = NOTE_TYPES[id];
    if (t) pick.append(new Option(`${t.id} ${t.title}`, t.id));
  }

  // ---------------------------------------------------------------- the ticks on a draft
  function tick(host, data, onChange) {
    const label = el("label", "adopt");
    const box = el("input");
    box.type = "checkbox";
    box.setAttribute("aria-label", `採用: ${data.text.slice(0, 24)}`);
    label.append(box, el("span", null, "採用"));
    box.addEventListener("change", () => {
      host.classList.toggle("adopted", box.checked);
      onChange();
    });
    itemData.set(host, data);
    return label;
  }

  /** Adds a tick to every item under the sections of this answer that are chart content; returns nothing, state lives in the DOM. */
  function decorate(turn) {
    if (turn.mode !== "assess" || !turn.case) return;
    const button = el("button", "note-open", "記載の下書きを作る（採用 0 件）");
    button.type = "button";
    const count = () => turn.body.querySelectorAll(".adopt input:checked").length;
    const onChange = () => (button.textContent = `記載の下書きを作る（採用 ${count()} 件）`);
    const cite = (keys) => keys.map((k) => turn.cites.get(k)).filter(Boolean).map((c) => ({ kind: c.kind, title: c.title, page: c.page, url: c.url }));
    for (const sec of turn.body.querySelectorAll("details.sec")) {
      const heading = sec.querySelector("summary")?.textContent ?? "";
      const role = headingRole(heading);
      if (!role) continue;
      // `scene`: which scene's draft the item came from (the record marks a problem "from the emergency" only for the emergency scene)
      const add = (host, text, keys) => {
        if (!text || isNoneLine(text)) return;
        host.append(tick(host, { role, heading, text, cites: cite(keys), scene: turn.scene || "" }, onChange));
      };
      for (const node of sec.children) {
        if (node.tagName === "P") {
          const { text, keys } = ownContent(node);
          add(node, text, keys);
        } else if (node.tagName === "UL" || node.tagName === "OL") {
          for (const li of node.querySelectorAll("li")) {
            const { text, keys } = ownContent(li);
            add(li, text, keys);
          }
        } else if (node.matches(".tbl")) {
          const heads = [...node.querySelectorAll("thead th")].map((th) => ownContent(th).text);
          node.querySelector("thead tr")?.append(el("th"));
          for (const tr of node.querySelectorAll("tbody tr")) {
            const cells = [...tr.children].map((td) => ownContent(td));
            const text = cells.map((c, i) => (c.text ? `${heads[i] ? heads[i] + ": " : ""}${c.text}` : "")).filter(Boolean).join(" / ");
            const td = el("td", "adopt-cell");
            tr.append(td);
            if (text) {
              const keys = cells.flatMap((c) => c.keys);
              td.append(tick(tr, { role, heading, text, cites: cite(keys), scene: turn.scene || "" }, onChange));
            }
          }
        }
      }
    }
    button.addEventListener("click", () =>
      open({
        kase: turn.case,
        label: `この回答（採用 ${count()} 件）`,
        items: () => [...turn.body.querySelectorAll(".adopt input:checked")].map((b) => itemData.get(b.closest("li, p, tr"))).filter(Boolean),
      }),
    );
    turn.foot.append(button);
    if (toRecord) {
      // the doctor's act: the adopted items are taken into this case's record (made if the case has none); nothing is carried further by itself
      const take = el("button", "record-add", "症例の記録へ");
      take.type = "button";
      take.addEventListener("click", async () => {
        const items = [...turn.body.querySelectorAll(".adopt input:checked")].map((b) => itemData.get(b.closest("li, p, tr"))).filter(Boolean);
        if (!items.length) {
          take.textContent = "先に項目を「採用」してください";
          setTimeout(() => (take.textContent = "症例の記録へ"), 2500);
          return;
        }
        take.disabled = true;
        const r = await toRecord(turn.case, items);
        take.disabled = false;
        take.textContent = r.ok ? `記録に取り込みました（新しく ${r.added} 件）` : r.message || "取り込めませんでした";
        setTimeout(() => (take.textContent = "症例の記録へ"), 3500);
      });
      turn.foot.append(take);
    }
  }

  // ---------------------------------------------------------------- the dialog
  function render() {
    if (!current) return;
    const note = assemble(pick.value, { kase: current.kase, items: current.items(), flow: current.flow });
    // the S/O/A/P view is offered for the encounter notes only (a summary, a consult and a handover are not SOAP notes)
    optSoap.disabled = !hasSoapView(pick.value);
    pre.textContent = toText(note, { aiMark: optAi.checked, sourceMarks: optSrc.checked, soap: optSoap.checked && !optSoap.disabled });
    const t = NOTE_TYPES[pick.value];
    const lines = [`${current.label}。採用した草案の項目だけが入ります（採用していない項目は入りません）。`];
    if (note.unfilled.length) lines.push(`未入力の必須欄 ${note.unfilled.length} 個は「（未入力）」のままです。`);
    if (note.unplaced) lines.push(`この型には、採用した ${note.unplaced} 件を入れる欄がありません。別の型を選ぶと入ることがあります。`);
    if (note.routing) lines.push(routingSummary(note.routing));
    lines.push(`型: ${t.id} ${t.title} v${t.version}（${t.status}）。欄の名前と順序だけを clinical-modules から取り込んでいます。`);
    info.textContent = lines.join(" ");
    copyBtn.textContent = "コピー";
  }
  /** The structure of the flow the case's answers came from (loaded on demand: it is large), or null when there is none or it cannot be loaded. */
  async function loadFlow(kase) {
    const id = kase?.intake?.flow;
    if (!id) return null;
    try {
      return (await import("./flow-schema.js")).FLOWS[id] ?? null;
    } catch {
      return null;
    }
  }
  async function open(c) {
    current = c;
    current.flow = await loadFlow(c.kase);
    if (current !== c) return; // closed (or another note opened) while the flow loaded
    render();
    openDialog(dlg);
  }
  for (const x of [pick, optAi, optSrc, optSoap]) x.addEventListener("change", render);
  copyBtn.addEventListener("click", async () => {
    await copyText(pre.textContent);
    copyBtn.textContent = "コピーしました";
  });
  dlg.addEventListener("close", () => {
    current = null;
    pre.textContent = "";
  });
  // the AI mark's name is shown in the option label so the doctor sees what "keep the mark" means
  $("#note-opt-ai-name").textContent = AI_MARK;

  return { decorate, open };
}
