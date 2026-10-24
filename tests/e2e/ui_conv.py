"""Browser test of saved conversations, the number check and the uncited-statement marks (docs/clinical-use.md 1d;
docs/enhancement-plan.md T1-6 / C6) against worker/test/devserver.ts on the synthetic fixture (iPad width).

  python3 -m ingest build --db /tmp/fx.sqlite fx tests/fixtures/synthetic_ch.md
  node --no-warnings worker/test/devserver.ts /tmp/fx.sqlite 8787 &
  python3 tests/e2e/ui_conv.py http://localhost:8787 OUT_DIR
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8787"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/ui_conv")
OUT.mkdir(parents=True, exist_ok=True)
TOKEN = "test-token-0123456789abcdef"
passed, fails = [], []


def check(cond, msg):
    (passed if cond else fails).append(msg)
    print(("PASS " if cond else "FAIL ") + msg, flush=True)


with sync_playwright() as pw:
    br = pw.chromium.launch()
    ctx = br.new_context(viewport={"width": 820, "height": 1180}, device_scale_factor=2, has_touch=True, is_mobile=True, locale="ja-JP")
    page = ctx.new_page()
    logs, dialogs = [], []
    page.on("console", lambda m: logs.append((m.type, m.text)) if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
    page.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))
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

    def ask(q):
        n = page.locator(".turn").count()
        page.fill("#q", q)
        page.click("#send")
        expect(page.locator(".turn")).to_have_count(n + 1)
        page.wait_for_selector(".turn:last-child .foot button", timeout=20000)

    def note(i=-1):
        page.wait_for_function("(i) => { const t = [...document.querySelectorAll('.turn')].at(i); return t && /保存|できません/.test(t.querySelector('.save-note').textContent) }", arg=i, timeout=10000)
        return page.locator(".turn").nth(i if i >= 0 else page.locator(".turn").count() + i).locator(".save-note").inner_text()

    api("DELETE", "/api/conversations")  # a clean store for this run

    # 1. two turns are saved
    ask("ゼルニア値の定義は")
    check(note() == "保存済み", "the first answer is saved")
    ask("架空薬Xの使い方は")
    check(note() == "保存済み", "the second answer is saved")
    lst = api("GET", "/api/conversations")["body"]
    check(len(lst["conversations"]) == 1 and lst["conversations"][0]["turns"] == 2, "one conversation with two turns on the server")
    local = page.evaluate("JSON.stringify(Object.fromEntries(Object.entries(localStorage)))")
    check("ゼルニア値の定義" not in local, "the question text is not in the device's storage")

    # 2. "この会話": every question is listed and jumps
    page.click("#btn-convs")
    expect(page.locator("#convs")).to_be_visible()
    check(page.locator("#convs .band").count() == 1, "band in the conversation dialog")
    items = page.locator("#pane-here .qjump button")
    check(items.count() == 2 and "ゼルニア値の定義" in items.first.inner_text(), "both questions are listed")
    items.first.click()
    expect(page.locator("#convs")).not_to_be_visible()
    page.wait_for_timeout(900)
    top = page.evaluate("document.querySelectorAll('.turn')[0].getBoundingClientRect().top")
    check(-5 < top < 200, f"jumping brings the first question to the top ({round(top)}px)")

    # 3. reload: the screen is empty, the conversation comes back from the server with its chips
    page.reload()
    page.wait_for_function("() => document.querySelector('#chip-books').textContent.includes('(1)')")
    check(page.locator(".turn").count() == 0, "after a reload the screen starts empty")
    page.click("#btn-convs")
    page.click("#tab-saved")
    page.wait_for_selector("#pane-saved .conv")
    check("30 日で自動的に消えます" in page.locator("#pane-saved").inner_text(), "the list says how long conversations are kept")
    check("2 往復" in page.locator("#pane-saved .conv").first.inner_text(), "the list shows the number of turns")
    page.screenshot(path=str(OUT / "01-list.png"))
    page.locator("#pane-saved .conv-open").first.click()
    page.wait_for_selector(".turn .cite")
    check(page.locator(".turn").count() == 2, "both turns are rebuilt")
    check(page.locator(".turn .cite").count() >= 3, "citation chips are rebuilt")
    check(page.locator(".turn .ref-btn").count() >= 1 and page.locator(".turn details.hits .hit").count() >= 1, "references and hit sections are rebuilt")
    page.locator(".turn .cite").first.click()
    expect(page.locator("#sheet")).to_be_visible()
    check(page.locator("#sheet .excerpt").count() >= 1, "a rebuilt chip opens its cited passage")
    page.click("#sheet [data-close]")
    check(all(t.inner_text() == "保存済み" for t in page.locator(".turn .save-note").all()), "restored turns are marked saved (and not saved twice)")
    check(api("GET", "/api/conversations")["body"]["conversations"][0]["turns"] == 2, "restoring did not add turns on the server")

    # 4. a follow-up continues the same saved conversation
    ask("続けて、架空薬Xの用量は")
    note()
    c = api("GET", "/api/conversations")["body"]["conversations"]
    check(len(c) == 1 and c[0]["turns"] == 3, "the follow-up joined the restored conversation")

    # 5. "+" starts another saved conversation without losing the first
    page.click("#btn-new")
    check(page.locator(".turn").count() == 0, "a new conversation clears the screen")
    ask("感度と特異度の違いは")
    note()
    c = api("GET", "/api/conversations")["body"]["conversations"]
    check(len(c) == 2 and sorted(x["turns"] for x in c) == [1, 3], "two conversations are kept")

    # 6. a question confirmed through the identifier check is not saved
    page.fill("#q", "患者ID 123456 の方のゼルニア値")
    page.click("#send")
    expect(page.locator("#guard")).to_be_visible()
    page.click("#guard-send")
    page.wait_for_selector(".turn:last-child .foot button", timeout=20000)
    check("保存していません" in note(), "the confirmed question says it was not saved")
    c = api("GET", "/api/conversations")["body"]["conversations"]
    check(all("123456" not in x["title"] for x in c) and sum(x["turns"] for x in c) == 4, "the server did not get it")
    # the server also refuses it on its own
    r = api("POST", "/api/conversations/conv-manual-0001/turns", {"question": "カルテ番号 12345678", "answer": "a", "payload": {"kind": "final"}})
    check(r["status"] == 400 and r["body"]["code"] == "possible_identifier", "the Worker refuses to store identifier-like text")

    # 7. number check and uncited marks
    page.click("#btn-new")
    ask("__numbers__ 架空薬Xの用量")
    note()
    card = page.locator(".turn .numbers")
    expect(card).to_be_visible()
    rows = {r.locator("strong").inner_text(): r.get_attribute("class") for r in card.locator("li.num").all()}
    check(rows.get("10 mg/日") == "num cited" and rows.get("30 未満") == "num retrieved" and rows.get("500 mg/日") == "num not_found", f"number check states: {rows}")
    check(card.locator("li.num").first.inner_text().startswith("500 mg/日"), "numbers the books do not have are listed first")
    check("has-missing" in (card.get_attribute("class") or ""), "the card is outlined when a number is missing")
    check(page.locator(".turn .body .uncited").count() == 1 and "一般的な推論" in page.locator(".turn .body .uncited").inner_text(), "the line no book backs is marked, the cited ones are not")
    check("薄い文字は" in page.locator(".turn .notices").inner_text(), "a notice explains the light text")
    check("" not in page.locator(".turn .body").inner_text(), "no marker character leaks into the text")
    page.screenshot(path=str(OUT / "02-numbers.png"), full_page=True)

    # 8. the number card and marks survive a restore
    page.reload()
    page.wait_for_function("() => document.querySelector('#chip-books').textContent.includes('(1)')")
    page.click("#btn-convs")
    page.click("#tab-saved")
    page.wait_for_selector("#pane-saved .conv")
    page.locator("#pane-saved .conv-open").first.click()
    page.wait_for_selector(".turn .numbers li.num")
    check(page.locator(".turn .numbers li.num.not_found").count() == 1 and page.locator(".turn .body .uncited").count() == 1, "the number card and the marks come back with the conversation")

    # 9. delete one, then all
    page.click("#btn-convs")
    page.click("#tab-saved")
    page.wait_for_selector("#pane-saved .conv")
    n = page.locator("#pane-saved .conv").count()
    page.locator("#pane-saved .conv .btn").first.click()
    page.wait_for_function("(n) => document.querySelectorAll('#pane-saved .conv').length === n - 1", arg=n)
    check(len(api("GET", "/api/conversations")["body"]["conversations"]) == n - 1, "one conversation deleted")
    page.click("#conv-delete-all")
    page.wait_for_selector("#pane-saved:has-text('保存された会話はありません')")
    check(api("GET", "/api/conversations")["body"]["conversations"] == [] and any("元に戻せません" in d for d in dialogs), "all deleted, after a confirmation")
    page.click("#convs [data-close]")

    check(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "no horizontal page scroll at iPad width")
    bad = [l for l in logs if not (l[0] == "error" and ("favicon" in l[1] or "400" in l[1] or "Bad Request" in l[1]))]
    check(not bad, f"no console errors / CSP violations: {bad[:5]}")
    br.close()

print(f"\n{len(passed)} passed, {len(fails)} failed")
sys.exit(1 if fails else 0)
