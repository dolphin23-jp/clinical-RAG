// "文章から取り込む（試作）" inside the scene x symptom panel (docs/enhancement-plan.md 8.12, 8.15).  The doctor pastes a memo; the Worker proposes
// answers for the open flow's questions (worker/src/extract.ts); this file shows the proposals with the words they come from, and takes one
// into the answers only when the doctor says so.  Nothing is entered by itself: a proposal is not an answer, an answer already entered is
// never overwritten without its own button, and a question the memo does not mention stays blank (never "none").
//
// The memo lives in the tab's memory only (the text box): it is not saved, not put in the sessionStorage, not kept with the proposals.  Dates in
// it are made relative before it is sent, and a memo that looks like it holds an identifier is not sent at all.  The model, the checks and the
// weight of each confirmation are in web/extract-model.js (pure).  Every string reaches the DOM through textContent / .value.
import { scan } from "./id-guard.js";
import { relativizeDates } from "./date-relative.js";
import { EXTRACT_LIMIT, classify, reviewProposals } from "./extract-model.js";

const STATE_HELP = {
  hidden: "この質問は、条件を満たしていないため、いまは入れられません。表示される答えを先に入れると、ここから入れられます。",
};

/**
 * `getFlow()`, `getAnswers()`, `getContext()`: the open flow, the answers entered, the values the conditions read.  `apply(qid, value)`: puts one
 * answer in (the panel's own setter).  `jump(qid)`: scrolls to a question.  `schemaCommit()`: the version of the question list this screen holds.
 * `bindDates`, `changesNote`: the panel's date conversion on a text box (passed in, so this file does not import the panel).
 */
export function initExtract({ el, api, getFlow, getAnswers, getContext, apply, jump, schemaCommit, bindDates, changesNote }) {
  const root = el("details", "extract");
  root.hidden = true;
  root.append(el("summary", null, "文章から取り込む（試作）"));
  root.append(
    el(
      "p",
      "help",
      "メモ（申し送り・紹介状の抜粋・ご自身のメモなど）を貼ると、この場面・症候の質問への答えの「提案」を作ります。提案は、先生が確認するまで入力に入りません。メモに書かれていない項目は提案しません（未入力のまま。陰性にはしません）。診断・鑑別・判断の提案はしません。",
    ),
  );
  root.append(el("p", "help", "氏名・ID・生年月日・電話番号は消してから貼ってください（識別情報らしき文字があると送りません）。日付は「N日前」「入院N日目」に直してから送ります。貼った文章は保存しません（この画面のメモリだけ。「新しい会話」や症例を外したときに消えます）。"));
  const memo = el("textarea", "extract-memo"); // (not "case-text": that class marks the five free-text fields of the case)
  memo.rows = 6;
  memo.setAttribute("autocomplete", "off");
  memo.setAttribute("aria-label", "取り込む文章");
  memo.placeholder = "例: 78歳男性。2時間前からの呼吸困難。呼吸数28、室内気でSpO2 88%。両側でcrackles。…";
  const count = el("p", "help extract-count", "");
  const dateNote = el("p", "help", "");
  dateNote.setAttribute("role", "status");
  bindDates(memo, (changes) => (dateNote.textContent = changesNote(changes)));
  const row = el("div", "btn-row");
  const go = el("button", "btn primary extract-go", "提案を作る");
  go.type = "button";
  const stop = el("button", "btn", "やめる");
  stop.type = "button";
  stop.hidden = true;
  const wipe = el("button", "btn", "文章と提案を消す");
  wipe.type = "button";
  row.append(go, stop, wipe);
  const status = el("p", "help extract-status", "");
  status.setAttribute("role", "status");
  const out = el("div", "extract-out");
  // the notes that appear while typing or leaving the box go below the buttons: a line that appears above them would move the button between
  // the press and the release of a tap
  root.append(memo, count, row, status, dateNote, out);

  let items = null; // [{ qid, q, value, frag }] checked proposals not yet taken or dropped, or null (none made)
  let note = ""; // what the checks dropped, as words
  let picked = new Set(); // the ids of the "confirm with others" proposals ticked (none by default)
  let ctl = null;
  const setStatus = (t, kind = "") => {
    status.textContent = t;
    status.className = `help extract-status${kind ? ` ${kind}` : ""}`;
  };

  function sizeNote() {
    const n = memo.value.length;
    count.textContent = `${n.toLocaleString("ja-JP")} / ${EXTRACT_LIMIT.toLocaleString("ja-JP")} 字`;
    count.classList.toggle("over", n > EXTRACT_LIMIT);
    return n;
  }
  memo.addEventListener("input", sizeNote);
  sizeNote();

  // ---------------------------------------------------------------- asking
  async function make() {
    const flow = getFlow();
    if (!flow) return;
    const r = relativizeDates(memo.value);
    if (r.changes.length) {
      memo.value = r.text;
      dateNote.textContent = changesNote(r.changes);
      sizeNote();
    }
    const text = memo.value.trim();
    if (!text) return setStatus("文章を入れてください。", "err");
    if (text.length > EXTRACT_LIMIT) return setStatus(`文章は ${EXTRACT_LIMIT.toLocaleString("ja-JP")} 字までです。分けて貼ってください。`, "err");
    const hits = scan(text);
    if (hits.length) return setStatus(`患者を特定できる情報の可能性があります（${[...new Set(hits.map((h) => h.label))].join("、")}）。該当の部分を消してから、もう一度押してください（この文章は送っていません）。`, "err");
    ctl = new AbortController();
    go.disabled = true;
    stop.hidden = false;
    setStatus("提案を作っています…（数秒〜十数秒かかります）");
    try {
      const res = await api("/api/extract", { method: "POST", body: JSON.stringify({ flow: flow.id, schema: schemaCommit(), text }), signal: ctl.signal });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `提案を作れませんでした（${res.status}）`);
      if (getFlow() !== flow) return; // the doctor changed the flow while it was running: the answer is for another form
      const reviewed = reviewProposals(flow, j.proposals, text);
      const serverDropped = Object.values(j.dropped ?? {}).reduce((a, n) => a + (Number.isFinite(n) ? n : 0), 0);
      items = reviewed.items;
      picked = new Set();
      const dropped = serverDropped + reviewed.dropped;
      note = dropped ? `検査で外した提案: ${dropped}件（文にない根拠・質問にない値・同じ質問への重複など。外したものは出しません）。` : "";
      setStatus(items.length ? "" : "提案はありませんでした（メモに書かれていることだけを提案します）。");
      render();
    } catch (e) {
      if (e?.name === "AbortError") setStatus("やめました。");
      else setStatus(e?.message || "提案を作れませんでした。", "err");
    } finally {
      ctl = null;
      go.disabled = false;
      stop.hidden = true;
    }
  }
  go.addEventListener("click", make);
  stop.addEventListener("click", () => ctl?.abort());
  wipe.addEventListener("click", clear);

  // ---------------------------------------------------------------- showing
  const button = (label, cls, onClick) => {
    const b = el("button", cls, label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  };
  const quote = (it) => {
    const box = el("div", "extract-quote", `元の文: 「${it.frag}」`);
    // the sentence around it, when there is more: a negation or a doubt may be outside the few words quoted
    if (it.sentence && it.sentence.normalize("NFKC") !== it.frag.normalize("NFKC")) box.append(el("div", "extract-around", `前後: ${it.sentence.length > 120 ? `${it.sentence.slice(0, 119)}…` : it.sentence}`));
    return box;
  };
  const take = (it) => {
    picked.delete(it.qid);
    apply(it.qid, it.value);
  };
  const drop = (it) => {
    items = items.filter((x) => x.qid !== it.qid);
    picked.delete(it.qid);
    render();
  };

  function render() {
    out.replaceChildren();
    const flow = getFlow();
    if (!items || !flow) return;
    const all = classify(flow, getAnswers(), getContext(), items);
    const group = {
      low: all.filter((i) => i.state === "new" && i.risk === "low"),
      high: all.filter((i) => i.state === "new" && i.risk === "high"),
      differs: all.filter((i) => i.state === "differs"),
      same: all.filter((i) => i.state === "same"),
      hidden: all.filter((i) => i.state === "hidden"),
    };
    if (!items.length) {
      if (note) out.append(el("p", "help", note));
      return;
    }
    out.append(
      el("p", "extract-summary", `提案 ${all.length}件: まとめて確認 ${group.low.length}／1件ずつ確認 ${group.high.length}／すでに入力あり ${group.differs.length}／同じ答えが入力済み ${group.same.length}／いまは入れられない ${group.hidden.length}`),
    );
    out.append(el("p", "help", "確認して「入れる」を押したものだけが入力に入ります。提案は答えではありません。入力済みの答えは、「上書きして入れる」を押さない限り変わりません。"));
    if (note) out.append(el("p", "help", note));

    // 1. plain facts: confirmed together, none ticked to begin with
    if (group.low.length) {
      const box = el("div", "extract-group");
      box.append(el("h4", "extract-h", `まとめて確認できる提案（${group.low.length}）`));
      box.append(el("p", "help", "数値や所見で、元の文に否定・不確かさ・予定・指示の言い方がないものです。入れる前に、質問・提案・元の文の3つが合っているか見てください。最初は、どれも選ばれていません。"));
      for (const it of group.low) {
        const r = el("label", "extract-item");
        r.dataset.q = it.qid;
        const cb = el("input");
        cb.type = "checkbox";
        cb.checked = picked.has(it.qid);
        cb.setAttribute("aria-label", `${it.label}: ${it.valueText}`);
        cb.addEventListener("change", () => {
          if (cb.checked) picked.add(it.qid);
          else picked.delete(it.qid);
          sync();
        });
        const text = el("span", "extract-text");
        text.append(el("strong", null, it.label), el("span", null, ` → ${it.valueText}`), quote(it));
        r.append(cb, text);
        box.append(r);
      }
      const bar = el("div", "btn-row");
      const takeBtn = button("", "btn primary extract-take", () => {
        for (const it of group.low.filter((x) => picked.has(x.qid))) take(it);
      });
      const sync = () => {
        takeBtn.textContent = `選んだ ${picked.size} 件を入れる`;
        takeBtn.disabled = picked.size === 0;
      };
      sync();
      bar.append(
        button("すべて選ぶ", "btn", () => {
          group.low.forEach((i) => picked.add(i.qid));
          render();
        }),
        button("選びを外す", "btn", () => {
          picked = new Set();
          render();
        }),
        takeBtn,
        button("選んだものを捨てる", "btn", () => {
          const ids = new Set(picked);
          items = items.filter((x) => !ids.has(x.qid));
          picked = new Set();
          render();
        }),
      );
      box.append(bar);
      out.append(box);
    }

    // 2. the ones to look at alone: a negation, a time, a thing done, a measurement's condition, an uncertain or planned wording
    if (group.high.length) {
      const box = el("div", "extract-group");
      box.append(el("h4", "extract-h", `1件ずつ確認する提案（${group.high.length}）`));
      box.append(el("p", "help", "取り違えると害が大きい種類です（陰性・時刻・行った処置・測定の条件・不明・結果待ち、または元の文に否定・不確かさ・予定の言い方があるもの）。元の文と見比べて、1件ずつ決めてください。"));
      for (const it of group.high) {
        const card = el("div", "extract-card");
        card.dataset.q = it.qid;
        const head = el("div", "extract-card-head");
        head.append(el("strong", null, it.label), el("span", null, ` → ${it.valueText}`));
        const why = el("div", "extract-why");
        for (const w of it.why) why.append(el("span", "extract-tag", w));
        const acts = el("div", "btn-row");
        acts.append(
          button("この答えを入れる", "btn primary", () => take(it)),
          button("直して入れる（質問へ）", "btn", () => jump(it.qid)),
          button("捨てる", "btn", () => drop(it)),
        );
        card.append(head, quote(it), why, acts);
        box.append(card);
      }
      out.append(box);
    }

    // 3. something else is entered already: never overwritten by itself
    if (group.differs.length) {
      const box = el("div", "extract-group");
      box.append(el("h4", "extract-h", `すでに入力のある項目（${group.differs.length}）`));
      box.append(el("p", "help", "入力済みの答えとは違う提案です。そのままにするか、提案で置き換えるかを、1件ずつ選んでください（既定はそのままです）。"));
      for (const it of group.differs) {
        const card = el("div", "extract-card");
        card.dataset.q = it.qid;
        const head = el("div", "extract-card-head");
        head.append(el("strong", null, it.label));
        const cmp = el("div", "extract-compare");
        cmp.append(el("div", null, `入力済み: ${it.currentText}`), el("div", null, `提案: ${it.valueText}`));
        const acts = el("div", "btn-row");
        acts.append(button("上書きして入れる", "btn", () => take(it)), button("そのまま（提案を捨てる）", "btn primary", () => drop(it)));
        card.append(head, cmp, quote(it), acts);
        box.append(card);
      }
      out.append(box);
    }

    if (group.same.length) {
      const d = el("details", "extract-same");
      d.append(el("summary", null, `同じ答えが入力済み（${group.same.length}）`));
      for (const it of group.same) d.append(el("div", "extract-same-item", `${it.label}: ${it.valueText}`));
      out.append(d);
    }
    if (group.hidden.length) {
      const d = el("details", "extract-hidden");
      d.append(el("summary", null, `いまは入れられない提案（${group.hidden.length}）`));
      d.append(el("p", "help", STATE_HELP.hidden));
      for (const it of group.hidden) {
        const r = el("div", "extract-hidden-item");
        r.append(el("span", null, `${it.label} → ${it.valueText}`), button("捨てる", "btn", () => drop(it)));
        d.append(r);
      }
      out.append(d);
    }
  }

  function clear() {
    ctl?.abort();
    memo.value = "";
    items = null;
    note = "";
    picked = new Set();
    dateNote.textContent = "";
    setStatus("");
    sizeNote();
    out.replaceChildren();
  }

  return {
    node: root,
    /** Shows the panel only while a flow is open; re-checks the proposals against the answers (an answer was entered or changed). */
    sync(open) {
      root.hidden = !open;
      if (items) render();
    },
    /** The flow changed or the case was cleared: the memo and every proposal go. */
    clear,
    /** Whether a memo or proposals are held (for the dialog's own checks). */
    holds: () => !!memo.value.trim() || !!items,
  };
}
