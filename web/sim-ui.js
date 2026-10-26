// The screen of a simulated fictional case (docs/enhancement-plan.md 8.21, step 1b; the doctor's decisions in docs/clinical-use.md 1h).
// The AI writes a setting from a theme and a difficulty (step 2), or the doctor pastes one; the doctor plays the emergency course (asks,
// examines, records acts, waits, moves to the next stage), takes what the case told into the answers, fills in the readings and the own
// assessment and plan, and reads the A04 note that grows from the answers.  The debrief lays things side by side; nothing is judged.
//
// With a setting the AI wrote, the AI also writes what happens next (the doctor's decision D4 c): at each wait / next stage, and for an item the
// state has no value for yet (before the ask or the order).  Every answer of the AI is checked (sim-model.js addContinuation, sim-case.js) before
// it is used; one that fails is not used.  The only call is /api/sim, through the app's `api`; it counts against the daily cap (shown here).
// Memory only: nothing is saved or put in the browser's storage; the note is copied as text with a header that cannot be taken off.  The hidden
// setting stays in this tab's memory and is shown only in the debrief, after a confirmation.  Every string reaches the DOM through textContent /
// .value.
import { STAGES } from "./sim-case.js";
import { clockAt, replay } from "./sim-engine.js";
import {
  KEY_STATUS, LEVELS, SAY_LABELS, SAY_TYPES, SEGMENT_CHOICES, SIM_HEADER, SIM_MARK, THEME_LIMIT, actText, addContinuation, applyAct, boardQuestions,
  baseSetting, checkAiSetting, contCount, debrief, doctorQuestions, isEmergencyFlow, memoLines, needsFill, orderNeeds, parseSetting, simKase, simReadings, takeRows,
  trayRows,
} from "./sim-model.js";
import { JUDGMENT_IDS } from "./extract-model.js";
import { assemble, toText } from "./note-assemble.js";
import { byPhase, isAnswered, setAnswer } from "./intake.js";
import { scan } from "./id-guard.js";

const plain = (s) => String(s ?? "").replace(/^★\d+\s*/, "").trim();

export function initSim({ el, $, openDialog, copyText, api }) {
  const dlg = $("#sim");
  const body = $("#sim-body");
  const readings = simReadings(JUDGMENT_IDS);
  let FLOWS = null;
  let SCHEMA = "";
  // how many times this tab asked the AI for the simulation (the daily cap is the same as for the answers: D8 a)
  let aiCalls = 0;
  // the run, in this tab's memory only
  let S = null; // { setting, flow, log, answers, own, minutes, taken: Set, filter, ended, busy, aiMsg, failed }

  const btn = (text, cls = "btn", onClick) => {
    const b = el("button", cls, text);
    b.type = "button";
    if (onClick) b.addEventListener("click", onClick);
    return b;
  };
  const section = (title, open = true) => {
    const d = el("details", "sim-sec");
    d.open = open;
    d.append(el("summary", null, title));
    return d;
  };
  const play = () => replay(S.setting, S.flow, S.log, { readings });

  async function loadFlows() {
    if (!FLOWS) {
      const m = await import("./flow-schema.js");
      FLOWS = m.FLOWS;
      SCHEMA = m.FLOW_SCHEMA_SOURCE?.commit ?? "";
    }
    return FLOWS;
  }
  const isAi = () => S?.setting?.origin?.by === "ai";
  const usageText = () => `この画面で AI を使った回数: ${aiCalls}（1日の上限は、回答と同じ枠に数えます）`;

  /** One call to /api/sim: the parsed answer, or an Error with the server's message. */
  async function callSim(req) {
    await loadFlows();
    const res = await api("/api/sim", { method: "POST", body: JSON.stringify({ ...req, schema: SCHEMA }) });
    const j = await res.json().catch(() => ({}));
    if (res.ok || res.status === 502) aiCalls++;
    if (!res.ok) throw new Error(j?.error || `エラー（${res.status}）`);
    return j;
  }

  // ---------------------------------------------------------------- loading a setting
  function renderLoad(msg = "", errors = []) {
    body.replaceChildren();
    body.append(
      el("p", "help", "架空症例を相手に、聞く・診る・測る・オーダーする・待つ、を進める模擬です。AI が、テーマ（病名・症候）と難しさから、書籍を根拠に症例の設定を書き、進行中も、先生の行為に応じた続きを書きます。AI の答えは、検査を通したものだけを使います。"),
      el("p", "help", "この画面のものは保存しません（タブを閉じると消えます）。AI には、テーマと、先生の行為の記録・先生の言葉だけを送ります。実在の患者の情報は入れません。"),
    );
    // the AI writes the setting
    const ai = el("div", "sim-ai");
    const flowSel = el("select");
    flowSel.id = "sim-flow";
    flowSel.setAttribute("aria-label", "救急外来の症候");
    const theme = el("input");
    theme.id = "sim-theme";
    theme.maxLength = THEME_LIMIT;
    theme.placeholder = "テーマ（病名・症候。例: 敗血症性ショック）";
    theme.setAttribute("aria-label", "テーマ");
    const level = el("select");
    level.id = "sim-level";
    level.setAttribute("aria-label", "難しさ");
    for (const l of LEVELS) level.append(new Option(`難しさ: ${l}`, l));
    level.value = "標準";
    const aiMsg = el("p", "msg err");
    aiMsg.hidden = true;
    const say = (t) => ((aiMsg.hidden = !t), (aiMsg.textContent = t));
    loadFlows().then((F) => {
      for (const f of Object.values(F).filter((x) => isEmergencyFlow(x.id))) flowSel.append(new Option(f.title, f.id));
    });
    const make = btn("AI に設定を作らせる", "btn primary", async () => {
      const t = theme.value.trim();
      if (!t) return say("テーマを入れてください。");
      const hits = scan(t);
      if (hits.length) return say(`識別情報らしき文字があります（${hits.map((h) => h.label).join("、")}）。テーマは病名・症候だけにします。`);
      make.disabled = true;
      say("");
      const wait = el("p", "help", "AI が設定を書いています…（検査を通らなければ、1回だけ直させます）");
      ai.append(wait);
      try {
        const F = await loadFlows();
        const flow = F[flowSel.value];
        let j = await callSim({ op: "author", flow: flow.id, theme: t, level: level.value });
        let c = checkAiSetting(j, flow, readings);
        if (!c.ok && c.setting) {
          j = await callSim({ op: "author", flow: flow.id, theme: t, level: level.value, repair: { setting: c.setting, errors: c.errors.slice(0, 40) } });
          c = checkAiSetting(j, flow, readings);
        }
        if (!c.ok) return renderLoad("AI の設定が検査を通りませんでした。もう一度作るか、テーマを変えてください。", c.errors);
        S = fresh(c.setting, flow, Number(seg.value), []);
        renderPlay();
      } catch (e) {
        say(e.message);
      } finally {
        make.disabled = false;
        wait.remove();
      }
    });
    make.id = "sim-author";
    ai.append(el("label", "field", "救急外来の症候（フロー）"), flowSel, el("label", "field", "テーマと難しさ"), theme, level, aiMsg, el("div", "btn-row"));
    ai.lastChild.append(make);
    ai.append(el("p", "help", usageText()));
    body.append(ai);
    const ta = el("textarea", "case-text");
    ta.id = "sim-paste";
    ta.rows = 8;
    ta.setAttribute("aria-label", "設定（JSON）");
    ta.placeholder = '{ "v": 1, "flow": "emergency-department.…", … }';
    const seg = el("select");
    seg.id = "sim-minutes";
    seg.setAttribute("aria-label", "1区切りの分");
    for (const m of SEGMENT_CHOICES) seg.append(new Option(`1区切り＝${m}分（表示だけ）`, String(m)));
    seg.value = "10";
    const out = el("div");
    if (msg) out.append(el("div", "notice err", msg));
    if (errors.length) {
      const ul = el("ul", "sim-errors");
      for (const e of errors.slice(0, 30)) ul.append(el("li", null, `${e.where}: ${e.msg}`));
      out.append(ul);
    }
    const go = btn("読み込んで始める", "btn", async () => {
      const r = parseSetting(ta.value, await loadFlows(), readings);
      if (!r.ok) return renderLoad(r.error, r.report?.errors ?? []);
      S = fresh(r.setting, r.flow, Number(seg.value), r.report.missing ?? []);
      renderPlay();
    });
    go.id = "sim-load";
    ai.before(el("label", "field", "時計（1区切りの分。表示だけ）"), seg);
    ai.after(out);
    const paste = section("設定（JSON）を貼る（試験用）", false);
    paste.id = "sim-paste-sec";
    paste.append(el("p", "help", "先生や作成者が書いた設定を貼るときに使います。AI は使いません。"), ta, el("div", "btn-row"));
    paste.lastChild.append(go);
    body.append(paste);
  }

  const fresh = (setting, flow, minutes, missing) => ({ setting, flow, log: [], answers: {}, own: "", minutes, taken: new Set(), filter: "", ended: false, missing, busy: false, aiMsg: "", failed: null });

  // ---------------------------------------------------------------- playing
  /** One act of the doctor.  With an AI setting, the AI first fills what the act needs, or writes what happens at a boundary. */
  async function act(a) {
    if (S.busy) return;
    if (!isAi()) {
      S.log.push(a);
      return renderPlay();
    }
    const boundaryAct = a.act === "wait" || a.act === "stage";
    S.busy = true;
    S.aiMsg = "";
    S.failed = null;
    renderPlay();
    try {
      if (a.act === "ask" && needsFill(S.setting, S.flow, S.log, a.q, readings)) await fill([a.q]);
      if (a.act === "do") {
        const need = orderNeeds(S.setting, S.flow, S.log, a.key, readings);
        if (need.length) await fill(need);
      }
      if (boundaryAct) await boundary(a);
      else S.log.push(a);
    } catch (e) {
      S.aiMsg = e.message;
      if (boundaryAct) S.failed = a; // the time does not pass until the doctor tries again or goes on without the AI
      else S.log.push(a); // the act happens anyway: an item without a value answers "no setting" (never a negative)
    } finally {
      S.busy = false;
      renderPlay();
    }
  }

  /** The AI writes what happens at the boundary act `a` (checked before it is used). */
  async function boundary(a) {
    const before = replay(S.setting, S.flow, S.log, { readings });
    const log = [...S.log, a];
    const after = replay(S.setting, S.flow, log, { readings });
    const j = await callSim({ op: "next", flow: S.flow.id, setting: S.setting, log, state: before.internal.state, t: after.t, stage: after.stage });
    if (j.overlap?.length) throw new Error("AI の続きが、書籍の文を写していました。使いません。もう一度試してください。");
    const r = addContinuation(S.setting, S.flow, log, { kind: "boundary", after: log.length - 1, facts: j.facts ?? [], event: j.event, basis: j.basis ?? [] }, readings);
    if (!r.ok) throw new Error(`AI の続きが検査を通りませんでした（${r.errors.slice(0, 3).map((e) => e.msg).join("・")}）。使いません。`);
    S.setting = r.setting;
    S.log = log;
  }

  /** The AI gives values for items the state has none for yet (before the ask or the order that needs them). */
  async function fill(qs) {
    const now = replay(S.setting, S.flow, S.log, { readings });
    const j = await callSim({ op: "fill", flow: S.flow.id, setting: S.setting, log: S.log, state: now.internal.state, t: now.t, stage: now.stage, qs });
    if (j.overlap?.length) throw new Error("AI の答えが、書籍の文を写していました。使いません。");
    const facts = (j.facts ?? []).filter((f) => qs.includes(f.q));
    if (!facts.length) return;
    const r = addContinuation(S.setting, S.flow, S.log, { kind: "fill", after: S.log.length, facts, basis: [] }, readings);
    if (!r.ok) throw new Error(`AI の答えが検査を通りませんでした（${r.errors.slice(0, 3).map((e) => e.msg).join("・")}）。`);
    S.setting = r.setting;
  }

  function renderPlay() {
    const r = play();
    const { setting, flow } = S;
    const hm = clockAt(setting, r.t, S.minutes);
    const stageIdx = STAGES.findIndex((s) => s.id === r.stage);
    body.replaceChildren();

    // the mark of a fictional case and where its setting came from
    const mark = el("p", "notice sim-mark", `${SIM_MARK}・設定の出どころ: ${isAi() ? "AI（書籍を根拠に作成・医師未確認）" : "貼った設定（医師未確認）"}`);
    mark.id = "sim-mark";
    body.append(mark);
    if (isAi()) {
      const src = section("AI が根拠にした書籍の節", false);
      src.id = "sim-sources";
      const ul = el("ul");
      for (const x of setting.origin.sources ?? []) ul.append(el("li", null, `${x.title} ${x.page}`));
      if (!(setting.origin.sources ?? []).length) ul.append(el("li", null, "（見つかった節はありません）"));
      src.append(ul);
      body.append(src, el("p", "help sim-usage", `${usageText()}・この症例で AI が書いた続き: ${contCount(setting)}件`));
    }
    if (S.busy) body.append(el("p", "notice", "AI が続きを書いています…"));
    if (S.aiMsg) {
      const m = el("div", "notice err", S.aiMsg);
      m.id = "sim-ai-msg";
      if (S.failed) {
        const a = S.failed;
        const row = el("div", "btn-row");
        const again = btn("もう一度", "btn small", () => act(a));
        again.id = "sim-retry";
        const without = btn("AI なしで進める（時間だけ進む）", "btn small", () => ((S.log.push(a), (S.failed = null), (S.aiMsg = "")), renderPlay()));
        without.id = "sim-without";
        row.append(again, without);
        m.append(row);
      }
      body.append(m);
    }
    const head = el("div", "sim-head");
    head.append(
      el("p", "sim-patient", `${setting.patient.age}歳 ${setting.patient.sex}`),
      el("p", "sim-clock", `時刻 ${hm || "—"}（区切り ${r.t}）・段: ${STAGES[stageIdx].label}`),
    );
    for (const o of setting.opening ?? []) head.append(el("p", "sim-opening", `${o.who}: ${o.text}`));
    body.append(head);
    if (S.missing.length) body.append(el("p", "help", `この設定には値のない項目が ${S.missing.length} 件あります（聞くと「設定がありません」と返ります。陰性ではありません）。`));

    const row = el("div", "btn-row");
    const wait = btn("待つ（時間を1区切り進める）", "btn", () => act({ act: "wait" }));
    wait.id = "sim-wait";
    row.append(wait);
    const next = STAGES[stageIdx + 1];
    if (next) {
      const nb = btn(`次の段へ（${next.label}）`, "btn", () => act({ act: "stage", to: next.id }));
      nb.id = "sim-next";
      row.append(nb);
    }
    body.append(row);
    if (r.pending.length) body.append(el("p", "help", `結果待ち: ${r.pending.map((k) => actText(flow, k)).join("、")}（次の区切りで返ります）`));

    // ask / examine / measure: only what the doctor's knowledge and acts make visible
    const askSec = section("聞く・診る・測る");
    const filter = el("input");
    filter.type = "search";
    filter.id = "sim-filter";
    filter.placeholder = "項目の名前で絞る";
    filter.value = S.filter;
    const list = el("div", "sim-asks");
    const can = new Set(r.askable);
    const drawAsks = () => {
      list.replaceChildren();
      for (const { phase, questions } of byPhase(flow)) {
        const qs = questions.filter((q) => can.has(q.id) && (!S.filter || plain(q.label).includes(S.filter)));
        if (!qs.length) continue;
        list.append(el("p", "sim-phase", phase.short ?? phase.name));
        const g = el("div", "sim-chips");
        for (const q of qs) {
          const b = btn(plain(q.label), "chip", () => act({ act: "ask", q: q.id }));
          b.dataset.q = q.id;
          g.append(b);
        }
        list.append(g);
      }
    };
    filter.addEventListener("input", () => {
      S.filter = filter.value.trim();
      drawAsks();
    });
    drawAsks();
    askSec.append(filter, list);
    body.append(askSec);

    // the board: the doctor's acts (orders, treatments), the same for every case of the flow
    const board = section("行為を記録する（オーダー・処置。用量の欄はありません）", false);
    board.id = "sim-board";
    for (const q of boardQuestions(flow)) {
      board.append(el("p", "sim-phase", plain(q.label)));
      const g = el("div", "sim-chips");
      for (const o of q.options) {
        const key = `${q.id}=${o.id}`;
        const b = btn(o.short || o.label, "chip", () => {
          S.answers = applyAct(flow, S.answers, key, hm);
          act({ act: "do", key });
        });
        b.dataset.key = key;
        g.append(b);
      }
      board.append(g);
    }
    body.append(board);

    // explanation / consult / disposition in the doctor's words
    const saySec = section("説明・相談・行き先（先生の言葉で）", false);
    const sayType = el("select");
    sayType.id = "sim-say-type";
    for (const t of SAY_TYPES) sayType.append(new Option(SAY_LABELS[t], t));
    const sayText = el("textarea", "case-text");
    sayText.id = "sim-say";
    sayText.rows = 2;
    sayText.maxLength = 400;
    const sayMsg = el("p", "msg err");
    sayMsg.hidden = true;
    const sayBtn = btn("記録する", "btn", () => {
      const hits = scan(sayText.value);
      if (hits.length) {
        sayMsg.hidden = false;
        sayMsg.textContent = `識別情報らしき文字があります（${hits.map((h) => h.label).join("、")}）。架空症例に入れません。`;
        return;
      }
      act({ act: "say", type: sayType.value, text: sayText.value });
    });
    sayBtn.id = "sim-say-add";
    saySec.append(sayType, sayText, sayMsg, el("div", "btn-row"));
    saySec.lastChild.append(sayBtn);
    body.append(saySec);

    // the tray: what the case told, taken in only by the doctor
    const rows = trayRows(flow, r.records, S.answers).filter((x) => !S.taken.has(x.id));
    const tray = section(`受け皿（聞いた答え。入れるまで記載に入りません）${rows.length ? `　${rows.length}件` : ""}`);
    tray.id = "sim-tray";
    if (!rows.length) tray.append(el("p", "help", "まだありません。"));
    const picked = new Set();
    for (const x of rows) {
      const line = el("div", "sim-row");
      line.dataset.row = x.id;
      const text = el("span", null, `${x.who}: ${x.text}`);
      if (x.filled) {
        line.append(text, el("span", "help", "（入力済み。上書きしません）"));
        line.append(btn("片付ける", "btn small", () => (S.taken.add(x.id), renderPlay())));
      } else if (x.careful) {
        line.append(text, el("span", "help", "（1件ずつ確かめる）"));
        line.append(btn("入れる", "btn small", () => ((S.answers = takeRows(flow, S.answers, [x])), S.taken.add(x.id), renderPlay())));
      } else {
        const cb = el("input");
        cb.type = "checkbox";
        cb.addEventListener("change", () => (cb.checked ? picked.add(x.id) : picked.delete(x.id)));
        const lab = el("label", "check");
        lab.append(cb, text);
        line.append(lab);
      }
      tray.append(line);
    }
    if (rows.some((x) => !x.filled && !x.careful)) {
      const take = btn("選んだものを入れる", "btn", () => {
        const chosen = rows.filter((x) => picked.has(x.id));
        S.answers = takeRows(flow, S.answers, chosen);
        for (const x of chosen) S.taken.add(x.id);
        renderPlay();
      });
      take.id = "sim-take";
      tray.append(el("div", "btn-row"));
      tray.lastChild.append(take);
    }
    body.append(tray);

    // the doctor's readings and decisions, filled in directly
    const mine = section("先生が選ぶ項目（読み・判断・行き先）", false);
    mine.id = "sim-mine";
    for (const { phase, questions } of doctorQuestions(flow, S.answers, setting.patient.sex, readings)) {
      mine.append(el("p", "sim-phase", phase.short ?? phase.name));
      for (const q of questions) mine.append(control(q));
    }
    body.append(mine);

    const ownSec = section("自分のアセスメントとプラン（記載の Assessment に入ります）", false);
    const own = el("textarea", "case-text");
    own.id = "sim-own";
    own.rows = 4;
    own.value = S.own;
    const ownMsg = el("p", "msg err");
    ownMsg.hidden = true;
    own.addEventListener("change", () => {
      const hits = scan(own.value);
      ownMsg.hidden = !hits.length;
      ownMsg.textContent = hits.length ? `識別情報らしき文字があります（${hits.map((h) => h.label).join("、")}）。架空症例に入れません。` : "";
      if (!hits.length) {
        S.own = own.value;
        renderPlay();
      }
    });
    ownSec.append(own, ownMsg);
    body.append(ownSec);

    // the running memo
    const memo = section("経時メモ（消しません）");
    memo.id = "sim-memo";
    const ol = el("ol", "sim-memo");
    for (const m of memoLines(setting, flow, r.records, S.minutes)) ol.append(el("li", m.kind, `${m.clock} ${m.who ? m.who + ": " : ""}${m.text}`));
    memo.append(ol);
    body.append(memo);

    // the note: A04 from the answers, read only
    const noteSec = section("記載（救急外来初療 A04。読み取り専用）", false);
    const text = noteText();
    const pre = el("pre", "sim-note", text);
    pre.id = "sim-note";
    const copyBtn = btn("記載をコピー（架空の見出しつき）", "btn", async () => {
      const ok = await copyText(text);
      copyMsg.textContent = ok ? "コピーしました。" : "コピーできませんでした。";
    });
    const copyMsg = el("p", "help", "");
    noteSec.append(pre, el("div", "btn-row"), copyMsg);
    noteSec.children[2].append(copyBtn);
    body.append(noteSec);

    const end = el("div", "btn-row");
    const deb = btn("振り返り（設定の想定を開く）", "btn", () => {
      if (!confirm("設定の想定（診断・鑑別・鍵の所見など）を開きます。開くと、この模擬の答えが分かります。開きますか？")) return;
      S.ended = true;
      renderDebrief();
    });
    deb.id = "sim-debrief";
    end.append(deb, btn("別の設定にする", "btn", () => ((S = null), renderLoad())));
    body.append(end);
  }

  /** A control for one of the doctor's own questions (choice / multi / text / number), writing the answers in memory. */
  function control(q) {
    const wrap = el("div", "sim-ctl");
    wrap.dataset.q = q.id;
    wrap.append(el("span", "field", plain(q.label)));
    const v = S.answers[q.id];
    const set = (val) => {
      S.answers = setAnswer(S.flow, S.answers, q.id, val);
      renderPlay();
    };
    if (q.type === "choice") {
      const s = el("select");
      s.append(new Option("（未選択）", ""));
      for (const o of q.options) s.append(new Option(o.short || o.label, o.id));
      s.value = typeof v === "string" ? v : "";
      s.addEventListener("change", () => set(s.value));
      wrap.append(s);
    } else if (q.type === "multi") {
      const cur = new Set(Array.isArray(v) ? v : []);
      for (const o of q.options) {
        const cb = el("input");
        cb.type = "checkbox";
        cb.checked = cur.has(o.id);
        cb.addEventListener("change", () => set(cb.checked ? [...cur, o.id] : [...cur].filter((x) => x !== o.id)));
        const lab = el("label", "check");
        lab.append(cb, el("span", null, o.short || o.label));
        wrap.append(lab);
      }
    } else {
      const i = el("input");
      i.type = q.type === "number" ? "number" : "text";
      i.value = isAnswered(v) ? String(v) : "";
      i.addEventListener("change", () => {
        if (q.type !== "number" && scan(i.value).length) return; // identifiers are not kept
        set(q.type === "number" ? (i.value === "" ? "" : Number(i.value)) : i.value.trim());
      });
      wrap.append(i);
    }
    return wrap;
  }

  function noteText() {
    const note = assemble("A04", { kase: simKase(S.setting, S.flow, S.answers, S.own), flow: S.flow });
    return `${SIM_HEADER}\n${toText(note)}`;
  }

  // ---------------------------------------------------------------- the debrief: side by side, nothing judged
  function renderDebrief() {
    const r = play();
    const d = debrief(S.setting, S.flow, r.records);
    body.replaceChildren();
    body.append(el("p", "notice sim-mark", `${SIM_MARK}・振り返り（並べるだけです。点数や正誤は付けません）`));
    const a = section("設定の想定（作成者の想定・医師未確認）");
    a.id = "sim-assumed";
    const dl = el("dl", "sim-assumed");
    const pair = (k, v) => dl.append(el("dt", null, k), el("dd", null, v));
    pair("想定した診断", (d.assumed.dx ?? []).join("、") || "—");
    pair("鑑別", (d.assumed.ddx ?? []).join("、") || "—");
    pair("落とし穴", d.assumed.pitfall || "—");
    pair("教訓", d.assumed.lesson || "—");
    if (isAi()) {
      pair("設定の出どころ", "AI（書籍を根拠に作成・医師未確認）");
      pair("AI が書いた続き", `${contCount(S.setting)}件`);
      pair("根拠にした書籍の節", (S.setting.origin.sources ?? []).map((x) => `${x.title} ${x.page}`).join("、") || "—");
    }
    a.append(dl);
    body.append(a);
    const k = section("鍵の所見");
    k.id = "sim-key";
    const ul = el("ul");
    for (const x of d.key) ul.append(el("li", null, `${x.label}: ${KEY_STATUS[x.status]}`));
    k.append(ul);
    body.append(k);
    const o = section("自分のアセスメントとプラン");
    o.append(el("pre", "sim-note", S.own || "（書いていません）"));
    body.append(o);
    const memo = section("経時メモ");
    const ol = el("ol", "sim-memo");
    for (const m of memoLines(S.setting, S.flow, r.records, S.minutes)) ol.append(el("li", m.kind, `${m.clock} ${m.who ? m.who + ": " : ""}${m.text}`));
    memo.append(ol);
    body.append(memo);
    body.append(el("div", "btn-row"));
    body.lastChild.append(btn("同じ設定で最初から", "btn", () => ((S = { ...fresh(baseSetting(S.setting), S.flow, S.minutes, S.missing) }), renderPlay())), btn("別の設定にする", "btn", () => ((S = null), renderLoad())));
  }

  return {
    open() {
      if (!S) renderLoad();
      openDialog(dlg);
    },
  };
}
