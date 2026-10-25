"""Browser test of the clinical-reference safeguards (docs/clinical-use.md, docs/enhancement-plan.md T1-1..T1-3, 2.6).

Runs against worker/test/devserver.ts on the synthetic fixture (no real book needed):

  python3 -m ingest build --db /tmp/fx.sqlite fx tests/fixtures/synthetic_ch.md
  node --no-warnings worker/test/devserver.ts /tmp/fx.sqlite 8787 &
  python3 tests/e2e/ui_clinical.py http://localhost:8787 OUT_DIR

Checks: the always-on band (header and every dialog), the identifier check before sending (fix / send anyway),
that clinical values pass without a prompt, the Worker-side refusal, and the degraded display when the answer fails
(sections still shown; text already streamed is kept). The fake Anthropic API says nothing about real model behaviour.
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8787"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/ui_clinical")
OUT.mkdir(parents=True, exist_ok=True)
TOKEN = "test-token-0123456789abcdef"
BAND = "参考情報・患者を特定する情報は入れない・最終判断は医師"
passed, fails = [], []


def check(cond, msg):
    (passed if cond else fails).append(msg)
    print(("PASS " if cond else "FAIL ") + msg, flush=True)


def wait_done(page, timeout=20000):
    page.wait_for_selector(".turn:last-child .foot button, .turn:last-child .notice", timeout=timeout)


def band_visible(page, scope):
    loc = page.locator(f"{scope} .band")
    return loc.count() == 1 and loc.is_visible() and loc.inner_text().strip() == BAND


with sync_playwright() as pw:
    br = pw.chromium.launch()
    ctx = br.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True, locale="ja-JP")
    page = ctx.new_page()
    logs = []
    page.on("console", lambda m: logs.append((m.type, m.text)) if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
    page.goto(BASE + "/")

    # 1. band in the header and in the settings dialog (first run)
    expect(page.locator("#settings")).to_be_visible()
    check(band_visible(page, "#settings"), "band shown in the settings dialog")
    page.fill("#in-token", TOKEN)
    page.click("#btn-save")
    page.wait_for_selector("#settings-msg.ok")
    page.click("#settings [data-close]")
    check(band_visible(page, "header.bar"), "band shown in the sticky header")
    check("年齢（歳の整数）・主要所見・検査値の数値まで" in page.locator(".fine").inner_text(), "input rule (age in years / findings / lab values) shown on the empty screen")
    check("氏名・ID" in (page.get_attribute("#q", "placeholder") or ""), "placeholder says names and IDs stay out")
    check("施設プロトコル" in page.locator(".how").inner_text(), "empty screen says facility protocols are not included")
    page.screenshot(path=str(OUT / "01-empty.png"))

    # 2. clinical wording goes straight through (no prompt): age band, lab values, a date, a name-like word
    page.fill("#q", "70代男性、2025-10-24 来院。K 6.8、Cr 2.1、ゼルニア値が低い")
    page.click("#send")
    wait_done(page)
    check(not page.locator("#guard").is_visible(), "no identifier prompt for age band / lab values / dates")
    check(page.locator(".turn").count() == 1, "clinical question was sent")
    page.locator(".turn .cite").first.click()
    expect(page.locator("#sheet")).to_be_visible()
    check(band_visible(page, "#sheet"), "band shown in the citation sheet")
    page.click("#sheet [data-close]")

    # 3. identifier -> prompt; "直す" keeps the text and sends nothing
    page.fill("#q", "患者ID 123456 の方のゼルニア値")
    page.click("#send")
    expect(page.locator("#guard")).to_be_visible()
    check(band_visible(page, "#guard"), "band shown in the identifier prompt")
    labels = [li.inner_text() for li in page.locator("#guard-list li").all()]
    check("ID・MRN の後ろの数字" in labels and "「患者ID」の語" in labels, f"prompt names the kinds found: {labels}")
    check("123456" not in page.locator("#guard").inner_text(), "prompt does not echo the matched text")
    page.screenshot(path=str(OUT / "02-guard.png"))
    page.click("#guard-fix")
    expect(page.locator("#guard")).not_to_be_visible()
    check(page.input_value("#q") == "患者ID 123456 の方のゼルニア値", "fix keeps the text for editing")
    check(page.locator(".turn").count() == 1, "fix sends nothing")

    # 4. "このまま送る" sends with the confirmation; the next question carries it with the history
    page.click("#send")
    expect(page.locator("#guard")).to_be_visible()
    page.click("#guard-send")
    expect(page.locator(".turn")).to_have_count(2)
    wait_done(page)
    check(page.locator(".turn").last.locator(".foot button").count() == 1, "confirmed question is answered")
    check(page.input_value("#q") == "", "composer cleared after sending")
    page.fill("#q", "続けて、ゼルニア値の経過")
    page.click("#send")
    expect(page.locator(".turn")).to_have_count(3)
    wait_done(page)
    check(page.locator(".turn").last.locator(".foot button").count() == 1, "follow-up with the confirmed question in history is accepted")

    # 5. the Worker refuses an unconfirmed identifier on its own (screen check bypassed)
    r = page.evaluate(
        """async (t) => { const res = await fetch('/api/ask', {method: 'POST', headers: {authorization: 'Bearer ' + t, 'content-type': 'application/json'},
           body: JSON.stringify({question: 'カルテ番号 12345678'})}); return {status: res.status, body: await res.json()}; }""",
        TOKEN,
    )
    check(r["status"] == 400 and r["body"].get("code") == "possible_identifier" and "12345678" not in json.dumps(r["body"]), f"Worker refuses an unconfirmed identifier: {r['status']}")

    # 6. degraded: the API fails before any search -> sections found by the question's words are shown
    page.click("#btn-new")
    page.fill("#q", "__apierror__ ゼルニア値")
    page.click("#send")
    page.wait_for_selector(".turn:last-child details.hits[open]", timeout=15000)
    t = page.locator(".turn").last
    check("overloaded" in t.locator(".notice.err").inner_text(), "upstream error is still shown")
    check("モデルの回答ではありません" in t.locator(".notices").inner_text(), "degraded notice says these are search results, not an answer")
    check(t.locator(".hit").count() >= 1, f"sections shown ({t.locator('.hit').count()})")
    t.locator(".hit").first.click()
    expect(page.locator("#sheet")).to_be_visible()
    page.wait_for_selector("#sheet .pgmark")
    check(page.locator("#sheet .pgmark").count() >= 1, "a shown section opens with its pages")
    page.screenshot(path=str(OUT / "03-degraded.png"))
    page.click("#sheet [data-close]")

    # 7. degraded mid-answer: the streamed text stays, marked as unfinished, with the sections
    page.fill("#q", "__midbreak__ ゼルニア値")
    page.click("#send")
    expect(page.locator(".turn")).to_have_count(2)
    page.wait_for_selector(".turn:last-child details.hits[open]", timeout=15000)
    t = page.locator(".turn").last
    check("途中まで書いた回答の文" in t.locator(".body").inner_text(), "text streamed before the break is kept")
    check("途中で止まりました" in t.locator(".notices").inner_text(), "kept text is marked as unfinished and uncited")
    check("stream broke" in t.locator(".notice.err").inner_text(), "the break is reported")
    page.screenshot(path=str(OUT / "04-midbreak.png"), full_page=True)

    # 8. nothing from the conversation is persisted; no console errors / CSP violations
    stored = page.evaluate("JSON.stringify(Object.fromEntries(Object.entries(localStorage)))")
    check("ゼルニア" not in stored and "患者ID" not in stored, f"no conversation text in localStorage (keys: {list(json.loads(stored))})")
    check(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "no horizontal page scroll at 390px")
    bad = [l for l in logs if not (l[0] == "error" and ("favicon" in l[1] or "400" in l[1] or "Bad Request" in l[1]))]
    check(not bad, f"no console errors / CSP violations: {bad[:5]}")
    br.close()

print(f"\n{len(passed)} passed, {len(fails)} failed")
sys.exit(1 if fails else 0)
