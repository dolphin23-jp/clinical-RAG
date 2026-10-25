"""Browser test of the scene x symptom intake in the case dialog (docs/enhancement-plan.md 8; docs/clinical-use.md 1e)
against worker/test/devserver.ts on the synthetic fixture (iPad width).

  python3 -m ingest build --db /tmp/fx.sqlite fx tests/fixtures/synthetic_ch.md
  node --no-warnings worker/test/devserver.ts /tmp/fx.sqlite 8787 &
  python3 tests/e2e/ui_intake.py http://localhost:8787 OUT_DIR

Checks: the panel (collapsed, questions loaded on first open, flows grouped by scene), the controls by type (chips that can be
unchosen, number, time, text), the sex-specific question appearing with the case's sex, the core-question count and the list of
unanswered ones (and jumping to one), dates typed or pasted becoming relative (no calendar date kept anywhere), what the request
carries (the rendered answers; not the form's own answers), what is saved with the conversation and restored from it, a form that
cannot be restored, the identifier prompt covering the answers, the chart-note stopgap, and that nothing is kept in browser storage.
"""
import json
import re
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8787"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/ui_intake")
OUT.mkdir(parents=True, exist_ok=True)
TOKEN = "test-token-0123456789abcdef"
FLOW = "emergency-department.abdominal-pain"
passed, fails = [], []


def check(cond, msg):
    (passed if cond else fails).append(msg)
    print(("PASS " if cond else "FAIL ") + msg, flush=True)


with sync_playwright() as pw:
    br = pw.chromium.launch()
    ctx = br.new_context(viewport={"width": 820, "height": 1180}, device_scale_factor=2, has_touch=True, is_mobile=True, locale="ja-JP")
    page = ctx.new_page()
    logs, asks = [], []
    page.on("console", lambda m: logs.append((m.type, m.text)) if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
    page.on("dialog", lambda d: d.accept())

    def on_request(r):
        if r.url.endswith("/api/ask") and r.method == "POST":
            asks.append(json.loads(r.post_data))

    page.on("request", on_request)
    page.goto(BASE + "/")
    page.evaluate(f"localStorage.setItem('mb.token','{TOKEN}')")
    page.reload()
    page.wait_for_function("() => document.querySelector('#chip-books').textContent.includes('(1)')")

    def api(method, path, body=None):
        return page.evaluate(
            """async ([m, p, b, t]) => { const r = await fetch(p, {method: m, headers: {authorization: 'Bearer ' + t, 'content-type': 'application/json'}, body: b ? JSON.stringify(b) : undefined});
               return {status: r.status, body: await r.json().catch(() => null)}; }""",
            [method, path, body, TOKEN],
        )

    def q(qid):
        return page.locator(f".intake-q[data-q={qid}]")

    def open_all():
        page.evaluate("() => document.querySelectorAll('details.intake-phase, details.intake-more').forEach((d) => { d.open = true; })")

    def progress():
        m = re.search(r"(\d+)/(\d+)", page.locator(".intake-progress").inner_text())
        return int(m.group(1)), int(m.group(2))

    def missing_count():
        m = re.search(r"（(\d+)件）", page.locator(".intake-missing > summary").inner_text())
        return int(m.group(1)) if m else 0

    def wait_done(n):
        expect(page.locator(".turn")).to_have_count(n)
        page.locator(".turn").nth(n - 1).locator(".foot button").first.wait_for(timeout=20000)

    api("DELETE", "/api/conversations")

    # 1. the panel is there, closed; the questions load when it is first opened; flows are grouped by scene
    page.click("#btn-case")
    panel = page.locator("details.intake")
    check(panel.is_visible() and panel.get_attribute("open") is None, "the panel is closed at first")
    check("場面・症候の質問で入力する（試作）" in panel.locator("summary").first.inner_text(), "the panel is named")
    check(not page.locator(".intake-progress").is_visible(), "no progress line before a flow is chosen")
    panel.locator("summary").first.click()
    expect(page.locator("#intake-flow option")).to_have_count(14)
    groups = [g.get_attribute("label") for g in page.locator("#intake-flow optgroup").all()]
    check(groups == ["救急外来", "外来初診"], f"flows grouped by scene ({groups})")
    check("未確認" in panel.inner_text() and "陰性にはしません" in panel.inner_text(), "the panel says a blank is 未確認, not negative")
    page.screenshot(path=str(OUT / "01_panel.png"))

    # 2. choosing a flow: phases, the core count, the list of unanswered core questions
    page.select_option("#intake-flow", FLOW)
    check(page.locator("details.intake-phase").count() == 5, "five phases")
    done, total = progress()
    check(done == 0 and total >= 30, f"core questions counted, none answered ({done}/{total})")
    check(missing_count() == total, "the list of unanswered core questions has all of them")
    check(not q("age").count() and not q("sex").count(), "age and sex are not asked again (they are the case's own)")
    check(q("preg").get_attribute("hidden") is not None, "the question for women is hidden while the case has no sex")
    page.select_option("#case-sex", "女性")
    check(q("preg").get_attribute("hidden") is None, "it appears when the case says female")
    check(progress()[1] == total + 1 and missing_count() == total + 1, "and it counts as a core question")
    page.select_option("#case-sex", "男性")
    check(q("preg").get_attribute("hidden") is not None and progress()[1] == total, "and goes again when the case says male")
    open_all()

    # 3. the controls by type
    chip = lambda qid, opt: q(qid).locator(f"button.chip[data-opt={opt}]")  # noqa: E731
    pressed_of = lambda qid: [b.get_attribute("data-opt") for b in q(qid).locator("button[aria-pressed=true]").all()]  # noqa: E731
    chip("first", "sick").click()
    check(chip("first", "sick").get_attribute("aria-pressed") == "true" and chip("first", "notsick").get_attribute("aria-pressed") == "false", "a choice: one chip pressed")
    chip("ems_state", "stable").click()
    chip("ems_state", "stable").click()
    check(chip("ems_state", "stable").get_attribute("aria-pressed") == "false", "tapping the chosen chip again takes the answer back (a blank stays possible)")
    chip("assoc", "nausea").click()
    chip("assoc", "fever").click()
    pressed = pressed_of("assoc")
    check(pressed == ["nausea", "fever"], f"a multi choice: several chips ({pressed})")
    chip("assoc", "none").click()
    pressed = pressed_of("assoc")
    check(pressed == ["none"], "choosing 'none' clears the others")
    chip("assoc", "nausea").click()
    pressed = pressed_of("assoc")
    check(pressed == ["nausea"], "and choosing another clears 'none'")
    q("t_arrival").locator("input").fill("21:40")
    q("temp").locator("input").fill("38.4")
    check(q("temp").locator(".intake-unit").inner_text() == "℃" and q("rr").locator("input").is_visible(), "numbers are plain inputs with their unit (recorded, never judged: no colour, no range)")
    check(progress()[0] == 3, f"first, t_arrival and assoc are core questions: three answered ({progress()})")
    check(missing_count() == total - 3, "and the unanswered list shrank by three")
    page.screenshot(path=str(OUT / "02_answers.png"))

    # 4. an unanswered core question can be jumped to from the list
    page.locator(".intake-missing > summary").click()
    page.locator(".intake-jump", has_text="発症様式").click()
    page.wait_for_timeout(250)
    check("flash" in (q("onset").get_attribute("class") or ""), "tapping a listed question goes to it")
    chip("onset", "gradual").click()
    check(progress()[0] == 4, "answering it counts")

    # 5. dates: typed (on leaving the field) and pasted become relative; fractions and pressures stay; the note says so
    ems = q("ems_info").locator("textarea")
    ems.fill("10/22 から腹痛。血圧 120/80、2/3 に減量")
    ems.blur()
    v = ems.input_value()
    check("10/22" not in v and "日前" in v and "120/80" in v and "2/3" in v, f"a typed date becomes relative on leaving the field ({v})")
    check("日付を経過の表現に直しました" in page.locator("details.intake").inner_text(), "a passive note says so (nothing to confirm)")
    memo = q("dispo_why").locator("textarea")
    memo.evaluate("(el) => { el.value = '2026年10月20日に入院、10月22日に再燃'; el.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste', bubbles: true })); }")
    v2 = memo.input_value()
    check(not re.search(r"\d{4}年|\d{1,2}月\d{1,2}日", v2) and "入院" in v2, f"a pasted date is converted at once ({v2})")
    page.screenshot(path=str(OUT / "03_dates.png"))

    # 6. the free-text fields of the case convert too, and pinning converts what was typed
    page.fill("#case-complaint", "腹痛。10/21 に受診した。")
    page.fill("#case-history", "高血圧")
    page.fill("#case-age", "52")
    page.select_option("#case-setting", "救急")
    page.click("#case-pin")
    expect(page.locator("#case")).not_to_be_visible()
    check("10/21" not in page.evaluate("() => document.querySelector('#casebar-text').textContent"), "the bar shows no date")
    bar = page.locator("#casebar-text").inner_text()
    check("52歳・男性・救急" in bar and "腹痛" in bar, f"the bar summarises the case ({bar})")

    # 7. the request: the rendered answers (not the form's own answers); no calendar date; unanswered core questions named as such
    page.click("#case-modes button[data-mode=ddx]")
    wait_done(1)
    case = asks[-1]["case"]
    s = case["structured"]
    check("intake" not in case, "the form's own answers are not sent to the Worker")
    check(s.startswith("場面・症候: 救急外来 × 腹痛（"), "the flow is named first")
    for needle in ("第一印象：sick", "病着：21:40", "体温：38.4 ℃", "随伴症状：嘔気", "発症様式：徐々に発症"):
        check(needle in s, f"in the request: {needle}")
    check("未入力の中核項目（" in s and "未確認" in s, "unanswered core questions are listed as 未確認")
    check("救急隊の事前情報" not in s, "an unanswered question is not in the text at all (no 'none', no 'normal')")
    blob = json.dumps(asks[-1], ensure_ascii=False)
    check("10/22" not in blob and "10/21" not in blob and "2026年" not in blob, "no calendar date was sent")
    check("2/3" in blob and "120/80" in blob, "fractions and blood pressures are as typed")
    check(case["complaint"].startswith("腹痛。") and "日前" in case["complaint"], f"the free-text fields were converted at pinning ({case['complaint']})")
    turn = page.locator(".turn").first
    turn.locator(".casebox summary").click()
    check("場面・症候の入力" in turn.locator(".casebox").inner_text() and "体温：38.4 ℃" in turn.locator(".casebox").inner_text(), "the case box shows the answers that were sent")

    # 8. what is saved with the conversation: the answers (for reopening the form), converted
    page.wait_for_timeout(300)
    convs = api("GET", "/api/conversations")["body"]["conversations"]
    saved = api("GET", "/api/conversations/" + convs[0]["id"])["body"]
    pc = saved["turns"][0]["payload"]["case"]
    check(pc["intake"]["flow"] == FLOW and pc["intake"]["answers"]["first"] == "sick" and pc["intake"]["answers"]["temp"] == 38.4, "the answers are saved with the turn")
    check("10/22" not in json.dumps(saved, ensure_ascii=False), "and no calendar date is saved")

    # 9. editing the pinned case puts the form back
    page.click("#casebar-open")
    check(page.locator("details.intake").get_attribute("open") is not None, "the panel opens by itself when the case carries answers")
    expect(page.locator("#intake-flow")).to_have_value(FLOW)
    open_all()
    check(chip("first", "sick").get_attribute("aria-pressed") == "true" and q("temp").locator("input").input_value() == "38.4" and q("t_arrival").locator("input").input_value() == "21:40", "chips, number and time come back")
    check(progress()[0] == 4, f"the count comes back ({progress()})")
    check("日前" in q("ems_info").locator("textarea").input_value(), "and so does the (converted) text")

    # 10. an identifier-like word in an answer is warned about while typing, and asked about before sending
    q("unexplained").locator("textarea").fill("カルテ番号 12345678 の件")
    warn = page.locator("#case-warn")
    check(warn.is_visible() and "「カルテ番号」の語" in warn.inner_text() and "12345678" not in warn.inner_text(), "an identifier-like word in an answer warns (kind only)")
    page.click("#case-pin")
    sent = len(asks)
    page.click("#case-modes button[data-mode=miss]")
    expect(page.locator("#guard")).to_be_visible()
    check("「カルテ番号」の語" in page.locator("#guard-list").inner_text(), "the identifier prompt covers the answers too")
    page.click("#guard-fix")
    page.wait_for_timeout(200)
    check(len(asks) == sent, "fix: nothing was sent")
    page.click("#casebar-open")
    expect(page.locator("#intake-flow")).to_have_value(FLOW)
    open_all()
    q("unexplained").locator("textarea").fill("")
    check(not warn.is_visible(), "the warning clears with the words")
    page.click("#case-pin")

    # 11. the sex of the case changes which questions are asked, and the text follows
    page.click("#casebar-open")
    expect(page.locator("#intake-flow")).to_have_value(FLOW)
    page.select_option("#case-sex", "女性")
    open_all()
    chip("preg", "test_neg").click()
    page.click("#case-pin")
    page.click("#case-modes button[data-mode=consult]")
    wait_done(2)
    s2 = asks[-1]["case"]["structured"]
    check("月経歴・妊娠の可能性・産褥：妊娠反応 陰性" in s2, "the answer to the question for women is sent when the case is female")
    page.click("#casebar-open")
    page.select_option("#case-sex", "男性")
    page.click("#case-pin")
    page.click("#case-modes button[data-mode=consult]")
    wait_done(3)
    check("妊娠" not in asks[-1]["case"]["structured"], "and not when the sex is changed to male (the question is gone)")

    # 12. the chart note (docs/enhancement-plan.md 8.18): A04 sends each answer to the field ROUTES gives its question's category (question -> cat -> ROUTES);
    #     what no field takes stays in a block of its own, counted on the screen; a note type that the flow's categories do not belong to keeps the text whole
    page.click("#casebar-note")
    dlg = page.locator("#note")
    expect(dlg).to_be_visible()
    text = page.locator("#note-text").inner_text()
    check(page.input_value("#note-type") == "A04", "the emergency note is the one offered first")
    section = lambda t, head: t.split(f"■{head}\n", 1)[1].split("\n■", 1)[0] if f"■{head}\n" in t else ""  # noqa: E731
    initial = section(text, "初期評価・ABCDE")
    check("［場面・症候の入力（フローの質問への答え）］\n第一印象：sick\n体温：38.4 ℃" in initial, "the first impression (O) and the temperature (the E slot, category abcde) go to the field ROUTES gives them: 初期評価・ABCDE")
    hpi = section(text, "現病歴")
    check("発症様式：徐々に発症" in hpi and "随伴症状：嘔気" in hpi, "the history of the present illness (slot 12, about the complaint) goes to 現病歴")
    arrival = section(text, "来院情報")
    check("日前" in arrival and "120/80" in arrival, f"what the ambulance crew said (hand-over, slot 4) goes to 来院情報, dates already relative ({arrival[:80]})")
    exam = section(text, "身体診察")
    check("体温" not in exam and "第一印象" not in exam and "（未入力）" in exam, "the physical-exam field does not hold the answers (it says （未入力） when nothing else was typed there)")
    rest = text.split("■欄に結びつかなかった場面・症候の入力\n", 1)[1] if "■欄に結びつかなかった場面・症候の入力\n" in text else ""
    check("【救急外来 × 腹痛】" in rest and "病着：21:40" in rest, "the answers no field took are kept in a block of their own, headed by the scene and symptom (none is dropped)")
    check("体温" not in rest and "第一印象" not in rest and text.count("体温：38.4 ℃") == 1 and text.count("第一印象：sick") == 1, "an answer is written once: it is in its field only")
    check(text.index("■欄に結びつかなかった場面・症候の入力") > text.index("■身体診察"), "the block comes after the fields")
    check("ここにない項目は未確認で、陰性・正常を意味しません" in rest, "and it says what is absent from it is unchecked, not negative or normal")
    info = page.locator("#note-info").inner_text()
    check(re.search(r"場面・症候の入力 \d+ 件のうち、\d+ 件を ROUTES の欄に振り分けました", info) is not None and "どの質問にも付かない時刻・測定条件・理由" in info and "カテゴリ未分類" not in info, f"the screen says how many answers went to a field and why the others did not ({info[-160:]})")
    check("未入力の中核項目" not in text and "陰性ではありません" not in text, "but not the notes meant for the model")
    page.screenshot(path=str(OUT / "04_note.png"))
    # the emergency flow's answers belong to A04: in A01 the text is kept whole in the block, nothing is routed by a guess
    page.select_option("#note-type", "A01")
    t_a01 = page.locator("#note-text").inner_text()
    info_a01 = page.locator("#note-info").inner_text()
    check("■身体診察\n【救急外来 × 腹痛】" not in t_a01 and "■欄に結びつかなかった場面・症候の入力" in t_a01 and "第一印象：sick" in t_a01.split("■欄に結びつかなかった")[1], "the emergency flow's answers are not routed into A01's fields: the text is kept whole in the block")
    check("0 件を ROUTES の欄に振り分けました" in info_a01 and "文のまま" in info_a01, f"and the screen says so ({info_a01[-120:]})")
    page.select_option("#note-type", "A04")
    page.keyboard.press("Escape")

    # 12b. the outpatient first visit (A01) routes its own flow's answers the same way (clinical-modules gave that flow categories on 2026-10-25)
    OP = "outpatient-first-visit.fever"
    page.click("#btn-new")
    page.click("#btn-case")
    if page.locator("details.intake").get_attribute("open") is None:
        page.locator("details.intake > summary").first.click()
    page.select_option("#intake-flow", OP)
    open_all()
    chip("first", "sick").click()
    chip("duration", "acute").click()
    q("pmh_text").locator("textarea").fill("高血圧")
    chip("meds", "abx_recent").click()
    chip("exam_head", "pharynx_red").click()
    chip("antipyretic_tx", "acetaminophen").click()
    page.fill("#case-age", "34")
    page.select_option("#case-setting", "外来")
    page.fill("#case-complaint", "発熱")
    page.click("#case-pin")
    page.click("#casebar-note")
    expect(page.locator("#note")).to_be_visible()
    page.select_option("#note-type", "A01")
    op = page.locator("#note-text").inner_text()
    check("第一印象：sick" in section(op, "初期安全評価"), "A01: the first impression goes to 初期安全評価")
    check("期間：急性" in section(op, "現病歴・時間経過"), "A01: the history goes to 現病歴・時間経過")
    check("既往・ベースライン：高血圧" in section(op, "既往・薬剤・アレルギー・生活背景"), "A01: the past history goes to its background field")
    check("口腔・咽頭・耳・副鼻腔：咽頭発赤" in section(op, "身体診察"), "A01: the examination answer goes to 身体診察")
    check("解熱薬の処方：アセトアミノフェン" in section(op, "治療・追加検査・説明"), "A01: the treatment goes to the plan field")
    check("薬剤：最近の抗菌薬" in section(op, "既往・薬剤・アレルギー・生活背景"), "A01: the medicines are patient background (context, 2026-10-25): they go to the background field")
    check("■欄に結びつかなかった場面・症候の入力" not in op, "A01: every answer found a field: no block is left over")
    info_op = page.locator("#note-info").inner_text()
    check(re.search(r"場面・症候の入力 6 件のうち、6 件を ROUTES の欄に振り分けました。", info_op) is not None and "欄に結びつかず" not in info_op, f"A01: the screen counts them: all placed ({info_op[-140:]})")
    page.select_option("#note-type", "A04")
    t_op_a04 = page.locator("#note-text").inner_text()
    check("0 件を ROUTES の欄に振り分けました" in page.locator("#note-info").inner_text() and "■身体診察\n【外来初診 × 発熱】" not in t_op_a04, "and the outpatient flow's answers are not routed into A04's fields")
    page.screenshot(path=str(OUT / "04b_note_a01.png"))
    page.keyboard.press("Escape")

    # 13. nothing is kept in the browser's own storage
    store = page.evaluate("JSON.stringify([localStorage, sessionStorage])")
    check("38.4" not in store and "21:40" not in store and "腹痛" not in store and "sick" not in store, "the answers are not kept in localStorage / sessionStorage")

    # 14. reopening the saved conversation in a fresh page puts the form back from the server
    page2 = ctx.new_page()
    page2.on("dialog", lambda d: d.accept())
    page2.on("request", on_request)
    page2.goto(BASE + "/")
    page2.wait_for_function("() => document.querySelector('#chip-books').textContent.includes('(1)')")
    page2.click("#btn-convs")
    page2.click("#tab-saved")
    page2.wait_for_selector(".conv-open")
    page2.click(".conv-open")
    page2.wait_for_selector(".turn .foot button")
    check(page2.locator("#casebar").is_visible() and "52歳・男性・救急" in page2.locator("#casebar-text").inner_text(), "reopening pins the case")
    page2.click("#casebar-open")
    expect(page2.locator("#intake-flow")).to_have_value(FLOW)
    page2.evaluate("() => document.querySelectorAll('details.intake-phase, details.intake-more').forEach((d) => { d.open = true; })")
    check(page2.locator(".intake-q[data-q=temp] input").input_value() == "38.4", "the form is back after a reload")
    page2.screenshot(path=str(OUT / "05_restored.png"))
    page2.keyboard.press("Escape")

    # 15. a saved case whose form cannot be restored (the flow is not known): its text is kept, said so, and can be dropped
    old = {
        "kind": "final",
        "blocks": [{"text": "草案", "citations": []}],
        "mode": "ddx",
        "case": {"age": "60代", "sex": "女性", "setting": "救急", "complaint": "", "vitals": "", "findings": "", "history": "", "own": "", "structured": "場面・症候: 救急外来 × 旧フロー（x）\n［受け入れ］\n第一印象：sick", "intake": {"flow": "emergency-department.gone", "answers": {"first": "sick"}}},
    }
    r = api("POST", "/api/conversations/conv-legacy-001/turns", {"question": "鑑別と反証", "answer": "草案", "payload": old})
    check(r["status"] == 200, "a conversation with an unknown flow can be saved")
    page2.click("#btn-new")
    page2.click("#btn-convs")
    page2.click("#tab-saved")
    page2.wait_for_selector(".conv-open")
    page2.locator(".conv-open").first.click()
    page2.wait_for_selector(".turn .foot button")
    page2.click("#casebar-open")
    page2.wait_for_timeout(300)
    check("入力欄に戻せませんでした" in page2.locator(".intake-legacy").inner_text() and page2.locator(".intake-legacy").is_visible(), "the form cannot be restored: the screen says so")
    page2.fill("#case-complaint", "腹痛")
    page2.click("#case-pin")
    page2.click("#case-modes button[data-mode=ddx]")
    page2.locator(".turn").nth(1).locator(".foot button").first.wait_for(timeout=20000)
    check("旧フロー" in asks[-1]["case"].get("structured", "") and "intake" not in asks[-1]["case"], "the old text is still sent as it was")
    page2.click("#casebar-open")
    page2.click(".intake-legacy button")
    check(not page2.locator(".intake-legacy").is_visible(), "the old text can be dropped")
    page2.keyboard.press("Escape")

    bad = [l for l in logs if l[0] in ("error", "pageerror")]
    check(not bad, f"no console errors ({bad[:3]})")
    br.close()

print(f"\n{len(passed)} passed, {len(fails)} failed")
sys.exit(1 if fails else 0)
