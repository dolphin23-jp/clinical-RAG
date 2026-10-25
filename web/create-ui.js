// Screen for creating a fictional case from the books (docs/enhancement-plan.md 7.4): the "架空症例を作る" dialog, and under a created
// case the checks (copied book text, dose/threshold/date/identifier-like text), the button that puts the case into case mode, and the
// draft of a clinical-modules training case.  Read-only: nothing is sent, saved, exported, printed or shared from here (the request
// itself goes through the app's own /api/ask call); the draft is copied as text.  Every string reaches the DOM through textContent.
import { COURSE_DAYS, CREATE_LIMITS, LEVELS, SETTINGS, emptyCreate } from "./case-model.js";
import { COURSE_HEADING, MIN_OVERLAP, headingBase, parseCreated, scanCreated, toCase, toModulesDraft } from "./case-create.js";

export function initCreate(ctx) {
  const { el, $, openDialog, runCreate, pinCase, copyText } = ctx;
  const dlg = $("#create");
  const theme = $("#create-theme");
  const setting = $("#create-setting");
  const level = $("#create-level");
  const goal = $("#create-goal");
  const pitfall = $("#create-pitfall");
  const days = $("#create-days");
  const msg = $("#create-msg");

  theme.maxLength = CREATE_LIMITS.theme;
  goal.maxLength = CREATE_LIMITS.goal;
  setting.append(new Option("（指定なし）", ""));
  for (const v of SETTINGS) setting.append(new Option(v, v));
  for (const v of LEVELS) level.append(new Option(v, v));
  for (const n of COURSE_DAYS) days.append(new Option(n ? `入院${n}日目まで、日ごとに作る` : "作らない（症例だけ）", String(n)));

  const read = () => ({ ...emptyCreate(), theme: theme.value.trim(), setting: setting.value, level: level.value, goal: goal.value.trim(), pitfall: pitfall.checked, days: Number(days.value) || 0 });

  $("#create-run").addEventListener("click", () => {
    const params = read();
    if (!params.theme) {
      msg.hidden = false;
      msg.textContent = "テーマ（病名・症候）を入力してください。";
      return;
    }
    msg.hidden = true;
    dlg.close();
    runCreate(params);
  });

  /** The notices and buttons under a created case.  `ev.overlap` is the Worker's copied-text check ([] = checked, none found). */
  function decorate(turn, ev) {
    if (turn.mode !== "create") return;
    // the assessment is folded away at first: the doctor is to think the case through before looking
    for (const sec of turn.body.querySelectorAll("details.sec")) if (headingBase(sec.querySelector("summary")?.textContent ?? "") === "見立て") sec.open = false;

    const text = turn.annotated || turn.answer || "";
    const asked = turn.create?.days ?? 0;
    const parsed = parseCreated(text, { days: asked });
    // the course is for practice: folded like the assessment, and read here one day at a time
    for (const sec of turn.body.querySelectorAll("details.sec")) if (headingBase(sec.querySelector("summary")?.textContent ?? "") === COURSE_HEADING) sec.open = false;
    const found = scanCreated(text);
    const overlaps = Array.isArray(ev.overlap) ? ev.overlap : null;
    const panel = el("div", "create-panel");
    const warn = (t, kind = "") => panel.append(el("div", "notice" + (kind ? " " + kind : ""), t));

    if (parsed.absent.length) warn(`読み取れなかった見出し: ${parsed.absent.join("、")}。見出しが決まった形で出なかったため、その部分は症例モードにもModules用の下書きにも入りません。`);
    if (overlaps === null) warn("この往復には、書籍の文との重なりの検査の結果がありません（検査されていません）。Modules 用の下書きのコピーは止めています。", "err");
    else if (overlaps.length) {
      warn(`書籍の文と ${MIN_OVERLAP} 字以上続けて一致した箇所があります（写している可能性。書籍の症例文は写さない決まりです）。Modules 用の下書きのコピーは止めています。作り直してください。`, "err");
      const ul = el("ul", "overlaps");
      for (const o of overlaps) ul.append(el("li", null, `${o.page || "頁不明"} と ${o.length} 字一致: 「${o.text}」`));
      panel.append(ul);
    }
    if (found.ids.length) warn(`識別情報らしき文字が含まれます（${found.ids.join("、")}）。架空症例に入れない決まりです。Modules 用の下書きのコピーは止めています。`, "err");
    if (found.dates.length) warn(`日付らしい文字があります（${found.dates.join("、")}）。実在の症例を思わせるので、経過日数に直してください。`);
    if (found.doses.length || found.thresholds.length) {
      warn(`用量・閾値らしい数値があります（${[...found.doses, ...found.thresholds].join("、")}）。架空症例には書かない決まりです。例示の検査値であれば、そのままで構いません。`);
    }
    const blocked = overlaps === null || overlaps.length > 0 || found.ids.length > 0;
    if (asked && parsed.missingDays.length && !parsed.absent.includes(COURSE_HEADING)) warn(`作られなかった日があります: ${parsed.missingDays.map((n) => `入院${n}日目`).join("、")}。作り直してください。`);
    if (asked && parsed.course.length) panel.append(coursePractice(parsed.course, found, blocked));

    const row = el("div", "btn-row");
    const { kase, notes, ok } = toCase(parsed);
    const pin = el("button", "btn primary", "この症例を症例モードに入れる");
    pin.type = "button";
    pin.disabled = !ok;
    const pinMsg = el("p", "help");
    pin.addEventListener("click", () => {
      pinCase(kase);
      pinMsg.textContent = `症例モードに入れました（見立ては入れていません）。ヘッダーの「症例」で確認できます。${notes.length ? ` ${notes.join("。")}。` : ""}`;
    });
    const draftBtn = el("button", "btn", "Modules 用の下書き（TOML）を見る");
    draftBtn.type = "button";
    row.append(pin, draftBtn);
    panel.append(row, pinMsg);
    if (notes.length && ok) panel.append(el("p", "help", `症例モードに入れるとき: ${notes.join("。")}。`));

    const draft = el("div", "create-draft");
    draft.hidden = true;
    const sources = [...turn.cites.values()].filter((c) => c.kind === "book").map((c) => ({ book_id: c.book_id, page: c.page }));
    const toml = toModulesDraft(parsed, { theme: turn.create?.theme ?? "", level: turn.create?.level ?? "", sources });
    const pre = el("pre", "note-text", toml);
    const copy = el("button", "btn primary", "下書きをコピー");
    copy.type = "button";
    copy.disabled = blocked;
    copy.addEventListener("click", async () => {
      await copyText(toml);
      copy.textContent = "コピーしました";
      setTimeout(() => (copy.textContent = "下書きをコピー"), 1800);
    });
    draft.append(
      el("p", "help", `${blocked ? "上の警告があるため、コピーは止めています（内容は確認できます）。作り直してください。" : ""}clinical-modules の訓練症例（drills/*.toml）の下書きです。[case.answers] は作りません（フローの質問IDへの変換は、clinical-modules 側で、先生が確認しながら行います）。[要変更]・[要変換]・[要照合] を直してから使ってください。`),
      pre,
      copy,
    );
    draftBtn.addEventListener("click", () => (draft.hidden = !draft.hidden));
    panel.append(draft);
    turn.notices.before(panel);
  }

  /**
   * The course read one day at a time (practice): day 1 is shown, the next day only when the doctor asks, so a note can be written from what is known
   * so far.  Nothing is sent or saved; copying the whole course is stopped when the answer has an identifier-like text or a copied passage.
   */
  function coursePractice(course, found, blocked) {
    const box = el("div", "create-course");
    box.append(el("h4", null, "経過の練習（1日ずつ見る）"));
    box.append(el("p", "help", "架空の経過です（実在の患者の経過ではありません。数値は例示で、書籍の典型的な経過に沿って作ったものです）。その日までに分かったことから、先生が自分でその日の記載を書き、そのあとで次の日を開いてください。"));
    const list = el("div", "course-days");
    const more = el("button", "btn primary", "");
    more.type = "button";
    const all = el("button", "btn", "残りの日をすべて見る");
    all.type = "button";
    let shown = 0;
    const show = () => {
      const d = course[shown];
      const card = el("div", "course-day");
      card.dataset.day = String(d.day);
      card.append(el("h5", null, d.heading));
      const dl = el("dl", "course-parts");
      for (const p of d.parts) dl.append(el("dt", null, p.label), el("dd", null, p.text || "（なし）"));
      card.append(dl);
      list.append(card);
      shown += 1;
      const last = shown >= course.length;
      more.hidden = all.hidden = last;
      if (!last) more.textContent = `${course[shown].heading}を見る →`;
    };
    more.addEventListener("click", show);
    all.addEventListener("click", () => {
      while (shown < course.length) show();
    });
    const copy = el("button", "btn", "経過をコピー");
    copy.type = "button";
    copy.disabled = blocked;
    copy.addEventListener("click", async () => {
      const t = course.map((d) => `${d.heading}\n${d.parts.map((p) => `・${p.label}: ${p.text}`).join("\n")}`).join("\n\n");
      await copyText(`※架空の経過です。実在の患者ではありません。数値は例示です。\n\n${t}`);
      copy.textContent = "コピーしました";
      setTimeout(() => (copy.textContent = "経過をコピー"), 1800);
    });
    show();
    box.append(list, el("div", "btn-row", ""));
    box.lastChild.append(more, all, copy);
    if (blocked) box.append(el("p", "help", "上の警告があるため、コピーは止めています（画面では読めます）。作り直してください。"));
    if (found.doses.length || found.thresholds.length) box.append(el("p", "help", "用量・閾値らしい数値の警告が出ています。経過には書かない決まりです。例示の検査値であれば、そのままで構いません。"));
    return box;
  }

  return {
    decorate,
    open() {
      msg.hidden = true;
      openDialog(dlg);
    },
  };
}
