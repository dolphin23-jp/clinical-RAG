"""Browser test of case mode (docs/enhancement-plan.md 7.2) against worker/test/devserver.ts on the synthetic fixture (iPad width).

  python3 -m ingest build --db /tmp/fx.sqlite fx tests/fixtures/synthetic_ch.md
  node --no-warnings worker/test/devserver.ts /tmp/fx.sqlite 8787 &
  python3 tests/e2e/ui_case.py http://localhost:8787 OUT_DIR

Checks: the case dialog (band, fields, identifier warning while typing), the pinned bar, the four mode buttons, what the request
carries, the draft answer (draft mark, folded sections, source tags, uncited lines), the doctor's own assessment adding its section,
the identifier prompt before sending (fix / send anyway: an acknowledged turn is not saved), saving and restoring the case with a
conversation, a new conversation dropping the case, and that the case is never kept in the browser's own storage.
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8787"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/ui_case")
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
    logs, dialogs, asks = [], [], []
    page.on("console", lambda m: logs.append((m.type, m.text)) if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
    page.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))

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

    def fill_case(c, own=""):
        page.fill("#case-age", c.get("age", ""))
        for k in ("sex", "setting"):
            page.select_option(f"#case-{k}", c.get(k, ""))
        for k in ("complaint", "vitals", "findings", "history"):
            page.fill(f"#case-{k}", c.get(k, ""))
        page.fill("#case-own", own)

    def wait_done(n):
        expect(page.locator(".turn")).to_have_count(n)
        page.locator(".turn").nth(n - 1).locator(".foot button").first.wait_for(timeout=20000)

    api("DELETE", "/api/conversations")  # a clean store for this run

    # 1. nothing pinned at first: no bar, no mode buttons; the dialog has the band and every field
    check(not page.locator("#casebar").is_visible(), "no case bar before a case is pinned")
    check(not page.locator("#case-modes").is_visible(), "no mode buttons before a case is pinned")
    page.click("#btn-case")
    expect(page.locator("#case")).to_be_visible()
    check(page.locator("#case .band").is_visible(), "band shown in the case dialog")
    check(page.locator("#case-fields textarea:not(.extract-memo)").count() == 5, "five free-text fields (complaint, vitals, findings, history, own)")
    check(page.locator("input#case-age").count() == 1 and page.locator("#case-age").get_attribute("inputmode") == "numeric", "the age is a numeric text field (whole years), not a band list")
    check(page.locator("label[for=case-age]").inner_text() == "年齢（歳）", "the age field says years")
    check("日付は「3日前から」" in page.locator("#case").inner_text(), "the dialog tells to write dates as elapsed days")
    page.screenshot(path=str(OUT / "01_dialog_empty.png"))

    # 2. pinning an empty case is refused; an identifier-like word warns while typing (kinds only)
    page.click("#case-pin")
    check(page.locator("#case-msg").is_visible(), "an empty case cannot be pinned")
    page.fill("#case-age", "72")
    page.click("#case-pin")
    check(page.locator("#case-msg").is_visible() and not page.locator("#casebar").is_visible(), "age alone is not a case")
    for bad in ["七十二", "131", "72.5", "-3", "70代前半", "0x10"]:
        page.fill("#case-age", bad)
        page.click("#case-pin")
        check("整数" in page.locator("#case-msg").inner_text() and not page.locator("#casebar").is_visible(), f"an age that is not whole years is refused: {bad}")
    page.fill("#case-age", "72")
    page.fill("#case-complaint", "カルテ番号 12345678 の件")
    warn = page.locator("#case-warn")
    check(warn.is_visible() and "「カルテ番号」の語" in warn.inner_text() and "12345678" not in warn.inner_text(), "identifier warning names the kind, never the text")
    page.screenshot(path=str(OUT / "02_dialog_warn.png"))

    # 3. pin a real case: the bar shows one line; the four buttons appear
    fill_case(CASE)
    check(not warn.is_visible(), "the warning clears when the words are gone")
    page.click("#case-pin")
    expect(page.locator("#case")).not_to_be_visible()
    bar = page.locator("#casebar")
    check(bar.is_visible() and "72歳・男性・救急" in page.locator("#casebar-text").inner_text(), "the bar summarises age, sex, setting and the complaint")
    check(page.locator("#case-modes button").count() == 4, "four mode buttons")
    labels = [b.inner_text() for b in page.locator("#case-modes button").all()]
    check(labels == ["アセスメントとプラン（草案）", "鑑別と反証", "見落としチェック", "コンサルト・医師コールの基準"], "mode buttons carry the four labels")
    check(page.locator("#casebar-attach").is_checked(), "free questions carry the case by default")
    check(page.locator("#casebar").bounding_box()["y"] < 140, "the bar stays in the sticky header")
    page.screenshot(path=str(OUT / "03_pinned.png"))

    # 4. a mode button: the request carries mode + case and the label as the question; the draft shows its marks
    page.click("#case-modes button[data-mode=assess]")
    wait_done(1)
    req = asks[-1]
    check(req.get("mode") == "assess" and req["question"] == "アセスメントとプラン（草案）", "assess button sends its mode and label")
    check(req["case"]["complaint"] == CASE["complaint"] and req["case"]["age"] == "72" and req["case"]["own"] == "", "the case is sent as typed")
    check(req["history"] == [], "no history on the first turn")
    turn = page.locator(".turn").first
    check("症例つき" in turn.locator(".q small").inner_text(), "the turn is marked as asked with a case")
    check("草案" in turn.locator(".draftmark").inner_text() and "最終判断は医師" in turn.locator(".draftmark").inner_text(), "draft mark on the answer")
    sections = turn.locator("details.sec")
    heads = [s.locator("summary").inner_text() for s in sections.all()]
    check(heads[:3] == ["問題リスト", "各問題の評価（根拠と反証）", "初期プラン（検査・治療・モニタリング・再評価）"] and len(heads) == 6, f"answer folded into the six fixed sections ({len(heads)})")
    check(all(s.get_attribute("open") is not None for s in sections.all()), "sections start open")
    tags = [t.inner_text() for t in turn.locator(".src-tag").all()]
    check({"推論", "標準・出典未確認", "施設依存"} <= set(tags), f"source tags shown as pills ({sorted(set(tags))})")
    check(turn.locator(".cite").count() >= 1, "a cited line carries a citation chip")
    check(turn.locator(".uncited").count() >= 1, "uncited lines are shown lighter")
    check("[推論]" not in turn.locator(".body").inner_text(), "the bracketed tag text is replaced by the pill")
    check(not turn.locator(".numbers").is_visible(), "the doctor's own numbers (Cr 2.4 mg/dL) are not flagged by the number check")
    check("この質問に付けた症例" in turn.locator(".casebox summary").inner_text(), "the case used is kept with the turn")
    turn.locator(".casebox summary").click()
    check("Cr 2.4 mg/dL" in turn.locator(".casebox").inner_text() and "ゼルニア値" in turn.locator(".casebox").inner_text(), "the case box shows what was sent")
    turn.locator("details.sec summary").first.click()
    check(turn.locator("details.sec").first.get_attribute("open") is None, "a section can be closed")
    turn.locator("details.sec summary").first.click()
    check("保存済み" in turn.locator(".save-note").inner_text(), "the turn was saved")
    page.screenshot(path=str(OUT / "04_assess.png"), full_page=False)

    # 5. no own assessment -> no differences section; typing one adds it (a difference, not a grade)
    check("先生の案との差" not in turn.inner_text(), "no differences section without the doctor's own assessment")
    page.click("#casebar-open")
    check(page.input_value("#case-complaint") == CASE["complaint"], "editing a pinned case starts from its text")
    page.fill("#case-own", "感染に伴う腎前性AKIを第一に考える。")
    page.click("#case-pin")
    page.click("#case-modes button[data-mode=assess]")
    wait_done(2)
    turn2 = page.locator(".turn").nth(1)
    check(asks[-1]["case"]["own"] == "感染に伴う腎前性AKIを第一に考える。", "the second request carries the doctor's own assessment")
    check("先生の案との差" in [s.locator("summary").inner_text() for s in turn2.locator("details.sec").all()], "the differences section appears when the doctor typed their own assessment")
    check(len(asks[-1]["history"]) == 2 and "【症例" not in json.dumps(asks[-1]["history"], ensure_ascii=False), "the history is plain text (the case is not repeated in it)")
    page.click("#case-modes button[data-mode=ddx]")
    wait_done(3)
    ddx = page.locator(".turn").nth(2)
    check("先生の見立てへの反証" in [s.locator("summary").inner_text() for s in ddx.locator("details.sec").all()], "the differential adds the rebuttal section for the doctor's own assessment")

    # 6. a typed question carries the case unless the switch is off; the answer is not folded (free form)
    page.fill("#q", "ゼルニア値の基準は？")
    page.click("#send")
    wait_done(4)
    check(asks[-1].get("mode") == "ask" and "case" in asks[-1] and asks[-1]["question"] == "ゼルニア値の基準は？", "a typed question carries the case in ask mode")
    check(page.locator(".turn").nth(3).locator("details.sec").count() == 0, "a free question is not folded into sections")
    page.uncheck("#casebar-attach")
    page.fill("#q", "ゼルニア値の定義は？")
    page.click("#send")
    wait_done(5)
    check("case" not in asks[-1] and "mode" not in asks[-1], "with the switch off, a typed question goes without the case")
    check(page.locator(".turn").nth(4).locator(".casebox").count() == 0, "and the turn shows no case")
    page.check("#casebar-attach")

    # 7. the identifier prompt covers the case: "fix" sends nothing, "send anyway" sends but the turn is not saved
    sent = len(asks)
    page.click("#casebar-open")
    page.fill("#case-vitals", "BP 92/54 患者ID 12345")
    page.click("#case-pin")
    page.click("#case-modes button[data-mode=consult]")
    expect(page.locator("#guard")).to_be_visible()
    check("「患者ID」の語" in page.locator("#guard-list").inner_text(), "the identifier prompt names the kind found in the case")
    page.click("#guard-fix")
    page.wait_for_timeout(200)
    check(len(asks) == sent, "fix: nothing was sent")
    page.click("#case-modes button[data-mode=consult]")
    page.click("#guard-send")
    wait_done(6)
    check(asks[-1].get("ack_identifier") is True and asks[-1].get("mode") == "consult", "send anyway: the request is acknowledged")
    page.wait_for_timeout(300)
    check("保存していません" in page.locator(".turn").nth(5).locator(".save-note").inner_text(), "an acknowledged turn is not saved")
    # the same case again: asked once, not every time
    page.click("#case-modes button[data-mode=miss]")
    wait_done(7)
    check(not page.locator("#guard").is_visible() and asks[-1].get("ack_identifier") is True, "the confirmed case does not prompt again, and is still sent as acknowledged")
    check("保存していません" in page.locator(".turn").nth(6).locator(".save-note").inner_text(), "and is still not saved")

    # 8. the server holds only the clean turns, with the case in each payload
    convs = api("GET", "/api/conversations")["body"]["conversations"]
    check(len(convs) == 1 and convs[0]["turns"] == 5, f"five turns saved (the two acknowledged ones are not) — {[c['turns'] for c in convs]}")
    saved = api("GET", "/api/conversations/" + convs[0]["id"])["body"]
    p0 = saved["turns"][0]["payload"]
    check(p0["mode"] == "assess" and p0["case"]["findings"] == CASE["findings"], "the case and mode are in the saved payload")
    check("case" not in saved["turns"][4]["payload"], "a turn asked without the case saves none")
    check("12345" not in json.dumps(saved, ensure_ascii=False), "the identifier-like text was never saved")

    # 9. nothing about the case is kept in the browser's own storage
    store = page.evaluate("JSON.stringify([localStorage, sessionStorage])")
    check("ゼルニア値" not in store and "Cr 2.4" not in store and "高血圧" not in store, "the case is not kept in localStorage / sessionStorage")

    # 10. reopen the saved conversation in a fresh page: the last case is pinned again and each turn shows its case
    page2 = ctx.new_page()
    page2.on("dialog", lambda d: d.accept())
    page2.goto(BASE + "/")
    page2.wait_for_function("() => document.querySelector('#chip-books').textContent.includes('(1)')")
    page2.click("#btn-convs")
    page2.click("#tab-saved")
    page2.wait_for_selector(".conv-open")
    page2.click(".conv-open")
    page2.wait_for_selector(".turn .foot button")
    check(page2.locator("#casebar").is_visible() and "72歳・男性・救急" in page2.locator("#casebar-text").inner_text(), "reopening pins the case the conversation was last asked with")
    check(page2.locator("#case-modes").is_visible(), "and the mode buttons are back")
    first = page2.locator(".turn").first
    check(first.locator("details.sec").count() == 6 and first.locator(".src-tag").count() >= 3, "the restored draft keeps its sections and tags")
    first.locator(".casebox summary").click()
    check("Cr 2.4 mg/dL" in first.locator(".casebox").inner_text(), "the restored turn shows the case it was asked with")
    page2.screenshot(path=str(OUT / "05_restored.png"))

    # 11. a new conversation drops the case (asks first because nothing of it was ever saved only when unasked)
    page2.click("#btn-new")
    check(not page2.locator("#casebar").is_visible() and not page2.locator("#case-modes").is_visible(), "a new conversation drops the pinned case")
    page2.click("#btn-case")
    check(page2.input_value("#case-complaint") == "", "and the dialog is empty again")
    page2.keyboard.press("Escape")

    # 12. the copy of a draft starts with the draft mark
    page.evaluate("window.__copied = ''; navigator.clipboard.writeText = async (t) => { window.__copied = t; }")
    page.locator(".turn").first.locator(".foot button", has_text="回答をコピー").click()
    page.wait_for_function("window.__copied.length > 0")
    check(page.evaluate("window.__copied").startswith("【AIの草案・参考情報"), "a copied draft starts with the draft mark")

    bad = [l for l in logs if l[0] in ("error", "pageerror")]
    check(not bad, f"no console errors ({bad[:3]})")
    br.close()

print(f"\n{len(passed)} passed, {len(fails)} failed")
sys.exit(1 if fails else 0)
