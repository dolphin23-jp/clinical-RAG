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
another screen refused (not overwritten), ending a record, and that nothing of it is kept in the browser's own storage.  Then the course
(steps 21-22): a day at a time, plans of an earlier day with no result recorded, a trend that is blank unless chosen, tasks, the notes as of
their day (nothing later in them), the interim summary (A07) with the turning points, and the discharge summary (A08) that exists only once
the doctor has decided the discharge and its day, with the medications as chosen and blanks left blank.
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
    policy = {"accept": True, "log": []}  # what a confirm() is answered with, and what it asked

    def on_dialog(d):
        policy["log"].append(d.message)
        d.accept() if policy["accept"] else d.dismiss()

    page.on("dialog", on_dialog)

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
    check(rows[3].startswith("+150分") and "Disposition決定" in rows[3] and "翌日" in rows[3] and "病着の前として読む" in rows[3], f"a time past midnight is read as the next day, says so, and can be read the other way ({rows[3]})")
    axis = page.locator(".rec-axis").inner_text()
    check(not re.search(r"遅|早い|基準|正常|異常です|警告", axis), "the axis judges nothing")
    check("遅い・早いの判定や、基準の時間との比較はしません" in rec_text(), "the screen says there is no judgement of time")
    page.screenshot(path=str(OUT / "01_axis.png"))

    # 5. the notes on what is blank: counted, named, not concluded
    ids = [c.get_attribute("data-id") for c in page.locator(".rec-check").all()]
    check(ids[:4] == ["core_missing", "waiting", "assumed_times", "undecided"] and "no_problems" in ids and "unfilled" in ids, f"checks: {ids}")
    check("仮の読み方をした時刻が 1 件" in page.locator(".rec-check[data-id=assumed_times]").inner_text(), "the time read by assumption is counted")
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
    pre = page.locator(".rec-note-text").first  # the admission note (the course note is the second)
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
    page.locator("#record button", has_text="コピー").first.click()
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

    # 16. review follow-ups: a double tap makes one record; the reading of an ambiguous time can be flipped and is kept
    page.click("#btn-records")
    page.wait_for_selector("text=保存した記録はありません")
    page.locator("#record button", has_text="いま固定している症例を記録にする").dblclick()
    page.wait_for_selector(".rec-title")
    page.wait_for_timeout(500)
    recs2 = api("GET", "/api/records")["body"]["records"]
    check(len(recs2) == 1, f"a double tap made one record ({len(recs2)})")
    rid2 = recs2[0]["id"]
    dispo = page.locator(".rec-axis-row[data-q=t_dispo]")
    dispo.locator("button.rec-reading").click()
    dispo = page.locator(".rec-axis-row[data-q=t_dispo]")
    check(dispo.locator(".rec-min").inner_text() == "-1290分" and "前として計算" in dispo.inner_text(), f"read the other way: before the arrival ({dispo.inner_text()})")
    wait_saved()
    check(api("GET", f"/api/records/{rid2}")["body"]["record"]["ed"]["reading"] == {"t_dispo": "before"}, "the doctor's reading is saved with the record")
    page.locator(".rec-axis-row[data-q=t_dispo] button.rec-reading").click()
    check(page.locator(".rec-axis-row[data-q=t_dispo] .rec-min").inner_text() == "+150分", "and can be flipped back")
    wait_saved()

    # 17. a save whose answer is lost is not taken for another screen's save
    adm = page.locator("textarea.rec-adm")
    state = {"n": 0}

    def lose_first_put(route):
        if route.request.method == "PUT" and state["n"] == 0:
            state["n"] += 1
            route.fetch()  # the Worker gets it and saves
            route.abort()  # but the page never sees the answer
        else:
            route.continue_()

    page.route("**/api/records/*", lose_first_put)
    adm.nth(0).fill("入院の経路: 救急から（1回目）")
    page.wait_for_timeout(2600)
    check("保存できませんでした" in page.locator("#record .rec-status").inner_text(), "the lost answer shows as not saved")
    adm.nth(0).fill("入院の経路: 救急から（2回目）")
    page.wait_for_timeout(3200)
    wait_saved()
    check("別の画面で更新されています" not in page.locator("#record").inner_text(), "the next save is not taken for another screen's (the server's copy was ours)")
    check(api("GET", f"/api/records/{rid2}")["body"]["record"]["adm"]["route"] == "入院の経路: 救急から（2回目）", "and the later text reached the server")
    page.unroute("**/api/records/*")

    # 18. leaving the record with something unsaved asks first
    page.route("**/api/records/*", lambda route: route.abort() if route.request.method == "PUT" else route.continue_())
    adm = page.locator("textarea.rec-adm")
    adm.nth(0).fill("保存できない間に書いた文")
    page.wait_for_timeout(2600)
    policy["log"].clear()
    policy["accept"] = False
    page.locator("#record button", has_text="記録の一覧").click()
    page.wait_for_timeout(500)
    check(any("保存されていない変更があります" in m for m in policy["log"]) and page.locator(".rec-problem, .rec-axis").count() >= 0 and page.locator("textarea.rec-adm").count() == 5, "leaving with unsaved text asks, and cancel stays in the record")
    check(adm.nth(0).input_value() == "保存できない間に書いた文", "nothing was dropped")
    page.unroute("**/api/records/*")
    policy["accept"] = True
    page.wait_for_timeout(300)
    adm.nth(0).fill("保存できない間に書いた文（もう一度）")
    page.wait_for_timeout(2600)
    wait_saved()
    page.keyboard.press("Escape")

    # 19. pinning a case with another age or sex asks whether it is the same patient; cancel lets the record go (and keeps it saved)
    page.click("#casebar-record")
    check(page.locator("#case-linked").count() == 1, "the case dialog carries the linked notice")
    page.keyboard.press("Escape")
    page.click("#btn-case")
    check(page.locator("#case-linked").is_visible() and "別の患者の症例を入れるときは、先に「症例を外す」" in page.locator("#case-linked").inner_text(), "the case dialog says it is linked and what to do for another patient")
    page.select_option("#case-age", "30代")
    policy["log"].clear()
    policy["accept"] = False
    page.click("#case-pin")
    page.wait_for_timeout(800)
    check(any("年代・性別が、この記録の症例と違います" in m for m in policy["log"]), "a different age asks whether it is the same patient")
    check(page.locator("#casebar-record").inner_text() == "記録", "cancel: the record is let go (the case stays pinned on its own)")
    check(api("GET", f"/api/records/{rid2}")["body"]["record"]["ed"]["case"]["age"] == "70代", "and the record still holds the 70代 case")
    policy["accept"] = True

    # 20. opening a record while another patient's thread is on screen starts a new conversation (after asking); cancel changes nothing
    turns_before = page.locator(".turn").count()
    page.click("#btn-records")
    page.wait_for_selector(".rec-item")
    policy["log"].clear()
    policy["accept"] = False
    page.locator(".rec-item button", has_text="開く").first.click()
    page.wait_for_timeout(500)
    check(any("いまの会話を閉じて新しい会話を始めます" in m for m in policy["log"]) and page.locator(".turn").count() == turns_before and not page.locator(".rec-problem, .rec-axis").count(), "with another case's thread on screen, opening asks; cancel changes nothing")
    policy["accept"] = True
    page.locator(".rec-item button", has_text="開く").first.click()
    page.wait_for_selector(".rec-axis")
    check(page.locator(".turn").count() == 0, "accepted: the thread is closed (a new conversation), so nothing of the other case rides along")
    check("70代・男性・救急" in page.locator("#casebar-text").inner_text() and page.locator("#casebar-record").inner_text() == "記録（連動中）", "and the record's case is pinned and linked")
    page.keyboard.press("Escape")
    page.click("#case-modes button[data-mode=ddx]")
    wait_done(1)
    first_conv = api("GET", "/api/conversations")["body"]["conversations"]
    check(len(first_conv) >= 2, f"the new question is saved in a new conversation ({len(first_conv)} conversations)")
    api("DELETE", f"/api/records/{rid2}")

    # 21. the course: a day at a time; plans of an earlier day with no result are counted; a trend is blank unless chosen; as of the day
    page.click("#btn-new")
    page.wait_for_timeout(600)
    page.click("#btn-case")
    page.fill("#case-complaint", "3日前から腹痛と嘔気")
    page.select_option("#case-age", "70代")
    page.select_option("#case-sex", "男性")
    page.click("#case-pin")
    page.click("#btn-records")
    page.wait_for_selector("text=いま固定している症例を記録にする")
    page.locator("#record button", has_text="いま固定している症例を記録にする").click()
    page.wait_for_selector(".rec-title")
    page.locator("button", has_text="＋ 問題を足す").click()
    page.locator(".rec-problem").first.locator("input.rec-label").fill("腎前性AKI")
    page.locator(".rec-problem").first.locator(".rec-cert .chip[data-opt=suspected]").click()
    page.locator(".rec-problem").first.locator("button", has_text="＋ 計画を足す").click()
    page.locator(".rec-problem").first.locator(".rec-entry textarea").first.fill("細胞外液の輸液を検討")
    page.locator(".rec-problem").first.locator("button", has_text="＋ 計画を足す").click()
    page.locator(".rec-problem").first.locator(".rec-entry").nth(1).locator("textarea").fill("内服薬を見直す")
    wait_saved()
    check("いまの日: 入院1日目" in rec_text() and "前の日までに立てた計画で、結果を記録していないもの（予定のまま）はありません" in rec_text(), "day 1: nothing earlier to report on")
    check(not page.locator(".rec-check[data-id=plan_unrecorded]").count(), "and no 'plans not recorded' note")
    a05 = page.locator(".rec-note-text").first.inner_text()
    check("（疑い）" in a05, "the admission note shows the certainty of day 1")

    page.locator("button[data-act=next-day]").click()
    check("いまの日: 入院2日目" in rec_text(), "the next day starts")
    outcome = page.locator(".rec-outcome")
    check(outcome.count() == 2 and "入院1日目に予定" in outcome.first.inner_text(), "the two plans of day 1 are listed, still planned")
    note = page.locator(".rec-check[data-id=plan_unrecorded]").inner_text()
    check("実施・変更・中止のどれも記録していないものが 2 件（予定のまま）" in note, f"counted, not judged ({note})")
    outcome.first.locator("input.rec-reason").fill("開始した")
    outcome.first.locator(".chip[data-opt=done]").click()
    check(page.locator(".rec-outcome").count() == 1, "a plan with a result leaves the list")
    page.locator(".rec-outcome").first.locator(".chip[data-opt=changed]").click()
    check(not page.locator(".rec-outcome").count() and "変更・中止の理由を書いていない計画が 1 件" in page.locator(".rec-check[data-id=plan_reason]").inner_text(), "a change with no reason is counted")

    page.locator("textarea.rec-day-text[data-key=interval]").fill("夜間に38℃台の発熱があった")
    page.locator("textarea.rec-day-text[data-key=objective]").fill("BT 38.4℃、Cr 2.1 mg/dL（入院時 2.4）")
    page.locator("textarea.rec-day-text[data-key=handover]").fill("明朝の採血で Cr を確認する")
    progress = page.locator(".rec-progress-text")
    check("入院2日目。" not in progress.inner_text() or "入院2日目" in progress.inner_text(), "(the note follows the working day)")
    check(not re.search(r"推移（入院", progress.inner_text()) and "不変" not in progress.inner_text(), "no trend chosen yet: the note has no 推移 line (not 不変)")
    check("入院2日目の推移（改善・不変・悪化）を選んでいない問題が 1 件（選ばなければ「未評価」です）" in page.locator(".rec-check[data-id=trend_missing]").inner_text(), "the unchosen trend is counted, as 未評価")
    page.locator(".rec-trend .chip[data-opt=improved]").click()
    page.locator(".rec-trend input.rec-reason").fill("尿量が増えた")
    check(not page.locator(".rec-check[data-id=trend_missing]").count(), "chosen: no longer counted")
    progress = page.locator(".rec-progress-text")
    check("推移（入院2日目）: 改善 — 尿量が増えた" in progress.inner_text(), "the chosen trend and its note are in the note")
    check("実施（医師の記録）:\n・細胞外液の輸液を検討（理由: 開始した）" in progress.inner_text() and "変更（医師の記録）:\n・内服薬を見直す" in progress.inner_text(), "the plan outcomes the doctor recorded are in it, under their own headings")

    page.locator("button", has_text="＋ 課題を足す").click()
    task = page.locator(".rec-task").first
    task.locator("textarea").fill("血液培養の結果")
    check("未完了の課題が 1 件" in page.locator(".rec-check[data-id=tasks_open]").inner_text() and "担当者または期限が未入力の課題が 1 件" in page.locator(".rec-check[data-id=tasks_incomplete]").inner_text(), "an open task without an owner or a due is counted")
    task.locator("input[aria-label=担当者]").fill("当直医")
    task.locator("input[aria-label=期限]").fill("入院3日目")
    check(not page.locator(".rec-check[data-id=tasks_incomplete]").count(), "owner and due given: not counted any more")
    task.locator("button[data-act=task-state]").click()
    check(not page.locator(".rec-check[data-id=tasks_open]").count() and "完了（入院2日目）" in page.locator(".rec-task").first.inner_text(), "closing is the doctor's act and stamps the day")
    wait_saved()

    # as of the day: a certainty changed on day 3 is not in day 2's notes, nor in the admission note
    page.locator("button[data-act=next-day]").click()
    check("いまの日: 入院3日目" in rec_text(), "day 3")
    page.locator(".rec-problem").first.locator(".rec-cert .chip[data-opt=confirmed]").click()
    wait_saved()
    sel = page.locator("select.rec-noteday")
    sel.select_option("2")
    t2 = page.locator(".rec-progress-text").inner_text()
    check("（疑い）" in t2 and "確定" not in t2 and "推移（入院2日目）: 改善" in t2, "the note of day 2 shows day 2's certainty, not the one set on day 3")
    sel.select_option("3")
    t3 = page.locator(".rec-progress-text").inner_text()
    check("（確定）" in t3 and "推移（入院2日目）: 改善" in t3, "the note of day 3 shows the later certainty, and the latest trend with its own day")
    check("（疑い）" in page.locator(".rec-note-text").first.inner_text() and "確定" not in page.locator(".rec-note-text").first.inner_text(), "and the admission note still shows the admission day's certainty")
    page.screenshot(path=str(OUT / "05_course.png"))

    # a date typed in a day text and never left is relative when saved
    page.locator("textarea.rec-day-text[data-key=interval]").fill("10/21 に熱が下がり、受診から 2026年10月22日 まで安定")
    page.wait_for_timeout(2600)
    wait_saved()
    rid3 = api("GET", "/api/records")["body"]["records"][0]["id"]
    saved = api("GET", f"/api/records/{rid3}")["body"]["record"]
    d3 = [d for d in saved["course"]["days"] if d["day"] == 3][0]
    check("10/21" not in d3["interval"] and "2026" not in d3["interval"], f"no calendar date in the day text ({d3['interval']})")
    d2 = [d for d in saved["course"]["days"] if d["day"] == 2][0]
    check(d2["trend"]["p1"] == {"state": "improved", "note": "尿量が増えた"} and saved["course"]["tasks"][0]["state"] == "done" and saved["course"]["tasks"][0]["closed"] == 2, "the trend and the closed task are on the server")
    p1 = saved["problems"][0]
    check([c["certainty"] for c in p1["cert_log"]] == ["suspected", "confirmed"] and [c["day"] for c in p1["cert_log"]] == [1, 3], f"the certainty has its history ({p1['cert_log']})")
    check(p1["plan"][0]["log"][0] == {"day": 2, "state": "done", "reason": "開始した"}, "and so has the plan's state")
    check(saved["course"]["today"] == 3, "the working day is saved")
    api("DELETE", f"/api/records/{rid3}")

    # 22. the interim summary (A07) and the discharge summary (A08): as of their day; a discharge only once decided; blanks stay blank
    page.keyboard.press("Escape")
    page.click("#btn-new")
    page.wait_for_timeout(600)
    page.click("#btn-case")
    page.fill("#case-complaint", "3日前から腹痛と嘔気")
    page.select_option("#case-age", "70代")
    page.select_option("#case-sex", "男性")
    page.click("#case-pin")
    page.click("#btn-records")
    page.wait_for_selector("text=いま固定している症例を記録にする")
    page.locator("#record button", has_text="いま固定している症例を記録にする").click()
    page.wait_for_selector(".rec-title")
    page.locator("button", has_text="＋ 問題を足す").click()
    page.locator(".rec-problem").first.locator("input.rec-label").fill("腎前性AKI")
    page.locator(".rec-problem").first.locator(".rec-cert .chip[data-opt=suspected]").click()
    page.locator(".rec-problem").first.locator("button", has_text="＋ 計画を足す").click()
    page.locator(".rec-problem").first.locator(".rec-entry textarea").first.fill("細胞外液の輸液を検討")
    wait_saved()
    page.locator("button[data-act=next-day]").click()
    check("いまの日: 入院2日目" in rec_text(), "(day 2)")
    page.locator("textarea.rec-day-text[data-key=interval]").fill("夜間に38℃台の発熱があった")
    page.locator("input[data-act=turning]").check()
    check(page.locator(".rec-days .chip[data-day='2']").inner_text() == "2日目★", "marking a turning point shows on the day's chip")
    page.locator(".rec-trend .chip[data-opt=worse]").click()
    page.locator(".rec-trend input.rec-reason").fill("尿量低下")
    page.locator("button[data-act=next-day]").click()
    check("いまの日: 入院3日目" in rec_text(), "(day 3)")
    page.locator(".rec-problem").first.locator(".rec-cert .chip[data-opt=confirmed]").click()
    page.locator(".rec-problem").first.locator(".rec-dx .chip[data-opt=main]").click()
    check(page.locator(".rec-problem").first.locator(".rec-dx .chip[data-opt=main]").get_attribute("aria-pressed") == "true", "the main diagnosis is the doctor's choice")
    page.locator("button", has_text="＋ 問題を足す").click()
    page.locator(".rec-problem").nth(1).locator("input.rec-label").fill("尿路感染症")
    page.locator(".rec-problem").nth(1).locator(".rec-dx .chip[data-opt=sub]").click()
    wait_saved()

    # the interim summary
    page.locator("details.rec-sec summary", has_text="中間サマリー・転棟（A07）").click()
    check(page.locator("details.rec-sec", has_text="中間サマリー・転棟（A07）").first.get_attribute("open") is not None, "the section opens")
    page.locator("textarea.rec-sum-text[data-key=context]").fill("一般病棟へ転棟")
    interim = page.locator(".rec-interim-text")
    check("※入院3日目の時点の記録です" in interim.inner_text(), "the working day is the default day, and the note says what it is as of")
    check("一般病棟へ転棟" in interim.inner_text() and "入院2日目:\n・前回からのイベント: 夜間に38℃台の発熱があった\n・推移 腎前性AKI: 悪化 — 尿量低下" in interim.inner_text(), "the turning day's record is in the course")
    for blank in ("現時点の呼吸・循環・意識等", "継続治療・デバイス", "結果待ち・未解決事項", "引継ぎ先・依頼・共有の状況"):
        check(re.search(r"■" + blank + r"\n（未入力）", interim.inner_text()) is not None, f"{blank}: left blank")
    check("（確定）" in interim.inner_text() and "尿路感染症" not in interim.inner_text(), "the certainty of the day; a problem with nothing recorded is not listed")
    page.locator("select.rec-sumday").select_option("2")
    i2 = page.locator(".rec-interim-text").inner_text()
    check("※入院2日目の時点の記録です" in i2 and "（疑い）" in i2 and "確定" not in i2, "as of day 2: the certainty set on day 3 is not in it")
    page.locator("select.rec-sumday").select_option("3")
    # a closed section stays closed, an open one stays open when the screen is drawn again
    page.locator("button", has_text="＋ 課題を足す").click()
    check(page.locator("details.rec-sec", has_text="中間サマリー・転棟（A07）").first.get_attribute("open") is not None, "an opened section stays open after a redraw")
    check(page.locator(".rec-task").first.locator("select").first.input_value() == "", "a new task has no kind chosen (it is not 結果待ち unless the doctor says so)")
    page.locator(".rec-task").first.locator("textarea").fill("培養の確認")
    check("・培養の確認（担当: 未入力／期限: 未入力）" in page.locator(".rec-interim-text").inner_text() and "結果待ち:" not in page.locator(".rec-interim-text").inner_text(), "so it is printed with no kind, and with owner and due as not entered")

    # the discharge summary
    page.locator("details.rec-sec summary", has_text="退院時サマリー（A08）").click()
    dc = page.locator(".rec-discharge-text")
    check("退院を決めて、退院の日を入れると" in dc.inner_text() and page.locator("details.rec-sec", has_text="退院時サマリー（A08）").locator(".rec-note-text ~ .btn-row button").is_disabled(), "no discharge yet: no draft, and nothing to copy")
    page.locator("textarea.rec-dc-text[data-key=dest]").fill("自宅")
    page.locator("textarea.rec-dc-text[data-key=state]").fill("歩行可能。食事摂取可")
    check("退院を決めて、退院の日を入れると" in page.locator(".rec-discharge-text").inner_text(), "texts alone are not a discharge")
    page.locator("details.rec-sec", has_text="退院時サマリー（A08）").locator("button", has_text="＋ 処方を足す").click()
    page.locator(".rec-med").nth(0).locator("textarea").fill("薬A")
    page.locator(".rec-med").nth(0).locator(".chip[data-opt=stopped]").click()
    page.locator("details.rec-sec", has_text="退院時サマリー（A08）").locator("button", has_text="＋ 処方を足す").click()
    page.locator(".rec-med").nth(1).locator("textarea").fill("薬B")
    check("変更・中止の理由を書いていない退院時の処方が 1 件" in page.locator(".rec-check[data-id=meds_reason]").inner_text() and "選ばなければ「未記入」です" in page.locator(".rec-check[data-id=meds_unset]").inner_text(), "medications with no reason / no class are counted, not judged")
    page.locator("button[data-act=discharge-decide]").click()
    check("退院を決めた（入院3日目）" in page.locator("button[data-act=discharge-decide]").inner_text(), "deciding stamps the working day")
    d = page.locator(".rec-discharge-text").inner_text()
    check(d.startswith("【退院時サマリ】下書き") and "入院1日目に入院、入院3日目に退院" in d and "※入院3日目の時点の記録です" in d, "the draft exists once decided, as of the discharge day")
    check("主病名:\n1. 腎前性AKI（確度: 確定）" in d and "副病名:\n1. 尿路感染症（確度: 未選択）" in d, "the diagnoses are the ones the doctor classed; a certainty not chosen is shown as not chosen")
    check("・薬A — 中止（理由: 未入力）" in d and "・薬B — 区分未記入" in d, "the medications: what was chosen, and what was not")
    check(re.search(r"■外来・在宅の方針\n（未入力）", d) is not None and "歩行可能。食事摂取可" in d, "a blank stays blank; the doctor's words are as written")
    check(not page.locator("details.rec-sec", has_text="退院時サマリー（A08）").locator(".rec-note-text ~ .btn-row button").is_disabled(), "copy is available once there is a draft")
    page.locator(".rec-med").nth(0).locator("input.rec-reason").fill("副作用のため")
    check("・薬A — 中止（理由: 副作用のため）" in page.locator(".rec-discharge-text").inner_text() and not page.locator(".rec-check[data-id=meds_reason]").count(), "the reason is in the draft and no longer counted")
    # an earlier discharge day: what was recorded later is not in it
    page.locator("input.rec-dc-day").fill("2")
    page.locator("input.rec-dc-day").dispatch_event("change")
    d2 = page.locator(".rec-discharge-text").inner_text()
    check("入院2日目に退院" in d2 and "（確度: 疑い）" in d2 and "確定" not in d2 and "尿路感染症" not in d2, "discharge on day 2: the later certainty and the later problem are not in it")
    page.locator("button[data-act=discharge-decide]").click()
    check("退院を決めて、退院の日を入れると" in page.locator(".rec-discharge-text").inner_text(), "taking the decision back removes the draft")
    page.locator("input.rec-dc-day").fill("999")
    page.locator("input.rec-dc-day").dispatch_event("change")
    check("退院の日は、1〜365 の整数" in rec_text() and "退院を決める（" in page.locator("button[data-act=discharge-decide]").inner_text(), "a day that is not a day is said so, and no discharge is decided")
    page.locator("input.rec-dc-day").fill("3")
    page.locator("input.rec-dc-day").dispatch_event("change")
    page.locator("button[data-act=discharge-decide]").click()
    wait_saved()
    page.screenshot(path=str(OUT / "06_discharge.png"))
    rid4 = api("GET", "/api/records")["body"]["records"][0]["id"]
    saved = api("GET", f"/api/records/{rid4}")["body"]["record"]
    sc = saved["course"]
    check(sc["discharge"]["decided"] is True and sc["discharge"]["day"] == 3 and sc["discharge"]["dest"] == "自宅" and sc["summary"]["context"] == "一般病棟へ転棟", "the decision, its day and the doctor's texts are on the server")
    check([(m["id"], m["text"], m["change"]) for m in sc["discharge"]["meds"]] == [("m1", "薬A", "stopped"), ("m2", "薬B", "")], "the medications keep their ids and a blank class stays blank")
    check(sc["days"][0]["day"] == 2 and sc["days"][0]["turning"] is True and [p.get("dx") for p in saved["problems"]] == ["main", "sub"], "the turning mark and the classes are on the server")
    check(not re.search(r"\d{4}-\d{2}-\d{2}|\d{4}年|\d{1,2}月\d{1,2}日", json.dumps(saved, ensure_ascii=False)), "no calendar date in the saved record")
    # a fresh page restores it
    page.reload()
    page.wait_for_function("() => document.querySelector('#chip-books').textContent.includes('(1)')")
    page.click("#btn-records")
    page.wait_for_selector(".rec-item")
    page.locator(".rec-item button", has_text="開く").first.click()
    page.wait_for_selector(".rec-title")
    page.locator("details.rec-sec summary", has_text="退院時サマリー（A08）").click()
    check("退院を決めた（入院3日目）" in page.locator("button[data-act=discharge-decide]").inner_text() and "入院3日目に退院" in page.locator(".rec-discharge-text").inner_text(), "read back on a fresh page: the discharge is restored")
    api("DELETE", f"/api/records/{rid4}")

    # 15. nothing of the record is kept in the browser's own storage
    store = page.evaluate("JSON.stringify([localStorage, sessionStorage])")
    check("腎前性AKI" not in store and "高血圧の管理" not in store and "21:52" not in store, "the record is not kept in localStorage / sessionStorage")

    # the browser logs a refused request as a console error: the 400 (identifier), 409 (another screen) and 404 (ended) above are on purpose
    # (and the requests this test aborts itself to lose an answer or go offline)
    expected = re.compile(r"Failed to load resource: (the server responded with a status of (400|404|409)|net::ERR_FAILED)")
    bad = [l for l in logs if l[0] in ("error", "pageerror") and not expected.search(l[1])]
    check(not bad, f"no console errors other than the refusals this test causes ({bad[:3]})")
    br.close()

print(f"\n{len(passed)} passed, {len(fails)} failed")
sys.exit(1 if fails else 0)
