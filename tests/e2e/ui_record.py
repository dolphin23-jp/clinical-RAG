"""Browser test of the case record (docs/enhancement-plan.md 8; docs/clinical-use.md 1e) against worker/test/devserver.ts on the synthetic
fixture (iPad width).

  python3 -m ingest build --db /tmp/fx.sqlite fx tests/fixtures/synthetic_ch.md
  node --no-warnings worker/test/devserver.ts /tmp/fx.sqlite 8787 &
  python3 tests/e2e/ui_record.py http://localhost:8787 OUT_DIR

Checks: the list (retention said, nothing without a pinned case), making a record from the pinned case by taking the adopted items in, the
emergency time axis (minutes from the arrival, the next-day reading, no judgement), the notes on what is blank, carrying items over as the
doctor's own act (to a new problem, to an existing one, not at all), the problem board (stable ids, priority, certainty, plan states), the
doctor's own admission texts, the A05 draft (what is in it and what is not, the marks and their removal, copy), saving by itself with the
revision, identifier-like text blocked here and by the Worker, a record read back on a fresh page with the form restored, a save from
another screen refused (not overwritten), ending a record, and that nothing of it is kept in the browser's own storage.
"""
import json
import re
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8787"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/ui_record")
OUT.mkdir(parents=True, exist_ok=True)
TOKEN = "test-token-0123456789abcdef"
FLOW = "emergency-department.abdominal-pain"
passed, fails = [], []


def check(cond, msg):
    (passed if cond else fails).append(msg)
    print(("PASS " if cond else "FAIL ") + msg, flush=True)


CASE = {
    "age": "70代",
    "sex": "男性",
    "setting": "救急",
    "complaint": "ゼルニア値の低下を指摘された。3日前から腹痛と嘔気。",
    "vitals": "BP 92/54, HR 108, SpO2 94%",
    "findings": "Cr 2.4 mg/dL（ふだんは 0.9）, K 5.8 mEq/L",
    "history": "高血圧。内服はアムロジピン。",
}

with sync_playwright() as pw:
    br = pw.chromium.launch()
    ctx = br.new_context(viewport={"width": 820, "height": 1180}, device_scale_factor=2, has_touch=True, is_mobile=True, locale="ja-JP")
    page = ctx.new_page()
    logs, puts = [], []
    page.on("console", lambda m: logs.append((m.type, m.text)) if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
    page.on("dialog", lambda d: d.accept())

    def on_request(r):
        if "/api/records/" in r.url and r.method == "PUT":
            puts.append(json.loads(r.post_data))

    page.on("request", on_request)
    page.goto(BASE + "/")
    page.evaluate(f"localStorage.setItem('mb.token','{TOKEN}')")
    page.reload()
    page.wait_for_function("() => document.querySelector('#chip-books').textContent.includes('(1)')")

    def api(method, path, body=None, pg=None):
        return (pg or page).evaluate(
            """async ([m, p, b, t]) => { const r = await fetch(p, {method: m, headers: {authorization: 'Bearer ' + t, 'content-type': 'application/json'}, body: b ? JSON.stringify(b) : undefined});
               return {status: r.status, body: await r.json().catch(() => null)}; }""",
            [method, path, body, TOKEN],
        )

    def tick(loc, on=True):
        loc.evaluate("el => el.scrollIntoView({block: 'center'})")
        loc.set_checked(on)

    def q(qid):
        return page.locator(f".intake-q[data-q={qid}]")

    def open_all():
        page.evaluate("() => document.querySelectorAll('details.intake-phase, details.intake-more').forEach((d) => { d.open = true; })")

    def wait_saved():
        expect(page.locator("#record .rec-status")).to_have_text("保存済み", timeout=8000)

    def wait_done(n):
        expect(page.locator(".turn")).to_have_count(n)
        page.locator(".turn").nth(n - 1).locator(".foot button").first.wait_for(timeout=20000)

    def rec_text():
        return page.locator("#record-body").inner_text()

    api("DELETE", "/api/conversations")
    api("DELETE", "/api/records")

    # 1. the entrances; without a pinned case the list says how to make a record; the retention is said
    check(page.locator("#btn-records").is_visible(), "the header has the records button")
    page.click("#btn-records")
    dlg = page.locator("#record")
    expect(dlg).to_be_visible()
    check(dlg.locator(".band").is_visible(), "band shown in the record dialog")
    expect(page.locator("#record-body .rec-list, #record-body .help").first).to_be_visible()
    t = rec_text()
    check("最後の更新から60日で自動的に消えます" in t and "「終える」で消せます" in t, "the retention and the way to end a record are said")
    check("先に「症例」を固定してください" in t and "保存した記録はありません" in t, "no pinned case and no records: the list says what to do")
    check(not page.locator("#record button", has_text="いま固定している症例を記録にする").count(), "no 'make a record' button without a pinned case")
    page.keyboard.press("Escape")

    # 2. the case: age/sex/setting, free text, and the scene x symptom questions with times
    page.click("#btn-case")
    for k in ("age", "sex", "setting"):
        page.select_option(f"#case-{k}", CASE[k])
    for k in ("complaint", "vitals", "findings", "history"):
        page.fill(f"#case-{k}", CASE[k])
    page.locator("details.intake > summary").first.click()
    expect(page.locator("#intake-flow option")).to_have_count(14)
    page.select_option("#intake-flow", FLOW)
    open_all()
    q("first").locator("button.chip[data-opt=sick]").click()
    q("t_arrival").locator("input").fill("21:40")
    q("t_ecg").locator("input").fill("21:52")
    q("ecg_find").locator("button.chip[data-opt=normal]").click()
    q("t_analg").locator("input").fill("22:30")
    q("t_dispo").locator("input").fill("00:10")
    q("ct_res").locator("button.chip[data-opt=pending]").click()
    page.click("#case-pin")
    check(page.locator("#casebar-record").is_visible() and page.locator("#casebar-record").inner_text() == "記録", "the casebar has a 記録 button (not linked yet)")

    # 3. a draft; the adopted items go into the record by the doctor's own button (the record is made then)
    page.click("#case-modes button[data-mode=assess]")
    wait_done(1)
    turn = page.locator(".turn").first

    def section(name):
        return turn.locator("details.sec", has=page.locator("summary", has_text=name))

    check(turn.locator(".record-add").inner_text() == "症例の記録へ", "the turn has a button to take the adopted items into the record")
    turn.locator(".record-add").click()
    check("先に項目を「採用」してください" in turn.locator(".record-add").inner_text(), "with nothing adopted it says so and makes no record")
    check(api("GET", "/api/records")["body"]["records"] == [], "nothing was made")
    tick(section("問題リスト").locator(".adopt input").nth(0))
    tick(section("問題リスト").locator(".adopt input").nth(1))
    tick(section("各問題の評価").locator(".adopt-cell input").first)
    plan_items = section("初期プラン").locator("li", has_text="について、この症例の入力からの整理")
    tick(plan_items.locator(".adopt input").first)
    tick(section("コンサルト・医師コールの基準").locator(".adopt input").first)
    turn.locator(".record-add").click()
    expect(turn.locator(".record-add")).to_contain_text("記録に取り込みました（新しく 5 件）", timeout=8000)
    recs = api("GET", "/api/records")["body"]["records"]
    check(len(recs) == 1 and recs[0]["rev"] >= 1, f"the record was made on the server ({recs})")
    rid = recs[0]["id"]
    check(page.locator("#casebar-record").inner_text() == "記録（連動中）", "the casebar says the pinned case is linked to the open record")
    turn.locator(".record-add").click()
    page.wait_for_timeout(600)
    check(len(api("GET", f"/api/records/{rid}")["body"]["record"]["ed"]["adopted"]) == 5, "taking the same items again adds none (no duplicates)")

    # 4. the record: the emergency time axis
    page.click("#casebar-record")
    expect(dlg).to_be_visible()
    expect(page.locator("#record .rec-status")).to_have_text("保存済み")
    check(page.locator(".rec-title").inner_text().startswith("70代・男性・救急｜"), "the title is the case's one line")
    rows = [r.inner_text().replace("\n", " ") for r in page.locator(".rec-axis-row").all()]
    check(len(rows) == 4, f"four times on the axis ({rows})")
    check(rows[0].startswith("0分") and "21:40" in rows[0] and "病着" in rows[0], "the arrival is minute 0")
    check(rows[1].startswith("+12分") and "12誘導ECG" in rows[1] and "ECG異常なし" in rows[1], f"12 minutes after the arrival, with the finding hung on it ({rows[1]})")
    check(rows[2].startswith("+50分") and "鎮痛" in rows[2], "analgesia at +50")
    check(rows[3].startswith("+150分") and "Disposition決定" in rows[3] and "翌日と見なした" in rows[3], f"a time past midnight is read as the next day and says so ({rows[3]})")
    axis = page.locator(".rec-axis").inner_text()
    check(not re.search(r"遅|早い|基準|正常|異常です|警告", axis), "the axis judges nothing")
    check("遅い・早いの判定や、基準の時間との比較はしません" in rec_text(), "the screen says there is no judgement of time")
    page.screenshot(path=str(OUT / "01_axis.png"))

    # 5. the notes on what is blank: counted, named, not concluded
    ids = [c.get_attribute("data-id") for c in page.locator(".rec-check").all()]
    check(ids[:3] == ["core_missing", "waiting", "undecided"] and "no_problems" in ids and "unfilled" in ids, f"checks: {ids}")
    check("未確認。陰性ではありません" in page.locator(".rec-check[data-id=core_missing]").inner_text(), "unanswered core questions are 未確認, not negative")
    check("5 件" in page.locator(".rec-check[data-id=undecided]").inner_text(), "five adopted items are waiting for the doctor's decision")
    check("CT" in page.locator(".rec-check[data-id=waiting]").inner_text(), "the result the doctor marked as waiting is listed")
    check(not re.search(r"異常|正常|遅|問題なし|危険", page.locator(".rec-checks").inner_text()), "no check says normal / abnormal / late")

    # 5b. editing the case from the record: the case dialog opens on top; pinning again updates the record's emergency case (and keeps the axis)
    page.locator("#record button", has_text="症例を開く").click()
    expect(page.locator("#case")).to_be_visible()
    page.fill("#case-vitals", "BP 100/60, HR 96")
    page.click("#case-pin")
    expect(page.locator("#case")).not_to_be_visible()
    expect(dlg).to_be_visible()
    wait_saved()
    srv_case = api("GET", f"/api/records/{rid}")["body"]["record"]["ed"]["case"]
    check(srv_case["vitals"] == "BP 100/60, HR 96" and srv_case["intake"]["flow"] == FLOW, "pinning the edited case again updates the record's emergency case (the form's answers kept)")
    check(len(page.locator(".rec-axis-row").all()) == 4, "and the time axis is still there")

    # 6. carrying over is the doctor's act: nothing is on the board until it is chosen
    check(page.locator(".rec-problem").count() == 0, "adopting items did not put anything on the board")
    adopted = page.locator(".rec-adopted")
    check(adopted.count() == 5, "the five adopted items are listed")
    first = adopted.nth(0)
    first.locator("select").select_option("new")
    check(page.locator(".rec-problem").count() == 1 and page.locator(".rec-problem .rec-id").first.inner_text() == "p1", "a new problem p1 from the item")
    check("救急から" in page.locator(".rec-problem .rec-tag").first.inner_text(), "it is marked as from the emergency encounter")
    adopted.nth(1).locator("select").select_option("none")
    assess_idx = [i for i in range(5) if "評価" in adopted.nth(i).locator(".rec-role").inner_text()][0]
    adopted.nth(assess_idx).locator("select").select_option("p1")
    plan_idx = [i for i in range(5) if "初期プラン" in adopted.nth(i).locator(".rec-role").inner_text()][0]
    adopted.nth(plan_idx).locator("select").select_option("p1")
    cont_idx = [i for i in range(5) if "コール" in adopted.nth(i).locator(".rec-role").inner_text()][0]
    adopted.nth(cont_idx).locator("select").select_option("outlook")
    p1 = page.locator(".rec-problem").first
    check(p1.locator(".rec-entry").count() == 2, "an assessment and a plan entry came to p1")
    check(p1.locator(".rec-tag.ai").count() == 2, "the entries keep their AI mark")
    check(p1.locator(".rec-state .chip[aria-pressed=true]").inner_text() == "予定・検討", "a carried plan is 'planned', not done")
    check(not page.locator(".rec-check[data-id=undecided]").count(), "nothing is left undecided")
    page.screenshot(path=str(OUT / "02_board.png"))

    # 7. the board: label, certainty (blank unless chosen), priority, a typed problem, plan state
    label = p1.locator("input.rec-label")
    label.fill("腎前性AKI")
    check(p1.locator(".rec-cert .chip[aria-pressed=true]").count() == 0, "the certainty is blank until the doctor chooses")
    p1.locator(".rec-cert .chip[data-opt=suspected]").click()
    check(page.locator(".rec-problem").first.locator(".rec-cert .chip[aria-pressed=true]").inner_text() == "疑い", "certainty chosen")
    page.locator("button", has_text="＋ 問題を足す").click()
    p2 = page.locator(".rec-problem").nth(1)
    check(p2.locator(".rec-id").inner_text() == "p2", "the next problem is p2")
    p2.locator("input.rec-label").fill("高血圧の管理")
    p2.locator("button", has_text="＋ 評価を足す").click()
    p2.locator(".rec-entry textarea").first.fill("内服の再開前に血圧を確認する")
    p2.locator("button", has_text="＋ 計画を足す").click()
    p2.locator(".rec-entry").nth(1).locator("textarea").fill("降圧薬は腎機能をみて再開")
    p2.locator(".rec-entry").nth(1).locator(".chip[data-opt=done]").click()
    p2 = page.locator(".rec-problem").nth(1)
    p2.locator("input.rec-reason").fill("内服は継続した")
    page.locator(".rec-problem").nth(1).locator("button[aria-label='優先順位を上げる']").click()
    order = [pr.locator(".rec-id").inner_text() for pr in page.locator(".rec-problem").all()]
    check(order == ["p2", "p1"], f"priority order changed, ids did not ({order})")
    check(page.locator(".rec-problem").first.locator("button[aria-label='優先順位を上げる']").is_disabled(), "the first problem cannot go up")
    # a removed problem's id is not given again
    page.locator("button", has_text="＋ 問題を足す").click()
    page.locator(".rec-problem").nth(2).locator("button", has_text="削除").first.click()
    page.locator("button", has_text="＋ 問題を足す").click()
    check([pr.locator(".rec-id").inner_text() for pr in page.locator(".rec-problem").all()][-1] == "p4", "p3 was removed; the next one is p4, not p3")
    page.locator(".rec-problem").nth(2).locator("button", has_text="削除").first.click()

    # 8. the doctor's own texts, with a date that becomes relative
    adm = page.locator("textarea.rec-adm")
    check(adm.count() == 5, "five texts of the doctor's own for the admission note")
    adm.nth(0).fill("救急外来から、脱水と腎機能の評価・加療のため")
    adm.nth(1).fill("70代男性。脱水に伴う腎前性AKIを疑う。10/20 から腹痛。")
    adm.nth(1).blur()
    check("10/20" not in adm.nth(1).input_value() and "日前" in adm.nth(1).input_value(), f"a date typed here becomes relative ({adm.nth(1).input_value()})")
    check("日付を経過の表現に直しました" in rec_text(), "and the note says so")

    # 9. the draft of the admission note
    pre = page.locator(".rec-note-text")
    text = pre.inner_text()
    check(text.startswith("【病棟入院時】下書き\n［日付］　［患者ID］　［氏名］"), "the draft starts with its title and the blank date / ID / name")
    check("1. 高血圧の管理" in text and "2. 腎前性AKI（疑い）" in text.replace("〔救急から〕", "").replace("  ", " ") or "2. 腎前性AKI（疑い）" in text, "the problems in priority order")
    check("〔AI草案〕" in text and "〔救急から〕" in text, "the AI mark and the carried mark are in")
    check("実施（医師の記録）:\n・降圧薬は腎機能をみて再開（理由: 内服は継続した）" in text, "what the doctor recorded as done is under 実施 with its reason")
    check("計画（予定・検討。実施の記録ではありません）" in text, "a plan is labelled as a plan")
    check("救急外来から、脱水と腎機能の評価・加療のため" in text and "脱水に伴う腎前性AKIを疑う" in text, "the doctor's own texts are in")
    check(re.search(r"\d{4}年|(?<![\d/])\d{1,2}/\d{1,2}(?![\d/])|令和", re.sub(r"BP \d+/\d+", "", text)) is None, "no calendar date in the draft")
    page.locator("#record label.check", has_text="〔AI草案〕の印を残す").locator("input").uncheck()
    page.locator("#record label.check", has_text="出どころの印").locator("input").uncheck()
    plain = pre.inner_text()
    check("〔AI草案〕" not in plain and "〔救急から〕" not in plain and "[推論]" not in plain, "both marks can be taken off for the copy")
    page.locator("#record label.check", has_text="〔AI草案〕の印を残す").locator("input").check()
    page.locator("#record label.check", has_text="出どころの印").locator("input").check()
    page.evaluate("window.__copied = ''; navigator.clipboard.writeText = async (t) => { window.__copied = t; }")
    page.locator("#record button", has_text="コピー").click()
    page.wait_for_function("() => window.__copied.length > 0")
    check(page.evaluate("window.__copied").startswith("【病棟入院時】下書き"), "copy puts the draft on the clipboard")
    page.screenshot(path=str(OUT / "03_note.png"), full_page=False)

    # 10. saved by itself, with the revision; the server holds the record with stable ids and no calendar date
    wait_saved()
    rec = api("GET", f"/api/records/{rid}")["body"]
    check(rec["rev"] >= 3 and [p["id"] for p in rec["record"]["problems"]] == ["p2", "p1"], f"saved by itself ({rec['rev']}, {[p['id'] for p in rec['record']['problems']]})")
    check(rec["record"]["seq"]["p"] == 4, "the counter remembers the removed problems")
    check("10/20" not in json.dumps(rec["record"], ensure_ascii=False), "no calendar date was saved")
    check(all("rev" in p for p in puts[1:]) and puts[-1]["rev"] == rec["rev"] - 1, "each save carries the revision it was based on")
    check(rec["record"]["problems"][1]["plan"][0]["state"] == "planned" and rec["record"]["problems"][1]["plan"][0]["from"] == "ai", "the carried AI plan is saved as planned, from AI")

    # 10b. a date typed and never left (no blur, no paste) is still made relative before it is saved
    adm.nth(4).fill("10/21 に再評価予定")
    page.wait_for_timeout(2600)
    wait_saved()
    saved_outlook = api("GET", f"/api/records/{rid}")["body"]["record"]["adm"]["outlook"]
    check("10/21" not in saved_outlook and re.search(r"(日前|日後|か月前)", saved_outlook) is not None, f"the last pass before saving made it relative ({saved_outlook})")
    check("日付を経過の表現に直しました" in rec_text(), "and the screen says so")

    # 11. identifier-like text: warned here, not saved; the server holds the last clean version
    before = api("GET", f"/api/records/{rid}")["body"]["rev"]
    page.locator("input.rec-label").first.fill("カルテ番号 12345678 の件")
    expect(page.locator("#rec-warn")).to_be_visible()
    check("「カルテ番号」の語" in page.locator("#rec-warn").inner_text() and "12345678" not in page.locator("#rec-warn").inner_text(), "a warning names the kind, never the text")
    page.wait_for_timeout(2200)
    check("保存していません" in page.locator("#record .rec-status").inner_text(), "the status says it is not saved")
    srv = api("GET", f"/api/records/{rid}")["body"]
    check(srv["rev"] == before and "12345678" not in json.dumps(srv, ensure_ascii=False), "the server still holds the last clean version")
    direct = api("PUT", f"/api/records/{rid}", {"rev": before, "record": {**srv["record"], "title": "患者ID 99999999"}})
    check(direct["status"] == 400 and direct["body"]["code"] == "possible_identifier", "and the Worker refuses it on its own")
    page.locator("input.rec-label").first.fill("高血圧の管理")
    expect(page.locator("#rec-warn")).to_be_hidden()
    wait_saved()
    check(not page.locator("#record .rec-msg").is_visible(), "fixing it saves again and clears the message")

    # 12. a save from another screen is not overwritten
    cur = api("GET", f"/api/records/{rid}")["body"]
    other = dict(cur["record"])
    other["adm"] = {**other["adm"], "baseline": "別の画面で書いたベースライン"}
    check(api("PUT", f"/api/records/{rid}", {"rev": cur["rev"], "record": other})["status"] == 200, "another screen saved")
    adm.nth(3).fill("この画面で書いた全身管理")
    page.wait_for_timeout(2200)
    check("別の画面で更新されています" in page.locator("#record .rec-msg").inner_text() and "保存していません" in page.locator("#record .rec-status").inner_text(), "this screen is told, and does not overwrite")
    check(api("GET", f"/api/records/{rid}")["body"]["record"]["adm"]["baseline"] == "別の画面で書いたベースライン", "the other screen's text is still there")
    page.keyboard.press("Escape")

    # 13. a fresh page: the list, opening a record pins its case and restores the form; ids are the same
    page2 = ctx.new_page()
    page2.on("dialog", lambda d: d.accept())
    page2.goto(BASE + "/")
    page2.wait_for_function("() => document.querySelector('#chip-books').textContent.includes('(1)')")
    page2.click("#btn-records")
    page2.wait_for_selector(".rec-item")
    item = page2.locator(".rec-item").first
    check("最終更新 今日" in item.inner_text() and item.locator(".rec-item-title").inner_text().startswith("70代・男性・救急"), "the list shows the title and when it was last updated (relative)")
    page2.screenshot(path=str(OUT / "04_list.png"))
    item.locator("button", has_text="開く").click()
    page2.wait_for_selector(".rec-problem")
    check(page2.locator("#casebar").is_visible() and "70代・男性・救急" in page2.locator("#casebar-text").inner_text(), "opening a record pins its case")
    check([pr.locator(".rec-id").inner_text() for pr in page2.locator(".rec-problem").all()] == ["p2", "p1"], "the problems come back with the same ids and order")
    check(len(page2.locator(".rec-axis-row").all()) == 4, "and the time axis is rebuilt from the saved answers")
    page2.keyboard.press("Escape")
    page2.click("#btn-case")
    expect(page2.locator("#intake-flow")).to_have_value(FLOW)
    page2.keyboard.press("Escape")

    # 14. ending a record deletes it from the server; the pinned case stays
    page.click("#casebar-record")
    page.locator("#record button", has_text="記録の一覧").click()
    page.wait_for_selector(".rec-item")
    page.locator(".rec-item button", has_text="終える").click()
    page.wait_for_selector("text=保存した記録はありません")
    check(api("GET", f"/api/records/{rid}")["status"] == 404 and api("GET", "/api/records")["body"]["records"] == [], "the record is gone from the server")
    check("記録を終えました（削除しました）" in rec_text(), "the screen says it was ended")
    page.keyboard.press("Escape")
    check(page.locator("#casebar").is_visible(), "the pinned case stays (it is in the conversation)")

    # 14b. a record can be made from the list with the pinned case, and ended from inside the record
    page.click("#btn-records")
    page.wait_for_selector("text=保存した記録はありません")
    page.locator("#record button", has_text="いま固定している症例を記録にする").click()
    page.wait_for_selector(".rec-title")
    check(len(api("GET", "/api/records")["body"]["records"]) == 1 and page.locator(".rec-problem").count() == 0, "a record made from the list starts empty (no items, no problems)")
    check(page.locator("#casebar-record").inner_text() == "記録（連動中）", "and the case is linked to it")
    page.locator("#record button", has_text="この症例を終える（削除）").click()
    page.wait_for_selector("text=保存した記録はありません")
    check(api("GET", "/api/records")["body"]["records"] == [] and page.locator("#casebar-record").inner_text() == "記録", "ending it from inside deletes it and unlinks the case")
    page.keyboard.press("Escape")

    # 15. nothing of the record is kept in the browser's own storage
    store = page.evaluate("JSON.stringify([localStorage, sessionStorage])")
    check("腎前性AKI" not in store and "高血圧の管理" not in store and "21:52" not in store, "the record is not kept in localStorage / sessionStorage")

    # the browser logs a refused request as a console error: the 400 (identifier), 409 (another screen) and 404 (ended) above are on purpose
    expected = re.compile(r"Failed to load resource: the server responded with a status of (400|404|409)")
    bad = [l for l in logs if l[0] in ("error", "pageerror") and not expected.search(l[1])]
    check(not bad, f"no console errors other than the refusals this test causes ({bad[:3]})")
    br.close()

print(f"\n{len(passed)} passed, {len(fails)} failed")
sys.exit(1 if fails else 0)
