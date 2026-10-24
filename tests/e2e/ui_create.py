"""Browser test of creating a fictional case from the books (docs/enhancement-plan.md 7.4) against worker/test/devserver.ts on the
synthetic fixture (iPad width).  The dev server's fake model writes the created case; a theme containing __copy__, __dose__ or __id__
makes it write a copied book sentence, a dose and threshold, or an identifier-like number, so the checks can be seen working.

  python3 -m ingest build --db /tmp/fx.sqlite fx tests/fixtures/synthetic_ch.md
  node --no-warnings worker/test/devserver.ts /tmp/fx.sqlite 8787 &
  python3 tests/e2e/ui_create.py http://localhost:8787 OUT_DIR
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8787"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/ui_create")
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
    logs, asks, requests = [], [], []
    page.on("console", lambda m: logs.append((m.type, m.text)) if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
    page.on("dialog", lambda d: d.accept())
    page.on("request", lambda r: requests.append((r.method, r.url)))

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

    def wait_done(pg, n):
        expect(pg.locator(".turn")).to_have_count(n)
        pg.locator(".turn").nth(n - 1).locator(".foot button").first.wait_for(timeout=20000)

    def create(pg, theme, setting="救急", level="標準", goal="", pitfall=True):
        pg.click("#btn-case")
        pg.click("#case-create")
        pg.fill("#create-theme", theme)
        pg.select_option("#create-setting", setting)
        pg.select_option("#create-level", level)
        pg.fill("#create-goal", goal)
        pg.set_checked("#create-pitfall", pitfall)
        pg.click("#create-run")

    def sections(turn):
        return [(s.locator("summary").inner_text(), s.get_attribute("open") is not None) for s in turn.locator("details.sec").all()]

    api("DELETE", "/api/conversations")  # a clean store for this run

    # 1. the dialog
    page.click("#btn-case")
    check(page.locator("#case-create").is_visible(), "the case dialog offers 書籍から架空症例を作る")
    page.click("#case-create")
    dlg = page.locator("#create")
    expect(dlg).to_be_visible()
    check(dlg.locator(".band").is_visible(), "band shown in the creation dialog")
    check("新しい架空症例" in dlg.inner_text() and "書籍の症例文は写さず" in dlg.inner_text() and "閾値・用量は書きません" in dlg.inner_text(), "the dialog says it is a new fictional case, no copied text, no thresholds or doses")
    check(page.locator("#create-level option").count() == 3 and page.locator("#create-setting option").count() == 4, "levels and settings are offered")
    page.click("#create-run")
    check(page.locator("#create-msg").is_visible() and len(asks) == 0, "a theme is required")
    page.screenshot(path=str(OUT / "01_dialog.png"))

    # 2. create: the request carries the theme and wishes, no case
    page.fill("#create-theme", "ゼルニア値の低下")
    page.select_option("#create-setting", "救急")
    page.select_option("#create-level", "紛らわしい鑑別あり")
    page.fill("#create-goal", "内服薬の関与を見落とさない")
    page.click("#create-run")
    wait_done(page, 1)
    req = asks[-1]
    check(req["mode"] == "create" and req["create"] == {"theme": "ゼルニア値の低下", "setting": "救急", "level": "紛らわしい鑑別あり", "goal": "内服薬の関与を見落とさない", "pitfall": True}, "the request carries the theme and wishes")
    check("case" not in req, "no case rides on a creation request")
    t1 = page.locator(".turn").first
    check(t1.locator(".q small").inner_text() == "架空症例の作成", "the turn is marked as a case creation")
    check("架空症例です" in t1.locator(".fictionmark").inner_text() and "実在の患者・症例ではありません" in t1.locator(".fictionmark").inner_text(), "the fiction mark is shown")
    t1.locator(".casebox summary").click()
    check("ゼルニア値の低下" in t1.locator(".casebox").inner_text() and "紛らわしい鑑別あり" in t1.locator(".casebox").inner_text(), "the request is kept with the turn")

    # 3. the answer: folded, the assessment closed, nothing lighter, no number card
    secs = sections(t1)
    heads = [h for h, _ in secs]
    check(len(heads) == 7 and heads[0] == "導入文" and heads[3] == "見立て" and heads[6] == "書籍に見つからなかった点", f"seven sections ({heads})")
    check(dict(secs).get("見立て") is False and all(o for h, o in secs if h != "見立て"), "the assessment (見立て) is folded closed, the other sections are open")
    check(t1.locator(".uncited").count() == 0 and not t1.locator(".numbers").is_visible(), "nothing is shown lighter and there is no number card (a fictional case's numbers are examples)")
    check("[推論]" not in t1.locator(".body").inner_text() and t1.locator(".src-tag").count() >= 1, "source tags are pills")
    panel = t1.locator(".create-panel")
    check(panel.count() == 1 and panel.locator(".notice").count() == 0, "no warnings for an original case")
    page.screenshot(path=str(OUT / "02_created.png"))

    # 4. into case mode: from the seven lines only, never the assessment
    panel.locator("button", has_text="症例モードに入れる").click()
    check(page.locator("#casebar").is_visible() and "70代・男性・救急" in page.locator("#casebar-text").inner_text(), "the case is pinned in case mode")
    check("見立ては入れていません" in panel.inner_text(), "the panel says the assessment was not carried over")
    page.click("#casebar-open")
    check(page.input_value("#case-complaint").startswith("ゼルニア値の低下を指摘され") and "Cr 2.4 mg/dL" in page.input_value("#case-findings"), "the case dialog holds the created case's findings")
    fields = " ".join(page.input_value(f"#case-{k}") for k in ("complaint", "vitals", "findings", "history", "own"))
    check("架空症候群" not in fields and "腎前性" not in fields and page.input_value("#case-own") == "", "no diagnosis in the case fields; the doctor's own assessment is empty")
    page.keyboard.press("Escape")

    # 5. the Modules draft
    sent = len(requests)
    panel.locator("button", has_text="Modules 用の下書き").click()
    draft = panel.locator(".create-draft")
    expect(draft).to_be_visible()
    text = draft.locator("pre").inner_text()
    check("[[case]]" in text and 'id = "xx-draft"' in text and "key = []" in text and "[要変更]" in text and "[要変換]" in text and "[要照合" in text, "the draft has a [[case]] with placeholders to fix")
    check(not any(l.startswith("[case.answers]") or l.startswith("[case.expect]") for l in text.split("\n")), "no [case.answers] and no [case.expect] table")
    check("# 所見の表" in text and "#   ゼルニア値 | 18 |" in text and "［書籍 p." in text, "the findings table is carried as comments, with the page that came from the citation")
    check("書籍ID:" in text, "the source line names the RAG book id (to be replaced with a ledger id in clinical-modules)")
    page.evaluate("window.__copied = ''; navigator.clipboard.writeText = async (t) => { window.__copied = t; }")
    draft.locator("button", has_text="下書きをコピー").click()
    page.wait_for_function("() => window.__copied.length > 0")
    check(page.evaluate("window.__copied") == text, "copy gives exactly the draft shown")
    check(not any(m != "GET" or "/api/" in u for m, u in requests[sent:]), "the panel's buttons sent nothing to the server")
    page.screenshot(path=str(OUT / "03_draft.png"))

    # 6. a copied book sentence: warned, listed, the copy withheld
    create(page, "ゼルニア値 __copy__")
    wait_done(page, 2)
    t2 = page.locator(".turn").nth(1)
    p2 = t2.locator(".create-panel")
    check("30 字以上続けて一致" in p2.locator(".notice.err").first.inner_text(), "copied book text is warned about")
    li = p2.locator(".overlaps li")
    check(li.count() >= 1 and "p." in li.first.inner_text() and "字一致" in li.first.inner_text(), "the copied run is listed with its page and length")
    p2.locator("button", has_text="Modules 用の下書き").click()
    check(p2.locator("button", has_text="下書きをコピー").is_disabled(), "the copy of the Modules draft is withheld")
    check(p2.locator("button", has_text="症例モードに入れる").is_enabled(), "case mode is still available (the copied sentence is the model's intro, not carried to the case lines)")
    page.screenshot(path=str(OUT / "04_overlap.png"))

    # 7. dose / threshold: a notice that does not block
    create(page, "ゼルニア値 __dose__")
    wait_done(page, 3)
    p3 = page.locator(".turn").nth(2).locator(".create-panel")
    n3 = p3.locator(".notice").all_inner_texts()
    check(any("用量・閾値らしい数値" in n and "5000" in n for n in n3) and not p3.locator(".notice.err").count(), "a dose and a threshold are noticed, as a warning only")
    p3.locator("button", has_text="Modules 用の下書き").click()
    check(p3.locator("button", has_text="下書きをコピー").is_enabled(), "the copy stays available for a warning that may be an example lab value")

    # 8. an identifier-like number in the output: warned and the copy withheld
    create(page, "ゼルニア値 __id__")
    wait_done(page, 4)
    p4 = page.locator(".turn").nth(3).locator(".create-panel")
    check("識別情報らしき文字" in p4.locator(".notice.err").first.inner_text() and "8桁以上" in p4.locator(".notice.err").first.inner_text(), "identifier-like text in the output is warned about")
    p4.locator("button", has_text="Modules 用の下書き").click()
    check(p4.locator("button", has_text="下書きをコピー").is_disabled(), "and the draft copy is withheld")

    # 9. the request itself goes through the identifier check
    before = len(asks)
    create(page, "カルテ番号 12345678 の件")
    expect(page.locator("#guard")).to_be_visible()
    check("「カルテ番号」の語" in page.locator("#guard-list").inner_text(), "the identifier prompt names the kind found in the request")
    page.click("#guard-fix")
    page.wait_for_timeout(200)
    check(len(asks) == before, "fix: nothing was sent")
    create(page, "カルテ番号 12345678 の件")
    page.click("#guard-send")
    wait_done(page, 5)
    check(asks[-1].get("ack_identifier") is True and asks[-1]["mode"] == "create", "send anyway: the request is acknowledged")
    page.wait_for_timeout(300)
    check("保存していません" in page.locator(".turn").nth(4).locator(".save-note").inner_text(), "an acknowledged request is not saved")

    # 10. saved with the conversation: the request and the overlap result; restored with its panel
    convs = api("GET", "/api/conversations")["body"]["conversations"]
    check(len(convs) == 1 and convs[0]["turns"] == 4, f"four turns saved, the acknowledged one not ({[c['turns'] for c in convs]})")
    saved = api("GET", "/api/conversations/" + convs[0]["id"])["body"]
    p0 = saved["turns"][0]["payload"]
    check(p0["mode"] == "create" and p0["create"]["theme"] == "ゼルニア値の低下" and p0["overlap"] == [] and "case" not in p0, "the request and the (empty) overlap result are in the saved payload")
    check("12345678" not in json.dumps(saved, ensure_ascii=False).replace("検体番号 12345678", ""), "the identifier-like request was never saved")
    store = page.evaluate("JSON.stringify([localStorage, sessionStorage])")
    check("ゼルニア値" not in store and "腎前性" not in store and "70代" not in store, "nothing of the case is kept in localStorage / sessionStorage")
    page2 = ctx.new_page()
    page2.on("dialog", lambda d: d.accept())
    page2.goto(BASE + "/")
    page2.wait_for_function("() => document.querySelector('#chip-books').textContent.includes('(1)')")
    page2.click("#btn-convs")
    page2.click("#tab-saved")
    page2.wait_for_selector(".conv-open")
    page2.click(".conv-open")
    page2.wait_for_selector(".turn .foot button")
    r1 = page2.locator(".turn").first
    check(r1.locator(".create-panel").count() == 1 and r1.locator(".create-panel .notice").count() == 0, "a reopened created case has its panel, with no warnings")
    check(dict(sections(r1)).get("見立て") is False, "and its assessment is folded closed again")
    r1.locator("button", has_text="Modules 用の下書き").click()
    check(r1.locator("button", has_text="下書きをコピー").is_enabled(), "the draft copy works on a reopened case (its overlap result was saved)")
    r3 = page2.locator(".turn").nth(1)
    check(r3.locator(".overlaps li").count() >= 1, "a reopened copied case still lists the copied run")

    bad = [l for l in logs if l[0] in ("error", "pageerror")]
    check(not bad, f"no console errors ({bad[:3]})")
    br.close()

print(f"\n{len(passed)} passed, {len(fails)} failed")
sys.exit(1 if fails else 0)
