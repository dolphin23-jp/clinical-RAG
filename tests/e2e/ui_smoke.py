"""Browser smoke test of the PWA against worker/test/devserver.ts (fake Anthropic, real search + handler).

  node --no-warnings worker/test/devserver.ts <db.sqlite> 8787 &
  python3 tests/e2e/ui_smoke.py http://localhost:8787 OUT_DIR

Needs `pip install playwright` + a Chromium (PLAYWRIGHT_BROWSERS_PATH). Writes screenshots to OUT_DIR.
The fake Anthropic API only exercises OUR code (tool loop, citations -> chips, rendering); it says nothing
about real model behaviour.
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8787"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/ui_out")
OUT.mkdir(parents=True, exist_ok=True)
TOKEN = "test-token-0123456789abcdef"
UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
passed, fails = [], []


def check(cond, msg):
    (passed if cond else fails).append(msg)
    print(("PASS " if cond else "FAIL ") + msg, flush=True)


def wait_done(page, timeout=20000):
    page.wait_for_selector(".turn:last-child .foot button, .turn:last-child .notice.err, .turn:last-child .notice", timeout=timeout)


with sync_playwright() as pw:
    br = pw.chromium.launch()
    ctx = br.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True, locale="ja-JP", user_agent=UA)
    page = ctx.new_page()
    logs = []
    page.on("console", lambda m: logs.append((m.type, m.text)) if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
    page.goto(BASE + "/")

    # 1. first run -> settings dialog asks for the token
    expect(page.locator("#settings")).to_be_visible()
    check("トークン" in page.locator("#settings-msg").inner_text(), "first run opens settings with token prompt")
    page.screenshot(path=str(OUT / "01-settings.png"))
    page.fill("#in-token", "wrong-token-xxxxxxxxxxxxxxxx")
    page.click("#btn-save")
    page.wait_for_selector("#settings-msg.err")
    check("正しくありません" in page.locator("#settings-msg").inner_text(), "wrong token is rejected with a clear message")
    page.fill("#in-token", TOKEN)
    page.click("#btn-save")
    page.wait_for_selector("#settings-msg.ok")
    check("書籍 1 冊" in page.locator("#settings-msg").inner_text(), "correct token connects and lists books")
    check(page.locator("#books-list input").count() == 1, "book filter shows the book")
    page.screenshot(path=str(OUT / "02-settings-ok.png"))
    page.click("#settings [data-close]")
    expect(page.locator("#settings")).not_to_be_visible()
    check(page.locator("#examples button").count() == 3, "example prompts rendered")
    page.screenshot(path=str(OUT / "03-empty.png"))

    # 2. ask a question (web off)
    page.fill("#q", "感度と特異度の違いを教えて")
    page.click("#send")
    page.wait_for_selector(".turn .status:not([hidden])")
    wait_done(page)
    t = page.locator(".turn").last
    check(t.locator("h3").first.inner_text() == "要点", "markdown heading rendered")
    check(t.locator("strong").count() >= 2, "bold rendered")
    check(t.locator(".body li").count() == 2, "list items rendered (2)")
    check(t.locator("table th").count() == 2 and t.locator("table tbody tr").count() == 2, "table has 2 cols x 2 rows")
    check(all(r.locator("td").count() == 2 for r in t.locator("table tbody tr").all()), "citation at table-row end did not add a column")
    check(t.locator(".cite").count() >= 3, f"citation chips present ({t.locator('.cite').count()})")
    n_refs = t.locator(".ref-btn").count()
    check(1 <= n_refs <= t.locator(".cite").count() and "引用箇所 p." in t.locator(".refs").inner_text(), f"根拠 list shows one row per (section, page) with the cited page ({n_refs} rows)")
    check(t.locator(".notice").count() >= 1, "safety notices shown (数値/転写者補助/照合未完)")
    txt = t.locator(".body").inner_text()
    check("" not in txt and "" not in txt, "no citation sentinels leaked into visible text")
    check("概算" in t.locator(".foot").inner_text(), "usage/cost footer shown")
    page.screenshot(path=str(OUT / "04-answer.png"))
    page.screenshot(path=str(OUT / "04-answer-full.png"), full_page=True)
    check(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "no horizontal page scroll at 390px")

    # 3. citation sheet -> full section
    t.locator(".cite").first.click()
    expect(page.locator("#sheet")).to_be_visible()
    check(page.locator("#sheet .excerpt").count() >= 1, "citation sheet shows the cited excerpt")
    page.screenshot(path=str(OUT / "05-sheet.png"))
    page.click("text=節の全文を見る")
    page.wait_for_selector("#sheet .pgmark")
    check(page.locator("#sheet .pgmark").count() >= 1, "full section view renders page markers")
    page.locator("#sheet-body").evaluate("e => e.scrollTo(0, 0)")
    page.screenshot(path=str(OUT / "06-section.png"))
    page.click("#sheet [data-close]")

    # 4. web toggle -> web citation
    page.click("#chip-web")
    check(page.get_attribute("#chip-web", "aria-pressed") == "true", "web chip toggles on")
    page.fill("#q", "KDIGOの最新の推奨は")
    page.click("#send")
    expect(page.locator(".turn")).to_have_count(2)
    wait_done(page)
    t2 = page.locator(".turn").last
    check(t2.locator(".cite.web").count() >= 1, "web citation chip rendered distinctly")
    t2.locator(".cite.web").first.click()
    expect(page.locator("#sheet")).to_be_visible()
    link = page.locator("#sheet a.btn")
    check(link.count() == 1 and link.get_attribute("rel") == "noopener noreferrer" and (link.get_attribute("href") or "").startswith("https://"), "web link is https + noopener")
    page.click("#sheet [data-close]")

    # 5. page image (devserver serves pages 3 and 4 only)
    page.click("#chip-web")
    page.fill("#q", "患者との出会いから診断まで")
    page.click("#send")
    expect(page.locator(".turn")).to_have_count(3)
    wait_done(page)
    t3 = page.locator(".turn").last
    t3.locator(".cite").first.click()
    labels = [b.inner_text() for b in page.locator("#sheet .btn-row button").all()]
    check(any(l.startswith("原本 p.") for l in labels), f"page buttons offered: {labels}")
    target = next((b for b in page.locator("#sheet .btn-row button").all() if b.inner_text() in ("原本 p.3", "原本 p.4")), None)
    if target is None:
        target = next(b for b in page.locator("#sheet .btn-row button").all() if b.inner_text().startswith("原本 p."))
    target.click()
    page.wait_for_selector("#sheet .pageimg img, #sheet .notice")
    check(page.locator("#sheet .pageimg img").count() == 1 or page.locator("#sheet .notice").count() >= 1, "page image or friendly 'not registered' message shown")
    page.screenshot(path=str(OUT / "07-pageimg.png"))
    page.click("#sheet [data-close]")

    # 6. API error path + stop
    page.fill("#q", "__apierror__ test")
    page.click("#send")
    expect(page.locator(".turn")).to_have_count(4)
    page.wait_for_selector(".turn:last-child .notice.err", timeout=15000)
    check("overloaded" in page.locator(".turn").last.locator(".notice.err").inner_text(), "upstream API error is surfaced, not swallowed")
    check("sk-ant" not in page.content(), "no API key in page")

    page.fill("#q", "中止のテスト")
    page.click("#send")
    page.wait_for_selector(".turn:last-child .status:not([hidden])")
    page.click("#send")  # becomes the stop button while busy
    page.wait_for_selector("#send:not(.stop)", timeout=10000)
    check(True, "stop button returns composer to idle")

    # 7. new conversation clears; nothing from the conversation is persisted
    page.click("#btn-new")
    check(page.locator(".turn").count() == 0 and page.locator("#empty").is_visible(), "new conversation clears the thread")
    stored = page.evaluate("JSON.stringify(Object.fromEntries(Object.entries(localStorage)))")
    check("感度" not in stored and "KDIGO" not in stored, f"no conversation text in localStorage (keys: {list(json.loads(stored))})")

    # 8. dark mode
    ctx2 = br.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, color_scheme="dark", has_touch=True, is_mobile=True)
    p2 = ctx2.new_page()
    p2.goto(BASE + "/")
    p2.evaluate(f"localStorage.setItem('mb.token','{TOKEN}')")
    p2.reload()
    p2.fill("#q", "感度と特異度")
    p2.click("#send")
    p2.wait_for_selector(".turn:last-child .foot button", timeout=20000)
    p2.screenshot(path=str(OUT / "08-dark.png"))

    # the deliberate wrong-token attempt in step 1 logs one 401; anything else is a real problem
    bad = [l for l in logs if not (l[0] == "error" and ("favicon" in l[1] or "401" in l[1]))]
    check(not bad, f"no console errors / CSP violations: {bad[:5]}")
    br.close()

print(f"\n{len(passed)} passed, {len(fails)} failed")
sys.exit(1 if fails else 0)
