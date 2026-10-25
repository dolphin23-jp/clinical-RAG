// The "Casebook へ送る（試作）" part of the case record screen (docs/enhancement-plan.md 8.17; the doctor's decision of 2026-10-25,
// docs/clinical-use.md 1f).  Shows what the record can hand over, lets the doctor tick items, makes the packet (web/casebook-packet.js,
// pure) and copies it to the clipboard.  Nothing is sent over the network: Casebook is another origin, the packet travels by the clipboard
// and the doctor's paste (Casebook's contract, 5b).  A mark "sent" is written to the record only when the doctor says Casebook took the
// packet in; copying it is not a mark.  What is ticked, typed here and the packet itself live in this tab's memory only.
// Every string reaches the DOM through textContent / .value.
import { readAge } from "./case-model.js";
import { GROUPS, MAX_ITEMS, NOT_SENT, SETTING_OUT, SOURCE_LABEL, buildPacket, candidates, patientDefaults, stateOf, ticked, ulidFrom } from "./casebook-packet.js";
import { CODE_RE, ensureSeed, markSent, normalizeCode, resetCasebook, setCode } from "./casebook-state.js";

const SEX_OPTIONS = [
  ["M", "男性"],
  ["F", "女性"],
  ["other", "その他・不明"],
];
const randomBytes = (n) => {
  const b = new Uint8Array(n);
  try {
    if (globalThis.crypto?.getRandomValues) return globalThis.crypto.getRandomValues(b);
  } catch {
    /* fall through */
  }
  for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
  return b;
};
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

const outHead = (o) =>
  `${o.count} 項目のパケットを作りました。${o.copied === true ? "クリップボードにコピーしました。" : o.copied === false ? "コピーできませんでした。下の欄の文字を選んで、手でコピーしてください。" : "クリップボードにコピーしています…"}`;

export function initCasebook(ctx) {
  const { el, copyText } = ctx;
  const fresh = () => ({ id: null, sel: new Map(), mode: "", age: null, sex: null, setting: null, synthetic: null, code: null, out: null, note: "" });
  const M = fresh();
  const live = { box: null, redraw: null, getRec: null, shown: "", timer: null }; // the part now on the screen (not reset with the choices)

  /**
   * Draws the part into `box`.  `getRec()` is the open record now; `mutate(fn)` changes it through the record screen (which saves and draws
   * again, and so calls this again with the same state).
   */
  function draw(box, { getRec, id, mutate }) {
    if (M.id !== id) Object.assign(M, fresh(), { id });
    const rec = getRec();
    const cb = rec.casebook;
    box.replaceChildren();
    const redraw = () => draw(box, { getRec, id, mutate });

    const mode = M.mode || (cb.code ? "append" : "new");
    const defaults = patientDefaults(rec);
    const all = candidates(rec);
    // what is ticked: the doctor's own choice, else the default (not sent yet, nothing stops it, not from the AI)
    const on = (r, c) => (M.sel.has(c.key) ? M.sel.get(c.key) : ticked(r, c));
    const selectable = (r, c) => c.blockers.length === 0 && stateOf(r, c) !== "sent";
    const chosen = (r = rec, list = all) => list.filter((c) => selectable(r, c) && on(r, c));
    // typing in the record does not draw this part again (the focus of the field being typed in must stay), so what it shows can be older than
    // the record: the packet is made only from what is on the screen (the list is compared again when the button is pressed)
    const shown = signature(all);
    Object.assign(live, { box, redraw, getRec, shown });

    box.append(
      el("p", "help", "この記録の内容から、Casebook（症例の長期保存と J-OSLER の準備のアプリ）に取り込む「受け渡しパケット」を作ります。通信はしません。パケットの文字をクリップボードにコピーし、Casebook の一覧の「Playbook から受け取る」か貼り付け欄に貼って、Casebook の確認画面で「取り込む」を押します。"),
      el("p", "help", "送るのは、ここで選んだ項目だけです。AI の草案から採用した項目には印が付き、初めは選ばれていません（Casebook の確認画面でも初めは選ばれません）。日付・氏名・ID の入った項目は送れません。外来の症例は受診日が要るため送れません。"),
    );
    const notSent = el("details", "cb-notsent");
    notSent.append(el("summary", null, "このパケットに入らないもの"));
    const nl = el("ul", "help");
    for (const t of NOT_SENT) nl.append(el("li", null, t));
    notSent.append(nl);
    box.append(notSent);

    // ------------------------------------------------ where it goes
    const target = el("fieldset", "cb-target");
    target.append(el("legend", null, "送り先"));
    const radio = (name, value, label, checked, onPick) => {
      const l = el("label", "cb-radio");
      const r = el("input");
      r.type = "radio";
      r.name = name;
      r.value = value;
      r.checked = checked;
      r.addEventListener("change", () => {
        if (r.checked) onPick();
      });
      l.append(r, el("span", null, label));
      return l;
    };
    const newBlock = el("div", "cb-block");
    const appendBlock = el("div", "cb-block");
    const showMode = (m) => {
      M.mode = m;
      newBlock.hidden = m !== "new";
      appendBlock.hidden = m !== "append";
    };
    const modeRow = el("div", "cb-modes");
    const rNew = radio("cb-mode", "new", "新しい症例として送る", mode === "new", () => showMode("new"));
    rNew.querySelector("input").id = "cb-mode-new";
    const rApp = radio("cb-mode", "append", "Casebook の既存の症例に追加する", mode === "append", () => showMode("append"));
    rApp.querySelector("input").id = "cb-mode-append";
    modeRow.append(rNew, rApp);
    target.append(modeRow);

    // new case: the patient block and the real / fictional choice
    const field = (label, control, hint) => {
      const w = el("div", "cb-field");
      const l = el("label", "field", label);
      l.htmlFor = control.id;
      w.append(l, control);
      if (hint) w.append(el("p", "help", hint));
      return w;
    };
    const age = el("input");
    age.id = "cb-age";
    age.type = "text";
    age.inputMode = "numeric";
    age.maxLength = 4;
    age.size = 6;
    age.setAttribute("autocomplete", "off");
    age.value = M.age ?? (defaults.ageYears === null ? "" : String(defaults.ageYears));
    age.addEventListener("input", () => (M.age = age.value));
    const sex = el("select");
    sex.id = "cb-sex";
    sex.append(new Option("（選ぶ）", ""));
    for (const [v, l] of SEX_OPTIONS) sex.append(new Option(l, v));
    sex.value = M.sex ?? defaults.sex ?? "";
    sex.addEventListener("change", () => (M.sex = sex.value));
    const setting = el("select");
    setting.id = "cb-setting";
    setting.append(new Option("（選ぶ）", ""));
    for (const s of SETTING_OUT) setting.append(new Option(s.label, s.id));
    setting.value = M.setting ?? defaults.setting ?? "";
    setting.addEventListener("change", () => (M.setting = setting.value));
    const who = el("div", "cb-patient");
    who.append(
      field("年齢（歳）", age, rec.ed.case.age && defaults.ageYears === null ? "症例の年齢が歳の整数の形ではありません。歳の整数を入れてください。" : undefined),
      field("性別", sex),
      field("場面", setting, rec.ed.case.setting === "外来" ? "外来の症例は受診日（暦日）が要るため、ここからは送れません。" : undefined),
    );
    newBlock.append(who);
    const synth = el("fieldset", "cb-synth");
    synth.append(el("legend", null, "この症例は（必ず選びます）"));
    const real = radio("cb-syn", "real", "実症例", M.synthetic === false, () => (M.synthetic = false));
    real.querySelector("input").id = "cb-syn-real";
    const fiction = radio("cb-syn", "fiction", "架空症例", M.synthetic === true, () => (M.synthetic = true));
    fiction.querySelector("input").id = "cb-syn-fiction";
    synth.append(real, fiction, el("p", "help", "「架空症例」を選ぶと、Casebook では架空症例として作られ、J-OSLER の登録の候補と集計から外れます。取り込んだあとに、実症例へ変えることはできません。「実症例」を選ぶと、ふつうの症例として作られます。"));
    newBlock.append(synth);

    // existing case: its code
    const code = el("input");
    code.id = "cb-code";
    code.type = "text";
    code.maxLength = 10;
    code.size = 10;
    code.setAttribute("autocomplete", "off");
    code.value = M.code ?? cb.code;
    code.addEventListener("input", () => (M.code = code.value));
    appendBlock.append(field("Casebook の症例コード（6文字）", code, "Casebook で新しい症例を取り込んだ完了の画面に出ます。追加の宛先の症例の種類（実症例・架空症例）は、その症例のままです。"));
    if (cb.code) {
      const reset = el("button", "btn rec-small", "症例コードと送信済みの印を消して、新しい症例として送り直す");
      reset.type = "button";
      reset.id = "cb-reset";
      reset.addEventListener("click", () => {
        if (!confirm("この記録の送信済みの印と症例コードを消します。次の送信は、新しい症例として Casebook に入ります。Casebook にすでにある内容は消えません。よろしいですか？")) return;
        M.mode = "";
        M.code = null;
        M.synthetic = null; // the next new case is chosen again
        M.sel.clear();
        mutate((r) => resetCasebook(r, randomBytes(10)));
      });
      appendBlock.append(reset);
    }
    target.append(newBlock, appendBlock);
    showMode(mode);
    box.append(target);

    // ------------------------------------------------ what goes
    const count = el("p", "cb-count");
    count.setAttribute("role", "status");
    const showCount = () => {
      const n = chosen().length;
      count.textContent = `選んだ項目: ${n} / ${MAX_ITEMS}${n > MAX_ITEMS ? "（多すぎます。減らしてください）" : ""}`;
      count.classList.toggle("over", n > MAX_ITEMS);
    };
    if (all.some((c) => stateOf(rec, c) === "changed")) box.append(el("p", "help", "「送信後に直した」項目は、Casebook にある前の項目は変わりません。選ぶと、新しい項目として送ります（前の項目も Casebook に残ります）。"));
    for (const g of GROUPS) {
      const items = all.filter((c) => c.group === g.id);
      if (!items.length) continue;
      box.append(el("h4", "rec-sub", g.label));
      const ul = el("ul", "cb-list");
      for (const c of items) {
        const st = stateOf(rec, c);
        const li = el("li", "cb-row");
        li.dataset.key = c.key;
        li.dataset.state = st;
        const lab = el("label", "cb-label");
        const box1 = el("input", "cb-check");
        box1.type = "checkbox";
        box1.disabled = !selectable(rec, c);
        box1.checked = selectable(rec, c) && on(rec, c);
        box1.addEventListener("change", () => {
          M.sel.set(c.key, box1.checked);
          showCount();
        });
        const main = el("span", "cb-main");
        const tags = el("span", "cb-tags");
        tags.append(el("span", "rec-tag", c.tag), el("span", "rec-tag", `${c.day}日目`));
        if (c.source === "ai") tags.append(el("span", "rec-tag ai", SOURCE_LABEL.ai));
        if (st === "sent") tags.append(el("span", "badge", "送信済み"));
        if (st === "changed") tags.append(el("span", "badge", "送信後に直した"));
        main.append(tags, el("span", "cb-text", clip(c.text, 160)));
        if (c.blockers.length) main.append(el("span", "cb-why", `送れません: ${c.blockers.join("、")}`));
        lab.append(box1, main);
        li.append(lab);
        ul.append(li);
      }
      box.append(ul);
    }
    if (!all.length) box.append(el("p", "help", "送れる項目がありません（記録に、問題・評価・計画や、症例の文章がありません）。"));

    const actions = el("div", "btn-row");
    const pickAll = el("button", "btn rec-small", "送っていない項目をすべて選ぶ（AI の草案を含む）");
    pickAll.type = "button";
    pickAll.addEventListener("click", () => {
      for (const c of all) if (selectable(rec, c) && stateOf(rec, c) === "new") M.sel.set(c.key, true);
      redraw();
    });
    const pickNone = el("button", "btn rec-small", "選びを外す");
    pickNone.type = "button";
    pickNone.addEventListener("click", () => {
      for (const c of all) M.sel.set(c.key, false);
      redraw();
    });
    actions.append(pickAll, pickNone);
    box.append(actions, count);
    showCount();
    if (M.note) {
      const n = el("p", "notice", M.note);
      n.setAttribute("role", "status");
      n.id = "cb-note";
      box.append(n);
      M.note = "";
    }

    // ------------------------------------------------ make the packet
    const errors = el("ul", "notice err");
    errors.id = "cb-errors";
    errors.hidden = true;
    errors.setAttribute("role", "alert");
    const build = el("button", "btn primary", "パケットを作ってコピー");
    build.type = "button";
    build.id = "cb-build";
    build.addEventListener("click", async () => {
      M.out = null;
      const bytes = randomBytes(10);
      const now = getRec();
      const seeded = ensureSeed(now, bytes);
      const current = candidates(seeded);
      if (signature(current) !== shown) {
        M.note = "記録が変わっていたので、項目の一覧を更新しました。内容を確かめて、もう一度押してください。";
        redraw();
        return;
      }
      const keys = chosen(seeded, current).map((c) => c.key);
      const m = M.mode || mode;
      const typedCode = normalizeCode(code.value);
      // a code that differs from the one this record was sent to: another case in Casebook is meant, or a slip
      if (m === "append" && seeded.casebook.code && typedCode !== seeded.casebook.code && !confirm("入れた症例コードが、この記録を送った症例のコードと違います。別の Casebook の症例に追加しますか？")) return;
      const typedAge = readAge(age.value);
      const patient = { ageYears: typedAge.ok && /^\d+$/.test(typedAge.age) ? Number(typedAge.age) : null, sex: sex.value, setting: setting.value };
      const res = buildPacket(seeded, {
        mode: m,
        code: typedCode,
        patient,
        synthetic: M.synthetic,
        keys,
        resend: keys.filter((k) => current.find((c) => c.key === k && stateOf(seeded, c) === "changed")),
        packetId: ulidFrom(Date.now(), randomBytes(10)),
      });
      errors.replaceChildren();
      errors.hidden = res.ok;
      if (!res.ok) {
        for (const e of res.errors) errors.append(el("li", null, e));
        return;
      }
      const shownItems = new Map(current.map((c) => [c.key, c]));
      M.out = { text: res.text, entries: res.entries, items: res.entries.map((e) => ({ key: e.key, tag: shownItems.get(e.key)?.tag ?? "", text: shownItems.get(e.key)?.text ?? "" })), skip: new Set(), count: res.json.items.length, mode: m, copied: null };
      // the seed goes into the record NOW, on the record as it is at this moment and before anything is waited for: a later answer from the
      // clipboard must not write an older copy of the record over whatever is open by then (another record, or text typed in the meantime)
      if (!now.casebook.seed) mutate((r) => ensureSeed(r, bytes));
      else redraw();
      const packet = res.text;
      const ok = (await copyText(packet)) === true;
      if (M.id !== id || !M.out || M.out.text !== packet) return; // another record or another packet is on the screen by now
      M.out.copied = ok;
      const head = document.getElementById("cb-out-head");
      if (head?.isConnected) head.textContent = outHead(M.out);
    });
    const buildRow = el("div", "btn-row");
    buildRow.append(build);
    box.append(buildRow, errors);

    // ------------------------------------------------ the result
    if (M.out) {
      const out = el("div", "cb-out");
      out.id = "cb-out";
      const head = el("p", "cb-out-head", outHead(M.out));
      head.id = "cb-out-head";
      out.append(head);
      const ta = el("textarea", "cb-packet");
      ta.id = "cb-packet";
      ta.readOnly = true;
      ta.rows = 3;
      ta.value = M.out.text;
      ta.setAttribute("aria-label", "受け渡しパケット");
      const again = el("button", "btn rec-small", "もう一度コピー");
      again.type = "button";
      again.id = "cb-copy";
      again.addEventListener("click", async () => {
        again.textContent = (await copyText(M.out?.text ?? "")) === true ? "コピーしました" : "コピーできませんでした（上の欄から手で）";
      });
      const copyRow = el("div", "btn-row");
      copyRow.append(again);
      out.append(ta, copyRow);
      out.append(el("p", "help", "Casebook を開き、一覧の「Playbook から受け取る」（クリップボードから読みます）か、受け取り画面の入力欄に貼り付けて、確認画面で「取り込む」を押してください。取り込んだら、下の「取り込みました」を押します（これで送信済みの印が付きます）。"));
      const done = el("div", "cb-done");
      let newCode = null;
      if (M.out.mode === "new") {
        newCode = el("input");
        newCode.id = "cb-newcode";
        newCode.type = "text";
        newCode.maxLength = 10;
        newCode.size = 10;
        newCode.setAttribute("autocomplete", "off");
        done.append(field("Casebook が示した症例コード（取り込み完了の画面。6文字）", newCode, "入れておくと、次の送信は、この症例への追加になります。"));
      }
      // Casebook may skip an item (its own check, a shape it does not take): the doctor takes those out of the marks, so they are offered again
      const which = el("details", "cb-which");
      which.id = "cb-which";
      which.append(el("summary", null, "Casebook が取り込まなかった項目があったとき（その項目を外してから押す）"));
      which.append(el("p", "help", "Casebook の取り込み完了の画面に「取り込めなかった」と出た項目は、ここで外してください。外した項目には印が付かず、まだ送っていない項目として残ります。"));
      for (const it of M.out.items) {
        const lab = el("label", "cb-label");
        const cbx = el("input", "cb-check");
        cbx.type = "checkbox";
        cbx.checked = !M.out.skip.has(it.key);
        cbx.dataset.key = it.key;
        cbx.addEventListener("change", () => {
          if (cbx.checked) M.out.skip.delete(it.key);
          else M.out.skip.add(it.key);
        });
        lab.append(cbx, el("span", "cb-text", `${it.tag}｜${clip(it.text, 120)}`));
        which.append(lab);
      }
      done.append(which);
      const msg = el("p", "help", "");
      msg.setAttribute("role", "status");
      const imported = el("button", "btn primary", "Casebook に取り込みました（送信済みの印を付ける）");
      imported.type = "button";
      imported.id = "cb-imported";
      imported.addEventListener("click", () => {
        const o = M.out;
        const taken = o.entries.filter((e) => !o.skip.has(e.key));
        let next = null;
        if (newCode) {
          const typed = normalizeCode(newCode.value);
          if (typed && !CODE_RE.test(typed)) {
            msg.textContent = "症例コードの形ではありません（6文字。0・O・1・I・L・U は使いません）。";
            return;
          }
          if (!typed && !confirm("症例コードが空です。次の送信は、追加ではなく新しい症例になります。このまま印を付けますか？")) return;
          next = typed ? (r) => markSent(setCode(r, typed).rec, taken) : (r) => markSent(r, taken);
        } else next = (r) => markSent(r, taken);
        M.out = null;
        M.sel.clear();
        M.mode = "";
        M.code = null;
        M.synthetic = null; // the choice was for that case; a case sent later is chosen again
        mutate(next);
      });
      const discard = el("button", "btn rec-small", "取り込まなかった（パケットを破棄する）");
      discard.type = "button";
      discard.id = "cb-discard";
      discard.addEventListener("click", () => {
        M.out = null;
        redraw();
      });
      const row = el("div", "btn-row");
      row.append(imported, discard);
      done.append(msg, row);
      out.append(done);
      box.append(out);
    }
  }

  /**
   * Called when the record changed while the part is on the screen: draws the list again, unless the doctor is working inside this part.
   * A little later, so that typing elsewhere is not slowed down.
   */
  function refresh() {
    clearTimeout(live.timer);
    live.timer = setTimeout(() => {
      const box = live.box;
      if (!box?.isConnected || !box.parentElement?.open || box.contains(document.activeElement)) return;
      const rec = live.getRec();
      if (rec && signature(candidates(rec)) !== live.shown) live.redraw();
    }, 400);
  }

  return { draw, refresh };
}

const signature = (list) => list.map((c) => `${c.key}:${c.h}:${c.blockers.length}`).join("|");
