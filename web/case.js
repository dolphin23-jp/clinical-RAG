// Case mode screen (docs/enhancement-plan.md 7.2): the "症例" dialog, the one-line bar that keeps the case in view over the
// thread, and the four mode buttons over the composer.  The case lives in the tab's memory only; it is saved on the server
// together with each turn asked with it (conv.js, payload.case) and comes back when that conversation is reopened.
// Every string reaches the DOM through textContent / .value.
import { AGES, FIELDS, MODES, SETTINGS, SEXES, TEXT_KEYS, caseSummary, caseTexts, cleanCase, emptyCase, isEmptyCase } from "./case-model.js";
import { relativizeDates } from "./date-relative.js";
import { scan } from "./id-guard.js";
import { bindDates, changesNote, initIntake } from "./intake-ui.js";

export function initCase(ctx) {
  const { el, $, openDialog, runMode } = ctx;
  const dlg = $("#case");
  const host = $("#case-fields");
  const bar = $("#casebar");
  const modes = $("#case-modes");
  const warn = $("#case-warn");
  const msg = $("#case-msg");
  let current = null; // the pinned case (cleaned) or null
  let attach = true; // free questions carry the pinned case while this is on (the mode buttons always do)

  // ---------------------------------------------------------------- the dialog's fields
  const inputs = {};
  const choice = (key, label, list) => {
    const wrap = el("div", "case-choice");
    const id = `case-${key}`;
    const lab = el("label", "field", label);
    lab.htmlFor = id;
    const sel = el("select");
    sel.id = id;
    sel.append(new Option("（選ばない）", ""));
    for (const v of list) sel.append(new Option(v, v));
    wrap.append(lab, sel);
    inputs[key] = sel;
    return wrap;
  };
  const row = el("div", "case-row");
  row.append(choice("age", "年代", AGES), choice("sex", "性別", SEXES), choice("setting", "場面", SETTINGS));
  host.append(row);
  // the scene x symptom questions (web/intake-ui.js); the sex in the select above decides which sex-specific questions show
  const intake = initIntake({ el, host, context: () => ({ sex: inputs.sex.value }), onChange: () => showWarn() });
  inputs.sex.addEventListener("change", () => intake.refresh());
  const dateMsg = el("p", "help", "");
  dateMsg.setAttribute("role", "status");
  host.append(dateMsg);
  for (const f of FIELDS) {
    const id = `case-${f.key}`;
    const lab = el("label", "field", f.label);
    lab.htmlFor = id;
    const ta = el("textarea", "case-text");
    ta.id = id;
    ta.rows = f.rows;
    ta.maxLength = f.max;
    ta.placeholder = f.placeholder;
    ta.setAttribute("autocomplete", "off");
    bindDates(ta, (changes) => (dateMsg.textContent = changesNote(changes)));
    inputs[f.key] = ta;
    host.append(lab, ta);
    if (f.key === "own") host.append(el("p", "help", "書くと、アセスメントとプラン（草案）に「先生の案との差」が付き、鑑別と反証には「先生の見立てへの反証」が付きます。正誤や点数は付けません。書かなくても草案は作れます。"));
  }

  const read = () => {
    const c = emptyCase();
    for (const k of Object.keys(inputs)) c[k] = inputs[k].value;
    Object.assign(c, intake.value());
    return cleanCase(c);
  };
  const fill = (c) => {
    for (const k of Object.keys(inputs)) inputs[k].value = c?.[k] ?? "";
    dateMsg.textContent = "";
    if (c?.structured) {
      intake.restore(c).then(() => {
        if (c.intake) intake.show();
        showWarn();
      });
    } else intake.clear();
    showWarn();
  };

  // identifier-like text is flagged as the doctor types (kinds only, never the matched text); the send-time check still applies
  function showWarn() {
    const labels = new Set();
    for (const t of caseTexts(read())) for (const h of scan(t)) labels.add(h.label);
    warn.hidden = !labels.size;
    warn.textContent = labels.size ? `患者を特定できる情報の可能性があります（${[...labels].join("、")}）。氏名・ID などは入れないでください。送るときにもう一度確認します。` : "";
  }
  host.addEventListener("input", showWarn);

  // ---------------------------------------------------------------- pin / clear
  $("#case-pin").addEventListener("click", () => {
    const c = read();
    if (isEmptyCase(c)) {
      msg.hidden = false;
      msg.textContent = "主訴と経過・バイタル・所見・既往・場面ごとの質問のどれかを入力してください。";
      return;
    }
    // no calendar date is kept: whatever was typed (not only pasted) becomes "N日前" / "入院N日目" now
    for (const k of TEXT_KEYS) c[k] = relativizeDates(c[k]).text;
    msg.hidden = true;
    current = c;
    attach = true;
    refresh();
    dlg.close();
  });
  $("#case-clear").addEventListener("click", () => {
    clear();
    dlg.close();
  });
  $("#btn-case").addEventListener("click", () => openEditor());
  $("#casebar-open").addEventListener("click", () => openEditor());
  const attachBox = $("#casebar-attach");
  attachBox.addEventListener("change", () => {
    attach = attachBox.checked;
    refresh();
  });

  function openEditor() {
    msg.hidden = true;
    if (current) fill(current);
    openDialog(dlg);
  }

  // ---------------------------------------------------------------- the bar and the mode buttons
  for (const m of MODES) {
    const b = el("button", "chip mode", m.label);
    b.type = "button";
    b.dataset.mode = m.id;
    b.addEventListener("click", () => runMode(m.id));
    modes.append(b);
  }
  function refresh() {
    bar.hidden = !current;
    modes.hidden = !current;
    document.body.classList.toggle("has-case", !!current);
    attachBox.checked = attach;
    $("#casebar-text").textContent = current ? caseSummary(current) : "";
    bar.classList.toggle("detached", !!current && !attach);
  }

  function clear() {
    current = null;
    attach = true;
    fill(emptyCase());
    refresh();
  }

  refresh();
  return {
    /** the pinned case, or null */
    pinned: () => (current ? { ...current } : null),
    /** the case a free question carries: the pinned one, unless the doctor switched it off */
    attached: () => (current && attach ? { ...current } : null),
    /** pin a case read back from a saved conversation */
    set(c) {
      const cleaned = cleanCase(c);
      if (isEmptyCase(cleaned)) return clear();
      current = cleaned;
      attach = true;
      fill(cleaned);
      refresh();
    },
    clear,
    setBusy(b) {
      for (const x of modes.querySelectorAll("button")) x.disabled = b;
    },
  };
}
