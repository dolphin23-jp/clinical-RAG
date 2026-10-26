"""Browser test of the simulation of a fictional case (docs/enhancement-plan.md 8.21, step 1b) against worker/test/devserver.ts on the
synthetic fixture (iPad width).  The setting is tests/e2e/sim_fixture.json, a test-only setting on the shock flow of the imported schema
(not a clinical case, not used for training).  The screen sends nothing and keeps nothing: the test watches the network and the storage.

  python3 -m ingest build --db /tmp/fx.sqlite fx tests/fixtures/synthetic_ch.md
  node --no-warnings worker/test/devserver.ts /tmp/fx.sqlite 8787 &
  python3 tests/e2e/ui_sim.py http://localhost:8787 OUT_DIR
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8787"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/ui_sim")
OUT.mkdir(parents=True, exist_ok=True)
TOKEN = "test-token-0123456789abcdef"
SETTING = json.loads((Path(__file__).parent / "sim_fixture.json").read_text(encoding="utf-8"))["setting"]
HEADER = "【架空症例（模擬）・実在の患者ではありません】"
NO_DATA = "その項目は、この症例に設定がありません（未確認のまま。陰性ではありません）。"
passed, fails = [], []


def check(cond, msg):
    (passed if cond else fails).append(msg)
    print(("PASS " if cond else "FAIL ") + msg, flush=True)


# every write to the browser's storage, by the page, recorded before the app runs
WATCH_STORAGE = """
window.__sets = [];
for (const name of ['setItem', 'removeItem', 'clear']) {
  const orig = Storage.prototype[name];
  Storage.prototype[name] = function (...a) { window.__sets.push([this === window.sessionStorage ? 'session' : 'local', name, String(a[0] ?? ''), String(a[1] ?? '')]); return orig.apply(this, a); };
}
"""

with sync_playwright() as pw:
    br = pw.chromium.launch()
    ctx = br.new_context(viewport={"width": 820, "height": 1180}, device_scale_factor=2, has_touch=True, is_mobile=True, locale="ja-JP")
    ctx.add_init_script(WATCH_STORAGE)
    page = ctx.new_page()
    logs, requests = [], []
    page.on("console", lambda m: logs.append((m.type, m.text)) if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
    page.on("request", lambda r: requests.append((r.method, r.url)))
    answer_confirm = {"v": True}
    confirms = []

    def on_dialog(d):
        confirms.append(d.message)
        d.accept() if answer_confirm["v"] else d.dismiss()

    page.on("dialog", on_dialog)
    page.goto(BASE + "/")
    page.evaluate(f"localStorage.setItem('mb.token','{TOKEN}')")
    page.reload()
    page.wait_for_function("() => document.querySelector('#chip-books').textContent.includes('(1)')")
    page.wait_for_timeout(300)

    sets_before = page.evaluate("window.__sets.length")
    req_before = len(requests)
    dlg = page.locator("#sim")
    memo = page.locator("#sim-memo")
    note = page.locator("#sim-note")

    def open_sec(sel):
        d = page.locator(sel)
        if d.get_attribute("open") is None:
            d.locator("summary").first.click()

    def ask(q):
        page.click(f"#sim [data-q='{q}'].chip")

    def shows(text, timeout=5000):
        try:
            expect(dlg).to_contain_text(text, timeout=timeout)
            return True
        except AssertionError:
            return False

    def paste(text):
        open_sec("#sim-paste-sec")
        page.fill("#sim-paste", text)
        page.click("#sim-load")

    def memo_text():
        return memo.inner_text()

    def note_text():
        return note.text_content()

    # 1. the entrance and the dialog
    page.click("#btn-case")
    check(page.locator("#case-sim").is_visible(), "the case dialog offers the simulation (試作)")
    page.click("#case-sim")
    expect(dlg).to_be_visible()
    check(dlg.locator(".band").is_visible(), "the band is shown in the simulation dialog")
    check(not page.locator("#case").evaluate("d => d.open"), "the case dialog closes when the simulation opens")
    check("AI が、テーマ（病名・症候）と難しさから" in dlg.inner_text(), "the load view says the AI writes the setting from a theme")
    check("保存しません" in dlg.inner_text() and "実在の患者の情報は入れません" in dlg.inner_text(), "the load view says nothing is saved and no real patient goes in")

    # 2. a setting that does not parse, one that fails the check, and the valid one
    paste("{ not json")
    check(shows("JSON として読めません"), "a setting that is not JSON is refused")
    bad = json.loads(json.dumps(SETTING))
    bad["states"][0]["facts"][1]["v"] = "0312345678"  # not a number: the check refuses the setting
    paste(json.dumps(bad, ensure_ascii=False))
    check(shows("設定が検査を通りません") and page.locator(".sim-errors li").count() >= 1, "a setting that fails the check is refused with the reasons")
    other = dict(SETTING, flow="no.such.flow")
    paste(json.dumps(other, ensure_ascii=False))
    check(shows("取り込んだフローにありません"), "a setting of an unknown flow is refused")
    page.select_option("#sim-minutes", "10")
    paste(json.dumps(SETTING, ensure_ascii=False))
    expect(page.locator("#sim-mark")).to_be_visible()
    check("架空症例（模擬）" in page.locator("#sim-mark").inner_text() and "医師未確認" in page.locator("#sim-mark").inner_text(), "the mark of a fictional case and the source of the setting are shown")
    head = dlg.locator(".sim-head").inner_text()
    check("68歳" in head and "02:10" in head and "区切り 0" in head, "the head shows the age, the shown clock and the segment")
    check("試験用の導入文" in head, "the opening is shown")
    check(SETTING["assumed"]["dx"][0] not in dlg.inner_text() and SETTING["assumed"]["pitfall"] not in dlg.inner_text(), "the hidden assumption is not on the play screen")
    page.screenshot(path=str(OUT / "sim_start.png"), full_page=True)

    # 3. what can be asked: facts only; readings, decisions and results not yet ordered are not offered
    chips = set(page.locator("#sim .sim-asks .chip").evaluate_all("bs => bs.map(b => b.dataset.q)"))
    check({"rr", "spo2", "limbs", "mods", "usual_vs"} <= chips, "fact questions are offered as chips")
    check(not ({"first", "fluid_resp", "re_change", "rr_cat", "shock_judge"} & chips), "readings and the doctor's decisions are not offered to ask")
    check(not ({"lactate", "vbg_res"} & chips), "a result is not offered before it is ordered and back")
    check(not ({"age", "sex", "t_arrival", "tests", "fluid", "dispo"} & chips), "age, sex, times, acts and the disposition are not asked of the case")
    page.fill("#sim-filter", "呼吸数")
    vis = page.locator("#sim .sim-asks .chip").evaluate_all("bs => bs.map(b => b.dataset.q)")
    check(vis == ["rr"], f"the filter narrows the chips by the name ({vis})")
    page.fill("#sim-filter", "")

    # 4. asking: the case answers in a sentence; nothing goes in the note until the doctor takes it
    note0 = note_text()
    check(note0.startswith(HEADER), "the note starts with the fictional header")
    ask("rr")
    ask("spo2")
    ask("limbs")
    m = memo_text()
    check("看護師: 呼吸数は、30 回/分。" in m and "SpO2は、92 %。" in m, "asked items are answered in the memo with who told it")
    check("02:10" in m, "the memo shows the clock")
    check("92" not in note_text() and note_text() == note0, "an answer is not in the note until it is taken in")
    tray = page.locator("#sim-tray")
    check(tray.locator("input[type=checkbox]:checked").count() == 0, "nothing in the tray is preselected")
    ask("usual_vs")
    check(NO_DATA in memo_text(), "an item the setting does not hold answers 'no setting' (not a negative)")
    check(tray.locator("[data-row$=':usual_vs']").count() == 0, "a 'no setting' answer makes no tray row")
    ask("mods")
    mods_row = tray.locator("[data-row$=':mods']")
    check(mods_row.count() == 1 and "1件ずつ確かめる" in mods_row.inner_text() and mods_row.locator("input[type=checkbox]").count() == 0, "an unknown/negative answer is a careful row, taken one at a time (no checkbox)")

    # take spo2 and rr (checkboxes), leave limbs
    tray.locator("[data-row$=':spo2'] input[type=checkbox]").check()
    tray.locator("[data-row$=':rr'] input[type=checkbox]").check()
    page.click("#sim-take")
    n1 = note_text()
    check("92" in n1 and "30" in n1, "the taken answers appear in the note")
    check(tray.locator("[data-row$=':spo2']").count() == 0 and tray.locator("[data-row$=':limbs']").count() == 1, "taken rows leave the tray; the others stay")
    mods_row.locator("button", has_text="入れる").click()
    check(tray.locator("[data-row$=':mods']").count() == 0, "the careful row goes in only by its own button")

    # 5. an order returns at the next boundary; a treatment changes the course
    open_sec("#sim-board")
    page.click("#sim-board [data-key='tests=vbg']")
    check("結果待ち" in dlg.inner_text(), "an ordered test waits for the next boundary")
    check(page.locator("#sim .sim-asks .chip[data-q='lactate']").count() == 0, "the result is not askable while it waits")
    check("記録: オーダーした検査" in memo_text(), "the act is in the memo")
    page.click("#sim-wait")
    m = memo_text()
    check("02:20" in m and "待つ" in m, "waiting moves the shown clock by one segment")
    check("乳酸（記録するだけ）は、4.2 mmol/L。" in m, "the result comes back at the boundary")
    check(page.locator("#sim .sim-asks .chip[data-q='lactate']").count() == 1, "a result can be asked again once it is back")
    check("試験用の出来事" not in m, "without the treatment, waiting alone does not take the move that needs it")
    open_sec("#sim-board")
    page.click("#sim-board [data-key='fluid=given']")
    page.click("#sim-wait")
    m = memo_text()
    check("試験用の出来事: 呼吸が落ち着いてきました。" in m, "the move that needs the treatment is taken at the next boundary, with its event")
    check("呼びかけへの反応が鈍く" not in m, "the other branch is not taken")
    ask("rr")
    m = memo_text()
    check("呼吸数は、24 回/分。" in m and "呼吸数は、30 回/分。" in m, "asking again answers with the state now and keeps the earlier record")
    rr_rows = tray.locator("[data-row$=':rr']")
    check(rr_rows.count() == 1 and "上書きしません" in rr_rows.inner_text(), "a new value of an item already taken is not overwritten")
    check("30" in note_text() and "24 回/分" not in note_text(), "the note keeps the doctor's taken answer")
    rr_rows.locator("button", has_text="片付ける").click()
    check(tray.locator("[data-row$=':rr']").count() == 0, "the filled row can be put away")

    # 6. the stages: forward only, each a boundary
    page.click("#sim-next")
    check("精査" in dlg.locator(".sim-clock").inner_text() or "段:" in dlg.locator(".sim-clock").inner_text(), "the next stage is entered")
    check("区切り 3" in dlg.locator(".sim-clock").inner_text(), "entering a stage is a boundary")

    # 7. what the doctor says, in the doctor's words; identifiers are not kept
    open_sec("#sim .sim-sec:has(#sim-say)")
    page.select_option("#sim-say-type", "disposition")
    page.fill("#sim-say", "ID 12345678 の人をICUへ")
    page.click("#sim-say-add")
    check("識別情報らしき文字" in dlg.inner_text() and "12345678" not in memo_text(), "an identifier-like text is not recorded")
    page.fill("#sim-say", "ICUへ入院とする")
    page.click("#sim-say-add")
    check("先生: 行き先: ICUへ入院とする" in memo_text(), "the disposition is recorded in the doctor's words")

    # 8. the doctor's own readings and assessment go in the note; the copy carries the header
    open_sec("#sim-mine")
    sj = page.locator("#sim-mine [data-q='shock_judge'] select")
    check(sj.count() == 1, "the doctor's decision is a control of its own (not asked of the case)")
    sj.select_option("shock")
    open_sec("#sim .sim-sec:has(#sim-own)")
    page.fill("#sim-own", "試験用のアセスメント")
    page.locator("#sim-own").dispatch_event("change")
    n2 = note_text()
    check(n2.startswith(HEADER) and "試験用のアセスメント" in n2, "the own assessment is in the note under the header")
    check(SETTING["assumed"]["dx"][0] not in n2, "the hidden assumption is not in the note")
    page.evaluate("window.__copied = ''; navigator.clipboard.writeText = async (t) => { window.__copied = t; }")
    open_sec("#sim .sim-sec:has(#sim-note)")
    page.locator("#sim .sim-sec:has(#sim-note) button", has_text="コピー").click()
    page.wait_for_function("() => window.__copied.length > 0")
    copied = page.evaluate("window.__copied")
    check(copied.startswith(HEADER), "the copied note starts with the fictional header")
    page.screenshot(path=str(OUT / "sim_play.png"), full_page=True)

    # 9. the debrief: a confirmation first; side by side, nothing judged
    answer_confirm["v"] = False
    page.click("#sim-debrief")
    check(page.locator("#sim-assumed").count() == 0 and len(confirms) == 1, "declining the confirmation keeps the play screen")
    answer_confirm["v"] = True
    page.click("#sim-debrief")
    expect(page.locator("#sim-assumed")).to_be_visible()
    t = dlg.inner_text()
    check("試験用の想定診断" in t and "作成者の想定・医師未確認" in t, "the debrief shows the assumption as the author's, not checked")
    check("四肢の温度: 行き先を記録する前に聞いた" in page.locator("#sim-key").inner_text(), "the key item is laid by when it was asked")
    check("正解" not in t and "点" not in t.replace("点数や正誤は付けません", "").replace("所見", ""), "the debrief does not say 正解 or give a score")
    page.screenshot(path=str(OUT / "sim_debrief.png"), full_page=True)
    page.locator("#sim button", has_text="同じ設定で最初から").click()
    check("区切り 0" in dlg.locator(".sim-clock").inner_text() and "呼吸数は" not in memo_text(), "the same setting can be played again from the start")

    # 10. nothing went over the network, nothing went into the browser's storage
    sent = [u for _, u in requests[req_before:] if "/api/" in u]
    check(not sent, f"the simulation sends nothing to the API ({sent[:3]})")
    sets = page.evaluate("window.__sets").__getitem__(slice(sets_before, None))
    check(not sets, f"the simulation writes nothing to the browser's storage ({sets[:3]})")
    stored = page.evaluate("JSON.stringify({...localStorage}) + JSON.stringify({...sessionStorage})")
    check("試験用" not in stored and "ICUへ入院" not in stored, "nothing of the case is in the browser's storage")
    # 11. the AI writes the setting and what happens next (step 2; the doctor's decision D4 c).  The dev server's fake answers.
    sim_posts = []
    page.on("request", lambda r: sim_posts.append(json.loads(r.post_data)) if r.url.endswith("/api/sim") and r.method == "POST" else None)
    req_ai = len(requests)
    page.locator("#sim button", has_text="別の設定にする").click()
    expect(page.locator("#sim-author")).to_be_visible()
    page.wait_for_function("() => document.querySelectorAll('#sim-flow option').length >= 10")
    check(page.locator("#sim-flow option").count() == 12, "the emergency flows can be simulated")
    page.select_option("#sim-flow", "emergency-department.shock")
    page.fill("#sim-theme", "患者ID 12345678")
    page.click("#sim-author")
    check(shows("識別情報らしき文字") and not sim_posts, "an identifier in the theme is not sent")
    page.fill("#sim-theme", "試験のテーマ __leak__")
    page.select_option("#sim-level", "難")
    page.click("#sim-author")
    expect(page.locator("#sim-mark")).to_be_visible(timeout=15000)
    check(sim_posts[0]["op"] == "author" and sim_posts[0]["level"] == "難" and sim_posts[0]["flow"] == "emergency-department.shock", "the request carries the flow, the theme and the difficulty")
    check(set(sim_posts[0]) <= {"op", "flow", "schema", "theme", "level"}, f"nothing else goes with the request ({sorted(sim_posts[0])})")
    check(len(sim_posts) == 2 and bool(sim_posts[1].get("repair")) and any(e["code"] == "leak_dx" for e in sim_posts[1]["repair"]["errors"]), "a setting that fails the screen's check is sent back once, with the errors")
    check("AI（書籍を根拠に作成・医師未確認）" in page.locator("#sim-mark").inner_text(), "the mark says the AI wrote it, not checked by a doctor")
    check("AI を使った回数: 2" in dlg.inner_text(), "the screen counts its AI calls (the daily cap is the same)")
    check(page.locator("#sim-sources li").count() >= 1, "the book sections the AI used are listed")
    check("試験用の想定診断" not in dlg.inner_text(), "the assumption is not on the play screen")
    ask("rr")
    check("呼吸数は、30 回/分。" in memo_text(), "the case answers from the AI's setting")
    page.click("#sim-wait")
    expect(memo).to_contain_text("呼びかけへの反応が鈍く", timeout=10000)
    last = sim_posts[-1]
    check(last["op"] == "next" and last["log"][-1] == {"act": "wait"} and last["state"] == "s0" and last["t"] == 1, "waiting asks the AI for what happens next, with the doctor's acts")
    ask("rr")
    m = memo_text()
    check("呼吸数は、34 回/分。" in m and "呼吸数は、30 回/分。" in m, "the case moved on; what was told before stays")
    open_sec("#sim-board")
    page.click("#sim-board [data-key='fluid=given']")
    page.click("#sim-wait")
    expect(memo).to_contain_text("呼吸が落ち着いて", timeout=10000)
    ask("rr")
    check("呼吸数は、22 回/分。" in memo_text(), "the doctor's act changes what happens next")
    check("AI が書いた続き: 2件" in dlg.inner_text(), "the screen counts the continuations")
    # the AI's next acts (D10): always shown, nothing taken until the doctor picks one
    sug = page.locator("#sim-suggest")
    check(sug.is_visible() and "採用するかは先生が決めます" in sug.inner_text(), "the next acts are shown as an example to take or not")
    shown = sug.locator("[data-suggest]").evaluate_all("bs => bs.map(b => b.dataset.suggest)")
    check("first" not in shown, f"a reading is never suggested ({shown})")
    check("limbs" in shown, f"an item not yet asked is suggested ({shown})")
    n_ask = memo_text().count("四肢の温度は")
    sug.locator("[data-suggest='limbs']").click()
    expect(memo).to_contain_text("四肢の温度は", timeout=10000)
    check(memo_text().count("四肢の温度は") == n_ask + 1, "taking a suggestion records the act like the doctor's own")
    n0 = len(sim_posts)
    page.click("#sim-suggest-refresh")
    for _ in range(50):
        if len(sim_posts) > n0 and not page.locator("#sim .notice", has_text="AI が続きを書いています").count():
            break
        page.wait_for_timeout(100)
    check(len(sim_posts) == n0 + 1 and sim_posts[-1]["op"] == "suggest", "the next acts can be written again (one AI call)")
    # the S/O/A/P draft (D12): from what the screen showed, never the hidden setting; only ticked A and P go in the note
    open_sec("#sim-soap")
    note_before = note_text()
    page.click("#sim-soap-write")
    expect(page.locator("#sim-soap input[data-soap]").first).to_be_visible(timeout=10000)
    sent = sim_posts[-1]
    check(sent["op"] == "soap" and "setting" not in sent and "log" not in sent, f"the draft is asked with what the screen showed only ({sorted(sent)})")
    check(any("呼吸数は" in line for line in sent["told"]) and not any("試験用の想定診断" in line for line in sent["told"]), "the told lines are the memo, without the assumption")
    soap_text = page.locator("#sim-soap").inner_text()
    check("【入力にない数値・要確認】" in soap_text, "a number the doctor was not told is marked")
    check("Dx（診断・確認）" in soap_text and "Tx（治療・処置・依頼）" in soap_text and "Ex（説明・教育）" in soap_text, "the plan is split into Dx / Tx / Ex")
    check(page.locator("#sim-soap input[data-soap]:checked").count() == 0 and note_text() == note_before, "nothing of the draft is in the note until ticked")
    page.check("#sim-soap input[data-soap='A0']")
    page.check("#sim-soap input[data-soap='P1']")
    n2 = note_text()
    check("〔AI草案〕" in n2 and "#1 試験の問題" in n2 and "Tx: 試験の処置" in n2, "the ticked A and P go in the note with the AI mark")
    check("血液ガスの再検" not in n2, "an item not ticked stays out")
    # a failure: the time does not pass until the doctor tries again or goes on without the AI
    page.route("**/api/sim", lambda route: route.fulfill(status=502, content_type="application/json", body=json.dumps({"error": "試験の失敗です", "code": "upstream"})))
    clock0 = dlg.locator(".sim-clock").inner_text()
    page.click("#sim-wait")
    expect(page.locator("#sim-ai-msg")).to_contain_text("試験の失敗です")
    check(dlg.locator(".sim-clock").inner_text() == clock0, "a failed continuation does not move the time")
    page.unroute("**/api/sim")
    page.click("#sim-retry")
    expect(dlg.locator(".sim-clock")).not_to_have_text(clock0)
    check(page.locator("#sim-ai-msg").count() == 0, "trying again writes the continuation")
    page.route("**/api/sim", lambda route: route.fulfill(status=502, content_type="application/json", body=json.dumps({"error": "試験の失敗です", "code": "upstream"})))
    clock1 = dlg.locator(".sim-clock").inner_text()
    page.click("#sim-wait")
    expect(page.locator("#sim-without")).to_be_visible()
    page.click("#sim-without")
    expect(dlg.locator(".sim-clock")).not_to_have_text(clock1)
    check("AI が書いた続き: 3件" in dlg.inner_text(), "going on without the AI adds no continuation")
    page.unroute("**/api/sim")
    # an item the state has no value for: the AI fills it before the ask (a pasted setting marked as the AI's, with SpO2 missing)
    gap = json.loads(json.dumps(SETTING))
    gap["states"][0]["facts"] = [f for f in gap["states"][0]["facts"] if f["q"] != "spo2"]
    gap["origin"] = {"by": "ai", "sources": []}
    page.locator("#sim button", has_text="別の設定にする").click()
    paste(json.dumps(gap, ensure_ascii=False))
    expect(page.locator("#sim-mark")).to_be_visible()
    n0 = len(sim_posts)
    ask("spo2")
    expect(memo).to_contain_text("SpO2は、92 %。", timeout=10000)
    check(sim_posts[-1]["op"] == "fill" and sim_posts[-1]["qs"] == ["spo2"] and len(sim_posts) == n0 + 1, "the AI fills the item before the ask (one call)")
    check("設定がありません" not in memo_text(), "no 'no setting' line when the AI filled it")
    ask("rr")
    check(len(sim_posts) == n0 + 1, "an item with a value needs no AI call")
    page.screenshot(path=str(OUT / "sim_ai.png"), full_page=True)
    others = [u for _, u in requests[req_ai:] if "/api/" in u and not u.endswith("/api/sim")]
    check(not others, f"the simulation calls /api/sim only ({others[:3]})")
    sets = page.evaluate("window.__sets").__getitem__(slice(sets_before, None))
    check(not sets, f"the simulation still writes nothing to the browser's storage ({sets[:3]})")
    errs = [x for x in logs if x[0] in ("error", "pageerror") and "502" not in x[1]]
    check(not errs, f"no console errors ({errs[:3]})")
    br.close()

print(f"\n{len(passed)} passed, {len(fails)} failed")
sys.exit(1 if fails else 0)
