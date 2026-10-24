// The "場面・症候の質問で入力する（試作）" panel of the case dialog (docs/enhancement-plan.md 8; docs/clinical-use.md 1e).  The doctor picks a
// scene x symptom flow of clinical-modules and answers its questions (choices, numbers, times, short text); the questions come from
// web/flow-schema.js (structure only, loaded when the panel is first opened), the logic from web/intake.js.  Nothing here judges: the
// unanswered core questions are listed as 未確認, a blank is never turned into "none", and no rule or differential of the flows is used.
//
// The answers live in the tab's memory (the case dialog's state); they leave it only as the rendered text of the pinned case
// (`structured`) and, with a saved conversation, as the answers themselves (`intake`).  Dates typed or pasted into a text answer are
// made relative at once (web/date-relative.js): no calendar date is kept.  Every string reaches the DOM through textContent / .value.
import { relativizeDates } from "./date-relative.js";
import { byPhase, cleanAnswers, contextOf, coreCount, coreMissing, flowChoices, isAnswered, isVisible, renderStructured, setAnswer } from "./intake.js";

const plain = (s) => String(s).replace(/^★\d+\s*/, "").trim();
const PASTE = new Set(["insertFromPaste", "insertFromDrop", "insertFromYank", "insertReplacementText"]);

/**
 * Makes the dates of a text control relative when something is pasted into it and when it loses focus.  `onConverted(changes)` is told
 * what was changed (a passive note on the screen; there is nothing to confirm).  Returns a function that converts the value now.
 */
export function bindDates(input, onConverted) {
  const run = () => {
    const { text, changes } = relativizeDates(input.value);
    if (!changes.length) return;
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    onConverted?.(changes);
  };
  input.addEventListener("input", (e) => {
    if (PASTE.has(e.inputType)) run();
  });
  input.addEventListener("change", run);
  return run;
}

/** "10/20 → 4日前" for a note, at most `n` of them. */
export const changesNote = (changes, n = 3) =>
  `日付を経過の表現に直しました（元の日付は残しません）: ${changes.slice(0, n).map((c) => `${c.from} → ${c.to}`).join("、")}${changes.length > n ? `、ほか${changes.length - n}件` : ""}`;

export function initIntake({ el, host, context, onChange }) {
  // context(): { sex, age, setting } of the case dialog's own selects
  const root = el("details", "intake");
  const sum = el("summary", null, "場面・症候の質問で入力する（試作）");
  const intro = el("p", "help", "救急外来などの場面と症候を選ぶと、その流れの質問が出ます。選んだ・入力した答えだけが症例に入ります。入れていない項目は「未確認」として扱い、陰性にはしません。書籍の検索には使いますが、鑑別の提案や判定はここでは行いません。");
  const status = el("p", "help", "");
  status.setAttribute("role", "status");
  const pick = el("select");
  pick.id = "intake-flow";
  pick.setAttribute("aria-label", "場面・症候");
  pick.append(new Option("（使わない）", ""));
  const progress = el("p", "intake-progress", "");
  const missingBox = el("details", "intake-missing");
  const missingSum = el("summary", null, "");
  const missingList = el("ul", "intake-missing-list");
  missingBox.append(missingSum, missingList);
  const body = el("div", "intake-body");
  const dateNote = el("p", "help", "");
  dateNote.setAttribute("role", "status");
  const legacyBox = el("div", "intake-legacy");
  root.append(sum, intro, pick, status, progress, missingBox, dateNote, body, legacyBox);
  host.append(root);

  let schema = null; // { FLOWS }
  let loading = null;
  let flow = null;
  let answers = {};
  let legacy = ""; // the rendered text of a saved case whose form could not be restored: kept as it is until the doctor drops it
  let pending = null; // { structured, intake } of a case being put back, until its form is built (so pinning at that moment loses nothing)
  let controls = new Map(); // question id -> { q, wrap, sync() }
  let phases = []; // [{ phase, details, count, ids }]

  const ctx = () => contextOf(answers, context());
  const setStatus = (t) => (status.textContent = t);

  function ensureSchema() {
    loading ??= import("./flow-schema.js")
      .then((m) => {
        schema = m;
        for (const g of flowChoices(m.FLOWS)) {
          const og = document.createElement("optgroup");
          og.label = g.scene;
          for (const f of g.flows) og.append(new Option(f.title, f.id));
          pick.append(og);
        }
        return m;
      })
      .catch((e) => {
        loading = null;
        throw e;
      });
    return loading;
  }
  root.addEventListener("toggle", () => {
    if (root.open && !schema) {
      setStatus("質問の一覧を読み込んでいます…");
      ensureSchema().then(() => setStatus(""), () => setStatus("質問の一覧を読み込めませんでした。通信を確認して、もう一度開いてください。"));
    }
  });

  // ---------------------------------------------------------------- one question
  function set(qid, value) {
    answers = setAnswer(flow, answers, qid, value);
    controls.get(qid)?.sync();
    refresh();
  }

  function build(q) {
    const wrap = el("div", "intake-q");
    wrap.dataset.q = q.id;
    const label = el("div", "intake-label");
    label.append(el("span", null, plain(q.label)));
    if (q.core) label.append(el("span", "intake-core", "中核"));
    wrap.append(label);
    let sync = () => {};
    if (q.type === "choice" || q.type === "multi") {
      const chips = el("div", "chips");
      chips.setAttribute("role", "group");
      chips.setAttribute("aria-label", plain(q.label));
      const buttons = new Map();
      for (const o of q.options) {
        const b = el("button", "chip", o.label);
        b.type = "button";
        b.dataset.opt = o.id;
        b.setAttribute("aria-pressed", "false");
        b.addEventListener("click", () => {
          const cur = answers[q.id];
          if (q.type === "choice") set(q.id, cur === o.id ? "" : o.id);
          else {
            const list = Array.isArray(cur) ? cur : [];
            set(q.id, list.includes(o.id) ? list.filter((x) => x !== o.id) : [...list, o.id]);
          }
        });
        buttons.set(o.id, b);
        chips.append(b);
      }
      sync = () => {
        const cur = answers[q.id];
        for (const [id, b] of buttons) b.setAttribute("aria-pressed", String(Array.isArray(cur) ? cur.includes(id) : cur === id));
      };
      wrap.append(chips);
    } else if (q.type === "number") {
      const row = el("div", "intake-num");
      const input = el("input", "n-input");
      input.type = "number";
      input.inputMode = "decimal";
      input.step = "any";
      input.setAttribute("aria-label", plain(q.label));
      input.addEventListener("input", () => {
        const v = input.value.trim();
        const n = Number(v);
        if (v === "" || !Number.isFinite(n)) answers = setAnswer(flow, answers, q.id, "");
        else answers = setAnswer(flow, answers, q.id, n);
        refresh();
      });
      row.append(input);
      if (q.unit) row.append(el("span", "intake-unit", q.unit));
      sync = () => {
        input.value = typeof answers[q.id] === "number" ? String(answers[q.id]) : "";
      };
      wrap.append(row);
    } else if (q.type === "time") {
      const input = el("input", "n-input intake-time");
      input.type = "time";
      input.setAttribute("aria-label", plain(q.label));
      input.addEventListener("input", () => {
        answers = setAnswer(flow, answers, q.id, /^\d{2}:\d{2}$/.test(input.value) ? input.value : "");
        refresh();
      });
      sync = () => {
        input.value = typeof answers[q.id] === "string" ? answers[q.id] : "";
      };
      wrap.append(input);
    } else {
      const ta = el("textarea", "case-text intake-text");
      ta.rows = 2;
      ta.maxLength = 600;
      ta.setAttribute("autocomplete", "off");
      ta.setAttribute("aria-label", plain(q.label));
      ta.addEventListener("input", () => {
        answers = setAnswer(flow, answers, q.id, ta.value.trim() ? ta.value : "");
        refresh();
      });
      bindDates(ta, (changes) => (dateNote.textContent = changesNote(changes)));
      sync = () => {
        ta.value = typeof answers[q.id] === "string" ? answers[q.id] : "";
      };
      wrap.append(ta);
    }
    controls.set(q.id, { q, wrap, sync });
    return wrap;
  }

  function openFlow(flowId, restored = null) {
    flow = schema?.FLOWS[flowId] ?? null;
    answers = flow && restored ? restored : {};
    controls = new Map();
    phases = [];
    body.replaceChildren();
    pick.value = flow ? flow.id : "";
    if (!flow) return refresh();
    for (const { phase, questions } of byPhase(flow)) {
      if (!questions.length) continue;
      const d = el("details", "intake-phase");
      const s = el("summary");
      const name = el("span", "intake-phase-name", phase.name);
      const count = el("span", "intake-phase-count", "");
      s.append(name, count);
      d.append(s);
      for (const q of questions.filter((x) => x.core)) d.append(build(q));
      const rest = questions.filter((x) => !x.core);
      if (rest.length) {
        const more = el("details", "intake-more");
        more.append(el("summary", null, `ほかの項目（${rest.length}）`));
        for (const q of rest) more.append(build(q));
        d.append(more);
      }
      body.append(d);
      phases.push({ phase, details: d, count, ids: questions.map((x) => x.id) });
    }
    for (const c of controls.values()) c.sync();
    refresh();
  }

  // ---------------------------------------------------------------- the summary lines
  function refresh() {
    render();
    onChange?.();
  }

  function render() {
    const has = !!flow;
    progress.hidden = !has;
    missingBox.hidden = !has;
    body.hidden = !has;
    legacyBox.hidden = !legacy;
    if (has) {
      const c = ctx();
      for (const { q, wrap } of controls.values()) wrap.hidden = !isVisible(flow, q, c);
      const k = context();
      const { all, done } = coreCount(flow, answers, k);
      progress.textContent = `中核の質問 ${done}/${all} 入力済み。入れていない項目は「未確認」として送ります（陰性にはしません）。`;
      for (const p of phases) {
        const ids = p.ids.map((id) => controls.get(id).q).filter((q) => q.core && isVisible(flow, q, c));
        const n = ids.filter((q) => isAnswered(answers[q.id])).length;
        p.count.textContent = ids.length ? `中核 ${n}/${ids.length}` : "";
      }
      const miss = coreMissing(flow, answers, k);
      missingSum.textContent = miss.length ? `未入力の中核の質問（${miss.length}件）` : "未入力の中核の質問はありません";
      missingList.replaceChildren();
      for (const m of miss) {
        const li = el("li");
        const b = el("button", "intake-jump", `${plain(m.label)}（${m.phase}）`);
        b.type = "button";
        b.addEventListener("click", () => jump(m.id));
        li.append(b);
        missingList.append(li);
      }
    }
  }

  function jump(id) {
    const c = controls.get(id);
    if (!c) return;
    for (let n = c.wrap.parentElement; n && n !== body; n = n.parentElement) if (n.tagName === "DETAILS") n.open = true;
    c.wrap.scrollIntoView({ block: "center", behavior: "smooth" });
    c.wrap.classList.add("flash");
    setTimeout(() => c.wrap.classList.remove("flash"), 1600);
    c.wrap.querySelector("button, input, textarea")?.focus({ preventScroll: true });
  }

  pick.addEventListener("change", async () => {
    try {
      await ensureSchema();
    } catch {
      return;
    }
    legacy = "";
    openFlow(pick.value);
  });

  // ---------------------------------------------------------------- legacy text (a saved form that cannot be restored)
  const legacyText = el("p", "help", "この症例の場面ごとの入力は、質問の定義が変わったため入力欄に戻せませんでした。固定していた内容はそのまま使われます。入れ直す場合は、上で場面・症候を選んでください。");
  const legacyDrop = el("button", "btn", "この内容を外す");
  legacyDrop.type = "button";
  legacyDrop.addEventListener("click", () => {
    legacy = "";
    refresh();
  });
  legacyBox.append(legacyText, legacyDrop);

  render();
  return {
    /** { structured, intake } for the case being read: the rendered answers, and the answers themselves for a saved conversation. */
    value() {
      if (pending && !flow) return { structured: pending.structured, intake: pending.intake ?? null };
      if (flow) {
        const text = renderStructured(flow, answers, context());
        if (text) {
          const kept = {};
          for (const [id, v] of Object.entries(answers)) kept[id] = typeof v === "string" && controls.get(id)?.q.type === "text" ? relativizeDates(v).text : v;
          return { structured: text, intake: { flow: flow.id, answers: kept } };
        }
      }
      return legacy ? { structured: legacy, intake: null } : { structured: "", intake: null };
    },
    /** Puts back the form of a pinned (or restored) case. */
    async restore(kase) {
      legacy = "";
      if (!kase?.structured) return this.clear();
      pending = { structured: kase.structured, intake: kase.intake };
      try {
        await ensureSchema();
      } catch {
        legacy = kase.structured;
        pending = null;
        return openFlow("");
      }
      const f = kase.intake ? schema.FLOWS[kase.intake.flow] : null;
      pending = null;
      if (f) {
        const cleaned = cleanAnswers(f, kase.intake.answers);
        openFlow(f.id, cleaned.answers);
        setStatus(cleaned.dropped ? `質問の定義が変わったため、${cleaned.dropped}件の答えは戻せませんでした。` : "");
      } else {
        legacy = kase.structured;
        openFlow("");
      }
    },
    clear() {
      legacy = "";
      pending = null;
      setStatus("");
      dateNote.textContent = "";
      openFlow("");
    },
    /** Opens the panel (used when a saved case carries answers). */
    show() {
      root.open = true;
    },
    /** Whether the form holds anything (for the dialog's own checks). */
    hasAnswers: () => Object.keys(answers).length > 0 || !!legacy,
    /** Re-evaluates the conditions (the case's sex may have changed). */
    refresh,
  };
}
