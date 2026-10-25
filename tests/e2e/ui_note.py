"""Browser test of the chart-note draft (docs/enhancement-plan.md 7.3) against worker/test/devserver.ts on the synthetic fixture (iPad width).

  python3 -m ingest build --db /tmp/fx.sqlite fx tests/fixtures/synthetic_ch.md
  node --no-warnings worker/test/devserver.ts /tmp/fx.sqlite 8787 &
  python3 tests/e2e/ui_note.py http://localhost:8787 OUT_DIR

Checks: ticks ("採用") only under the sections that are chart content (and only on an assessment/plan draft), the note made from the
case and the ticked items only, the placeholders and （未入力）, the AI-mark / source-mark options, other types, copy, that the dialog
sends nothing and leaves nothing in the browser, and that a restored conversation's draft can be ticked again.
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8787"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/ui_note")
OUT.mkdir(parents=True, exist_ok=True)
TOKEN = "test-token-0123456789abcdef"
passed, fails = [], []


def check(cond, msg):
    (passed if cond else fails).append(msg)
    print(("PASS " if cond else "FAIL ") + msg, flush=True)


CASE = {
    "age": "72",
    "sex": "男性",
    "setting": "救急",
    "complaint": "ゼルニア値の低下を指摘された。3日前から発熱と咳。",
    "vitals": "BP 92/54, HR 108, SpO2 94%",
    "findings": "Cr 2.4 mg/dL（ふだんは 0.9）, K 5.8 mEq/L",
    "history": "高血圧。内服はアムロジピン。",
}

with sync_playwright() as pw:
    br = pw.chromium.launch()
    ctx = br.new_context(viewport={"width": 820, "height": 1180}, device_scale_factor=2, has_touch=True, is_mobile=True, locale="ja-JP")
    page = ctx.new_page()
    logs, requests = [], []
    page.on("console", lambda m: logs.append((m.type, m.text)) if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
    page.on("dialog", lambda d: d.accept())
    page.on("request", lambda r: requests.append((r.method, r.url)))
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

    def wait_done(pg, n):
        expect(pg.locator(".turn")).to_have_count(n)
        pg.locator(".turn").nth(n - 1).locator(".foot button").first.wait_for(timeout=20000)

    def tick(loc, on=True):
        """Tick or un-tick like a finger would: bring the box to the middle of the screen (the sticky header would cover it), then tap it."""
        loc.evaluate("el => el.scrollIntoView({block: 'center'})")
        loc.set_checked(on)

    def pin(pg, c, own=""):
        pg.click("#btn-case")
        pg.fill("#case-age", c.get("age", ""))
        for k in ("sex", "setting"):
            pg.select_option(f"#case-{k}", c.get(k, ""))
        for k in ("complaint", "vitals", "findings", "history"):
            pg.fill(f"#case-{k}", c.get(k, ""))
        pg.fill("#case-own", own)
        pg.click("#case-pin")

    api("DELETE", "/api/conversations")  # a clean store for this run
    pin(page, CASE, own="感染に伴う腎前性AKIを第一に考える。")
    page.click("#case-modes button[data-mode=assess]")
    wait_done(page, 1)
    turn = page.locator(".turn").first

    # 1. ticks only under the four chart-content sections
    def section(name):
        return turn.locator("details.sec", has=page.locator("summary", has_text=name))

    check(section("問題リスト").locator(".adopt").count() >= 2, "ticks under 問題リスト")
    check(section("各問題の評価").locator(".adopt").count() >= 3, "ticks under 各問題の評価 (bullets and the table row)")
    check(section("初期プラン").locator(".adopt").count() >= 2, "ticks under 初期プラン")
    check(section("コンサルト・医師コールの基準").locator(".adopt").count() >= 2, "ticks under the consult criteria")
    for name in ("確認すべき数値", "書籍に見つからなかった点", "先生の案との差"):
        check(section(name).count() == 1 and section(name).locator(".adopt").count() == 0, f"no ticks under {name} (it is about the draft, not chart content)")
    check(turn.locator(".adopt-cell .adopt").count() == 1, "a table row can be ticked too")
    check(turn.locator(".note-open").inner_text() == "記載の下書きを作る（採用 0 件）", "the turn's button starts at 0 adopted")
    page.screenshot(path=str(OUT / "01_ticks.png"))

    # 2. tick: the first problem, the table row, one plan item
    sent_before = len(requests)
    tick(section("問題リスト").locator(".adopt input").first)
    tick(section("各問題の評価").locator(".adopt-cell input"))
    plan_items = section("初期プラン").locator("li", has_text="について、この症例の入力からの整理")
    tick(plan_items.locator(".adopt input").first)
    check(turn.locator(".note-open").inner_text() == "記載の下書きを作る（採用 3 件）", "the button counts the adopted items")
    check(turn.locator(".adopted").count() == 3, "adopted items are marked on screen")
    tick(plan_items.locator(".adopt input").first, False)
    check(turn.locator(".note-open").inner_text() == "記載の下書きを作る（採用 2 件）", "un-ticking takes it back")
    tick(plan_items.locator(".adopt input").first)

    # 3. the dialog: what is in the note and what is not
    page.evaluate("window.__copied = ''; navigator.clipboard.writeText = async (t) => { window.__copied = t; }")
    turn.locator(".note-open").click()
    dlg = page.locator("#note")
    expect(dlg).to_be_visible()
    check(dlg.locator(".band").is_visible(), "band shown in the note dialog")
    check(page.locator("#note-type option").count() == 7, "seven note types are offered")
    check(page.input_value("#note-type") == "A04", "the emergency note is first")
    text = page.locator("#note-text").inner_text()
    check(text.startswith("【救急外来初療】下書き\n［日付］　［患者ID］　［氏名］"), "title, then the blank date / ID / name line")
    check("■来院情報\n72歳・男性・救急" in text and "■現病歴\nゼルニア値の低下を指摘された" in text, "the case is placed in its fields")
    check("■身体診察\n［身体所見・検査・画像・心電図］\nCr 2.4 mg/dL" in text, "findings are labelled as the combined input")
    check("■帰宅・入院・転院と根拠\n（未入力）" in text, "a required field with nothing stays （未入力）")
    check("■検査所見" not in text and "■再評価・治療反応" not in text, "conditional fields with nothing are left out")
    check("［先生のアセスメント（入力）］\n感染に伴う腎前性AKIを第一に考える。" in text, "the doctor's own assessment is placed without an AI mark")
    marked = [l for l in text.split("\n") if l.startswith("・〔AI草案〕")]
    check(len(marked) == 3, f"exactly the three adopted items carry the AI mark ({len(marked)})")
    check("※〔AI草案〕の印がある項目は" in text, "the notice about the mark is there")
    check("尿量が回復すれば成り立たない" in text and "問題: 急性腎障害" in text, "the ticked table row is placed with its column names")
    check("［初期プラン（草案。予定・検討であり、実施の記録ではありません）］" in text, "the plan is labelled as a proposal")
    check("標準的な初期対応として確立している内容" not in text, "items that were not ticked are not in the note")
    check("確認すべき数値" not in text and "先生の案との差" not in text, "the draft's own sections are not in the note")
    check("［書籍" in text and "■AI草案の出典" in text, "book pages of adopted cited items and the list of sources are there")
    info = page.locator("#note-info").inner_text()
    check("採用した草案の項目だけが入ります" in info and "v0.2" in info, "the dialog says what goes in and which type version")
    page.screenshot(path=str(OUT / "02_note_A04.png"))

    # 4. options
    page.uncheck("#note-opt-ai")
    t2 = page.locator("#note-text").inner_text()
    check("AI草案" not in t2.replace("AI草案の出典", ""), "without the AI mark neither the marks nor the notice remain")
    check("[推論]" in t2 or "[標準・出典未確認]" in t2, "the source marks stay when only the AI mark is dropped")
    page.check("#note-opt-ai")
    page.uncheck("#note-opt-src")
    t3 = page.locator("#note-text").inner_text()
    check("［書籍" not in t3 and "[推論]" not in t3 and "AI草案の出典" not in t3 and "〔AI草案〕" in t3, "without the source marks: no tags, pages or list; the AI mark stays")
    page.check("#note-opt-src")

    # 5. other types
    page.select_option("#note-type", "B06")
    t6 = page.locator("#note-text").inner_text()
    check(t6.startswith("【申し送り】下書き") and "■次担当者に必要な行動・担当・期限" in t6 and "（担当・期限は入力していません）" in t6, "handover: tasks field notes that nobody is assigned")
    page.select_option("#note-type", "B02")
    t7 = page.locator("#note-text").inner_text()
    check("■実施済み評価・治療\n（未入力）" in t7 and "初期プラン" not in t7, "consult request: the plan never lands in 'done' and is reported as unplaced")
    check("入れる欄がありません" in page.locator("#note-info").inner_text(), "the dialog says some adopted items have no field in this type")
    page.select_option("#note-type", "A08")
    check("入れる欄がありません" in page.locator("#note-info").inner_text() and "■退院時状態・残存課題\n（未入力）" in page.locator("#note-text").inner_text(), "discharge summary: mostly （未入力）, adopted items reported as unplaced")
    page.select_option("#note-type", "A01")
    check("【外来初診】下書き" in page.locator("#note-text").inner_text(), "outpatient first visit")
    page.select_option("#note-type", "A04")

    # 6. copy
    page.click("#note-copy")
    page.wait_for_function("window.__copied.length > 0")
    check(page.evaluate("window.__copied") == page.locator("#note-text").inner_text(), "copy gives exactly what is shown")
    check(page.locator("#note-copy").inner_text() == "コピーしました", "copy button confirms")
    check(not [m for m, u in requests[sent_before:] if m != "GET"] and not any("/api/" in u for m, u in requests[sent_before:]), "ticking, the dialog and copy sent nothing to the server")

    # 7. closing leaves nothing; nothing in the browser's storage
    page.click("#note .btn[data-close]")
    expect(dlg).not_to_be_visible()
    page.wait_for_function("() => document.querySelector('#note-text').textContent === ''", timeout=3000)  # the dialog's close event is asynchronous
    check(page.evaluate("document.querySelector('#note-text').textContent") == "", "closing clears the note text")
    store = page.evaluate("JSON.stringify([localStorage, sessionStorage])")
    check("ゼルニア値" not in store and "急性腎障害" not in store and "AI草案" not in store, "the note and the ticks are not kept in localStorage / sessionStorage")

    # 8. the bar's 記載 button: the case alone, no draft
    page.click("#casebar-note")
    tc = page.locator("#note-text").inner_text()
    check("固定中の症例だけ" in page.locator("#note-info").inner_text(), "the bar's button makes a note from the pinned case alone")
    check("AI草案" not in tc and "［問題リスト" not in tc and "■現病歴\nゼルニア値" in tc, "no AI mark or draft items without ticks")
    page.keyboard.press("Escape")

    # 9. ticks only on an assessment/plan draft
    page.click("#case-modes button[data-mode=ddx]")
    wait_done(page, 2)
    check(page.locator(".turn").nth(1).locator(".adopt").count() == 0 and page.locator(".turn").nth(1).locator(".note-open").count() == 0, "a differential has no ticks and no note button")
    page.fill("#q", "ゼルニア値の基準は？")
    page.click("#send")
    wait_done(page, 3)
    check(page.locator(".turn").nth(2).locator(".adopt").count() == 0, "a free question has no ticks")

    # 10. a restored conversation's draft can be ticked again (the ticks themselves were never saved)
    page2 = ctx.new_page()
    page2.on("dialog", lambda d: d.accept())
    page2.goto(BASE + "/")
    page2.wait_for_function("() => document.querySelector('#chip-books').textContent.includes('(1)')")
    page2.click("#btn-convs")
    page2.click("#tab-saved")
    page2.wait_for_selector(".conv-open")
    page2.click(".conv-open")
    page2.wait_for_selector(".turn .foot button")
    t = page2.locator(".turn").first
    check(t.locator(".adopt").count() >= 8 and t.locator(".adopt input:checked").count() == 0, "a reopened draft has fresh ticks, none ticked")
    tick(t.locator("details.sec", has=page2.locator("summary", has_text="初期プラン")).locator(".adopt input").first)
    page2.evaluate("window.__copied = ''; navigator.clipboard.writeText = async (x) => { window.__copied = x; }")
    t.locator(".note-open").click()
    lines = [l for l in page2.locator("#note-text").inner_text().split("\n") if l.startswith("・〔AI草案〕")]
    check(len(lines) == 1, "a note can be made from the reopened draft")

    bad = [l for l in logs if l[0] in ("error", "pageerror")]
    check(not bad, f"no console errors ({bad[:3]})")
    br.close()

print(f"\n{len(passed)} passed, {len(fails)} failed")
sys.exit(1 if fails else 0)
