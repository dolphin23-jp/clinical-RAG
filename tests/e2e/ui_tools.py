"""Browser test of the "測定・評価" screen (iPad: docs/evaluation.md 5) against worker/test/devserver.ts on the fixture.

  python3 -m ingest build --db /tmp/fx.sqlite fx tests/fixtures/synthetic_ch.md
  node --no-warnings worker/test/devserver.ts /tmp/fx.sqlite 8787 &
  python3 tests/e2e/ui_tools.py http://localhost:8787 OUT_DIR

Checks: the band in the new dialog; the numeric worksheet (create, judge, survives a reload on this device only,
summary, open the section); the evaluation set (add a question with the page finder, identifier refusal, stored on the
server and not in the device, retrieval run, answer run after a confirmation).  The fake model says nothing about
real answers.
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8787"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/ui_tools")
OUT.mkdir(parents=True, exist_ok=True)
TOKEN = "test-token-0123456789abcdef"
BAND = "参考情報・患者を特定する情報は入れない・最終判断は医師"
passed, fails = [], []


def check(cond, msg):
    (passed if cond else fails).append(msg)
    print(("PASS " if cond else "FAIL ") + msg, flush=True)


with sync_playwright() as pw:
    br = pw.chromium.launch()
    ctx = br.new_context(viewport={"width": 820, "height": 1180}, device_scale_factor=2, has_touch=True, is_mobile=True, locale="ja-JP")  # iPad
    page = ctx.new_page()
    logs, dialogs = [], []
    page.on("console", lambda m: logs.append((m.type, m.text)) if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
    page.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))
    page.goto(BASE + "/")
    page.evaluate(f"localStorage.setItem('mb.token','{TOKEN}')")
    page.reload()
    page.wait_for_function("document.querySelector('#chip-books').textContent.includes('(1)')")

    # 1. open the screen; the band is there too
    page.click("#btn-tools")
    expect(page.locator("#tools")).to_be_visible()
    band = page.locator("#tools .band")
    check(band.count() == 1 and band.inner_text().strip() == BAND, "band shown in the measurement/evaluation dialog")

    # 2. numeric worksheet: create and judge
    page.click("#num-create")
    page.wait_for_selector("#pane-num .nrow")
    rows = page.locator("#pane-num .nrow")
    check(rows.count() == 2, f"worksheet rows from the fixture ({rows.count()})")
    check(rows.first.locator(".ctx mark").inner_text() == "10 mg/日", "the number is marked in its context")
    rows.first.locator("[data-verdict=ok]").click()
    page.locator("#pane-num .nrow").first.locator("input[type=checkbox]").check()
    page.locator("#pane-num .nrow").nth(1).locator("[data-verdict=err]").click()
    second = page.locator("#pane-num .nrow").nth(1)
    second.locator("select").select_option("単位")
    second.locator("input[type=text]").fill("30 mL/min 未満")
    second.locator("input[type=text]").dispatch_event("change")
    page.screenshot(path=str(OUT / "01-worksheet.png"))
    check("記入 2/2" in page.locator("#pane-num .tools-head").inner_text(), "progress counts the judged rows")

    # 3. survives a reload (device storage), nothing about it went to the server
    stored = json.loads(page.evaluate("localStorage.getItem('mb.numeric.v1')"))
    check(stored["judged"]["N002"] == {"verdict": "err", "kind": "単位", "correct": "30 mL/min 未満"} and stored["judged"]["N001"].get("shift") is True,
          "judgments are kept in this device's storage")
    page.reload()
    page.click("#btn-tools")
    page.wait_for_selector("#pane-num .nrow")
    check(page.locator("#pane-num .nrow").first.locator("[data-verdict=ok]").get_attribute("aria-pressed") == "true", "judgments come back after a reload")

    # 4. summary and the section view
    page.click("#num-report")
    expect(page.locator("#sheet")).to_be_visible()
    rep = page.locator("#sheet-body").inner_text()
    check("誤り 1/2 = 50.0%" in rep and "95%CI" in rep, "summary shows the rate with its interval")
    check("単位 1" in rep and "頁ずれ（数値がその頁になかった）: 1/2" in rep, "summary shows error kinds and page shifts")
    page.screenshot(path=str(OUT / "02-report.png"))
    page.click("#sheet [data-close]")
    page.locator("#pane-num .nrow").first.locator("text=節の全文").click()
    page.wait_for_selector("#sheet .pgmark")
    check(page.locator("#sheet .pgmark").count() >= 1, "a row opens its whole section")
    page.click("#sheet [data-close]")

    # 5. evaluation set: add a question, using the page finder
    page.click("#tab-eval")
    page.wait_for_selector("#eval-add")
    check("保存済み 0 問" in page.locator("#pane-eval").inner_text(), "no questions stored yet")
    page.click("#eval-add")
    expect(page.locator("#eval-form")).to_be_visible()
    page.fill("#ef-question", "ゼルニア値の定義を確認したい")
    page.fill("#ef-queries", "ゼルニア値 定義")
    page.fill("#ef-find", "ゼルニア値 定義")
    page.click("#ef-find-btn")
    page.wait_for_selector("#eval-form .hit")
    page.locator("#eval-form .hit").first.click()
    check(page.input_value("#ef-book") == "fx" and page.input_value("#ef-pages").startswith("10"), "the finder fills the book and the page")
    page.fill("#ef-must", "半分以下")
    page.screenshot(path=str(OUT / "03-form.png"))
    page.click("#ef-save")
    page.wait_for_selector("#pane-eval .qrow")
    check(page.locator("#pane-eval .qrow").count() == 1 and "q001" in page.locator("#pane-eval .qrow").inner_text(), "the question is stored and listed")

    # 6. identifier-like text is refused and not stored
    page.click("#eval-add")
    page.fill("#ef-question", "カルテ番号 12345678 の方")
    page.fill("#ef-queries", "ゼルニア値")
    page.fill("#ef-pages", "10")
    page.click("#ef-save")
    page.wait_for_selector("#eval-form .notice.err")
    err = page.locator("#eval-form .notice.err").inner_text()
    check("patient identifier" in err and "12345678" not in err, "identifier-like question refused, without echoing it")
    page.click("#sheet [data-close]")
    check(page.locator("#pane-eval .qrow").count() == 1, "the refused question was not stored")
    q = page.evaluate(f"fetch('/api/eval/questions', {{headers: {{authorization: 'Bearer {TOKEN}'}}}}).then(r => r.json())")
    check([x["id"] for x in q["questions"]] == ["q001"], "the question is on the server")
    local = page.evaluate("JSON.stringify(Object.fromEntries(Object.entries(localStorage)))")
    check("ゼルニア値の定義" not in local, "the question text is not kept in the device")

    # 7. retrieval run (free) and answer run (asks first)
    page.click("#eval-run-retrieval")
    page.wait_for_selector("#pane-eval .eval-results table")
    table = page.locator("#pane-eval .eval-results table").inner_text()
    check("ALL" in table and "100%" in table, "retrieval table with and without the dictionary")
    page.fill("#eval-ask-n", "1")
    page.click("#eval-run-ask")
    page.wait_for_selector("#pane-eval .eval-results p:has-text('q001: final')", timeout=20000)
    check(any("費用の目安" in d for d in dialogs), "the answer run asked for confirmation with the cost estimate")
    res = page.locator("#pane-eval .eval-results").inner_text()
    check("引用" in res and "語 " in res, "answer results show citations and must-mention words")
    check(page.locator("#pane-eval .eval-results table").count() == 1, "the retrieval table stays after the answer run")
    box = page.locator("#eval-ask-n").bounding_box()
    check(box is not None and box["width"] < 120, f"the question-count field stays small ({box and round(box['width'])}px)")
    page.screenshot(path=str(OUT / "04-eval.png"), full_page=True)

    check(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "no horizontal page scroll at iPad width")
    bad = [l for l in logs if not (l[0] == "error" and ("favicon" in l[1] or "400" in l[1] or "Bad Request" in l[1]))]
    check(not bad, f"no console errors / CSP violations: {bad[:5]}")
    br.close()

print(f"\n{len(passed)} passed, {len(fails)} failed")
sys.exit(1 if fails else 0)
