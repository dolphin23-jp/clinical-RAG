// Case mode screen (docs/enhancement-plan.md 7.2): the "症例" dialog, the one-line bar that keeps the case in view over the
// thread, and the four mode buttons over the composer.  The case lives in the tab's memory only; it is saved on the server
// together with each turn asked with it (conv.js, payload.case) and comes back when that conversation is reopened.
// Every string reaches the DOM through textContent / .value.
import { AGE_MAX, FIELDS, MODES, SETTINGS, SEXES, SYNTHETIC_MARK, TEXT_KEYS, caseSummary, caseTexts, cleanCase, emptyCase, isEmptyCase, readAge } from "./case-model.js";
import { relativizeDates } from "./date-relative.js";
import { SCENES, SCENE_LABELS, briefNeed } from "./draft-scenes.js";
import { scan } from "./id-guard.js";
import { bindDates, changesNote, initIntake } from "./intake-ui.js";

export function initCase(ctx) {
  const { el, $, openDialog, runMode, api } = ctx;
  const dlg = $("#case");
  const host = $("#case-fields");
  const bar = $("#casebar");
  const modes = $("#case-modes");
  const warn = $("#case-warn");
  const msg = $("#case-msg");
  const hooks = { pinned: null, cleared: null }; // the case record follows the pinned case (record-ui.js)
  // the scene of the assessment/plan draft and the summary of the open record that a scene after the admission takes (docs/enhancement-plan.md 8.16)
  const sceneRow = $("#case-scene");
  const sceneSel = $("#scene-select");
  const sceneHelp = $("#scene-help");
  const briefBox = $("#scene-brief");
  const briefPre = $("#scene-brief-text");
  const record = { linked: () => false, brief: () => null }; // set by app.js (the open record's summary for a scene, or null)
  let current = null; // the pinned case (cleaned) or null
  let synthetic = false; // the case in the editor is a fictional one (it came from the simulation or a created case): kept through edits until cleared
  let attach = true; // free questions carry the pinned case while this is on (the mode buttons always do)

  // ---------------------------------------------------------------- the fictional mark (D7): shown, and the doctor can take it off
  const synRow = el("div", "notice case-synthetic");
  synRow.id = "case-synthetic";
  synRow.hidden = true;
  const synOff = el("button", "btn small", "架空の印を外す");
  synOff.type = "button";
  synOff.id = "case-synthetic-off";
  synOff.addEventListener("click", () => {
    synthetic = false;
    synRow.hidden = true;
    if (current?.synthetic) {
      const { synthetic: _off, ...rest } = current;
      current = rest;
      refresh();
    }
  });
  synRow.append(el("span", null, `${SYNTHETIC_MARK} この症例は、架空症例の模擬・作成から来た架空の症例です（回答の様子の数には入れず、症例の記録・Casebook でも架空として扱います）。実在の患者の入力に書き換えるときは、印を外してください。`), synOff);
  host.before(synRow);
  const showSynthetic = () => (synRow.hidden = !synthetic);

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
  // the age is whole years, typed (the doctor's decision of 2026-10-25: the Casebook packet needs the age in years); an infant under one year is 0
  const ageField = () => {
    const wrap = el("div", "case-choice");
    const lab = el("label", "field", "年齢（歳）");
    lab.htmlFor = "case-age";
    const inp = el("input");
    inp.id = "case-age";
    inp.type = "text";
    inp.inputMode = "numeric";
    inp.maxLength = 8;
    inp.size = 6;
    inp.placeholder = "例: 72（乳児は 0）";
    inp.setAttribute("autocomplete", "off");
    wrap.append(lab, inp);
    inputs.age = inp;
    return wrap;
  };
  const row = el("div", "case-row");
  row.append(ageField(), choice("sex", "性別", SEXES), choice("setting", "場面", SETTINGS));
  host.append(row);
  // the scene x symptom questions (web/intake-ui.js); the sex in the select above decides which sex-specific questions show
  const intake = initIntake({ el, host, context: () => ({ sex: inputs.sex.value }), onChange: () => showWarn(), api });
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
    if (synthetic) c.synthetic = true;
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
    if (!readAge(inputs.age.value).ok) {
      msg.hidden = false;
      msg.textContent = `年齢は 0〜${AGE_MAX} の整数（歳）で入れてください。乳児は 0 です。`;
      inputs.age.focus();
      return;
    }
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
    hooks.pinned?.(current);
    // the record follows the case only now (it takes this version of the case as its own): the scene choices are looked at again after that
    refreshScene();
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
    showSynthetic();
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
  // ---------------------------------------------------------------- the scene of the draft
  sceneSel.append(new Option("共通の見出し（場面を選ばない）", ""));
  for (const id of SCENES) sceneSel.append(new Option(SCENE_LABELS[id], id));
  sceneSel.addEventListener("change", () => refreshScene());
  briefBox.addEventListener("toggle", () => briefBox.open && refreshScene());

  /** The summary this scene would take now (null when it takes none or no record is open).  Built when asked: it is not kept. */
  const briefFor = (scene) => (scene && briefNeed(scene) !== "none" ? record.brief(scene, current) : null);

  function refreshScene() {
    sceneRow.hidden = !current;
    if (!current) return;
    const linked = record.linked(current);
    for (const o of sceneSel.options) o.disabled = !!o.value && briefNeed(o.value) === "record" && !linked; // these cannot be made without the record
    if (sceneSel.selectedOptions[0]?.disabled) sceneSel.value = "";
    const scene = sceneSel.value;
    const need = scene ? briefNeed(scene) : "none";
    const brief = linked && need !== "none" ? briefFor(scene) : null;
    if (!scene) sceneHelp.textContent = "「アセスメントとプラン（草案）」だけに効きます。場面を選ぶと、その場面の読み手と目的に合わせた見出しで作ります（共通の見出しのままでも作れます）。";
    else if (need === "none") sceneHelp.textContent = `${SCENE_LABELS[scene]}の見出しで作ります。症例の記録の要約は渡しません。`;
    else if (brief) sceneHelp.textContent = `${SCENE_LABELS[scene]}の見出しで作ります。開いている症例の記録（入院${brief.day}日目の時点）の要約を、症例に添えて送ります。送る内容は下で確認できます。${brief.truncated ? ` 長いため、${[brief.omitted ? `優先順位の低い問題 ${brief.omitted} 件は渡さず` : "", brief.omittedLines ? `末尾の ${brief.omittedLines} 行は渡さず` : ""].filter(Boolean).join("、")}${brief.omitted || brief.omittedLines ? "、" : ""}文を短くしています。` : ""}`;
    else if (need === "optional") sceneHelp.textContent = `${SCENE_LABELS[scene]}の見出しで作ります。症例の記録を開いていないので、症例だけで作ります。`;
    else sceneHelp.textContent = `${SCENE_LABELS[scene]}の草案には、症例の記録が要ります。「記録」を開いてから選んでください。`;
    briefBox.hidden = !brief;
    briefPre.textContent = brief && briefBox.open ? brief.text : "";
  }

  function refresh() {
    refreshScene();
    bar.hidden = !current;
    modes.hidden = !current;
    document.body.classList.toggle("has-case", !!current);
    attachBox.checked = attach;
    $("#casebar-text").textContent = current ? `${current.synthetic ? SYNTHETIC_MARK : ""}${caseSummary(current)}` : "";
    bar.classList.toggle("detached", !!current && !attach);
  }

  function clear() {
    const had = !!current;
    current = null;
    synthetic = false;
    showSynthetic();
    attach = true;
    fill(emptyCase());
    refresh();
    if (had) hooks.cleared?.();
  }

  refresh();
  return {
    /** the pinned case, or null */
    pinned: () => (current ? { ...current } : null),
    /** the case a free question carries: the pinned one, unless the doctor switched it off */
    attached: () => (current && attach ? { ...current } : null),
    /** pin a case read back from a saved conversation */
    set(c, { keepLink = false } = {}) {
      const cleaned = cleanCase(c);
      if (isEmptyCase(cleaned)) return clear();
      if (!keepLink) hooks.cleared?.(); // a case that comes from somewhere else (a conversation, a created case) is not the open record's
      synthetic = cleaned.synthetic === true;
      showSynthetic();
      current = cleaned;
      attach = true;
      fill(cleaned);
      refresh();
    },
    clear,
    /** record-ui.js: told when a case is pinned (again) and when the pinned case is cleared */
    onPinned: (fn) => (hooks.pinned = fn),
    onCleared: (fn) => (hooks.cleared = fn),
    /** The scene chosen for the assessment/plan draft ("" = the common headings). */
    scene: () => (current && !sceneSel.selectedOptions[0]?.disabled ? sceneSel.value : ""),
    /** The summary of the open record for the chosen scene: { text, day, truncated, omitted } or null.  Built now, from the record as it is. */
    brief: () => briefFor(current ? sceneSel.value : ""),
    /** app.js: where the open record's summary comes from (linked(kase): a record is open for this case; brief(scene, kase): its summary). */
    setRecord(r) {
      record.linked = r.linked;
      record.brief = r.brief;
      refreshScene();
    },
    /** The open record changed (opened, made, let go, edited and closed): the scene choices and the summary shown follow it. */
    refreshScene,
    /** Says why a request was not sent (the choices are brought up to date first, then the words stay in place of the help). */
    notice(text) {
      refreshScene();
      sceneHelp.textContent = text;
    },
    setBusy(b) {
      for (const x of modes.querySelectorAll("button")) x.disabled = b;
    },
  };
}
