"""Browser test of the scenes of the draft, the record's summary that goes with it, and the books' pages kept for a problem
(docs/enhancement-plan.md 8.16; docs/clinical-use.md 1e) against worker/test/devserver.ts on the synthetic fixture (iPad width).

  python3 -m ingest build --db /tmp/fx.sqlite fx tests/fixtures/synthetic_ch.md
  node --no-warnings worker/test/devserver.ts /tmp/fx.sqlite 8787 &
  python3 tests/e2e/ui_scene.py http://localhost:8787 OUT_DIR

Checks: the scene choice (the scenes after the admission need a record), the headings of a scene's draft and which of them take a tick, what
the request carries (the scene; the record's summary only for the scenes that follow a record), the summary shown before it is sent and in the
turn, that it is not saved with the conversation, the identifier check on the summary, the scene restored with the conversation, the pages kept
for a problem (searched by the problem's name, kept by the doctor, only a title / page / section's name on the server, taken back, listed in
the discharge summary and left out with the marks of origin), and that none of it is kept in the browser's own storage.
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8787"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/ui_scene")
OUT.mkdir(parents=True, exist_ok=True)
TOKEN = "test-token-0123456789abcdef"
passed, fails = [], []


def check(cond, msg):
    (passed if cond else fails).append(msg)
    print(("PASS " if cond else "FAIL ") + msg, flush=True)


CASE = {
    "age": "70代",
    "sex": "男性",
    "setting": "病棟",
    "complaint": "ゼルニア値の低下を指摘された。3日前から腹痛と嘔気。",
    "vitals": "BP 92/54, HR 108, SpO2 94%",
    "findings": "Cr 2.4 mg/dL（ふだんは 0.9）, K 5.8 mEq/L",
    "history": "高血圧。内服はアムロジピン。",
}
ED = [
    "問題リスト",
    "重症度と安定化（入力の事実に基づく論点。等級は付けない）",
    "critical の除外の根拠",
    "検査は何を区別するか",
    "行き先・帰宅条件・申し送り",
    "確認すべき数値（原本の頁で確認）",
    "書籍に見つからなかった点",
]
PROG = [
    "前回からの変化（記録の要約から）",
    "問題ごとの更新",
    "計画の変更案と、その理由",
    "新しく立つ問題",
    "翌日の確認・コール条件",
    "確認すべき数値（原本の頁で確認）",
    "書籍に見つからなかった点",
]

with sync_playwright() as pw:
    br = pw.chromium.launch()
    ctx = br.new_context(viewport={"width": 820, "height": 1180}, device_scale_factor=2, has_touch=True, is_mobile=True, locale="ja-JP")
    page = ctx.new_page()
    logs, asks = [], []
    page.on("console", lambda m: logs.append((m.type, m.text)) if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
    dialogs = []  # what confirm() asked
    policy = {"accept": True}

    def on_dialog(d):
        dialogs.append(d.message)
        d.accept() if policy["accept"] else d.dismiss()

    page.on("dialog", on_dialog)
    page.on("request", lambda r: asks.append(json.loads(r.post_data)) if r.url.endswith("/api/ask") and r.method == "POST" else None)
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

    def tick(loc, on=True):
        loc.evaluate("el => el.scrollIntoView({block: 'center'})")
        loc.set_checked(on)

    def wait_done(n):
        expect(page.locator(".turn")).to_have_count(n)
        page.locator(".turn").nth(n - 1).locator(".foot button").first.wait_for(timeout=20000)

    def wait_saved():
        expect(page.locator("#record .rec-status")).to_have_text("保存済み", timeout=8000)

    def heads(turn):
        return [s.inner_text().strip() for s in turn.locator("details.sec > summary").all()]

    def section(turn, name):
        return turn.locator("details.sec", has=page.locator("summary", has_text=name))

    def option_states():
        return page.evaluate("() => Object.fromEntries([...document.querySelectorAll('#scene-select option')].map((o) => [o.value, !o.disabled]))")

    api("DELETE", "/api/conversations")
    api("DELETE", "/api/records")

    # 1. no case: no scene row.  A pinned case: the row, with the scenes after the admission switched off (they need a record)
    check(not page.locator("#case-scene").is_visible(), "no scene row without a pinned case")
    page.click("#btn-case")
    for k in ("age", "sex", "setting"):
        page.select_option(f"#case-{k}", CASE[k])
    for k in ("complaint", "vitals", "findings", "history"):
        page.fill(f"#case-{k}", CASE[k])
    page.click("#case-pin")
    check(page.locator("#case-scene").is_visible(), "a pinned case shows the scene row")
    states = option_states()
    check(list(states) == ["", "ed", "op_first", "adm", "prog", "interim", "dc"], f"the common headings and six scenes ({list(states)})")
    check(all(states[k] for k in ("", "ed", "op_first", "adm")) and not any(states[k] for k in ("prog", "interim", "dc")), f"the scenes that follow a record are off without one ({states})")
    check("共通の見出し" in page.locator("#scene-help").inner_text() and page.locator("#scene-select").input_value() == "", "the default is the common headings")
    page.select_option("#scene-select", "adm")
    check("症例の記録を開いていないので、症例だけで作ります" in page.locator("#scene-help").inner_text() and not page.locator("#scene-brief").is_visible(), "the admission works without a record, and sends no summary")
    page.select_option("#scene-select", "ed")
    check("症例の記録の要約は渡しません" in page.locator("#scene-help").inner_text(), "the emergency scene says it sends no summary")

    # 2. a scene's draft: its headings, which take a tick, the request, the turn
    page.click("#case-modes button[data-mode=assess]")
    wait_done(1)
    t1 = page.locator(".turn").first
    ask = asks[-1]
    check(ask["mode"] == "assess" and ask["scene"] == "ed" and "record_brief" not in ask, f"the request names the scene and carries no summary ({sorted(ask)})")
    check(ask["question"] == "アセスメントとプラン（草案）（救急外来）", f"the question names the scene ({ask['question']})")
    check(heads(t1) == ED, f"the draft has the emergency headings in order ({heads(t1)})")
    for name, ticks in [("問題リスト", True), ("重症度と安定化", True), ("critical の除外の根拠", True), ("検査は何を区別するか", True), ("行き先・帰宅条件・申し送り", True), ("確認すべき数値", False), ("書籍に見つからなかった点", False)]:
        n = section(t1, name).locator(".adopt").count()
        check((n > 0) == ticks, f"{name}: {'ticks' if ticks else 'no tick'} ({n})")
    t1.locator(".casebox summary").first.click()
    check("草案の場面" in t1.locator(".casebox").first.inner_text() and "救急外来" in t1.locator(".casebox").first.inner_text(), "the turn shows the scene it was made for")
    check(t1.locator(".casebox").count() == 1, "no summary was sent, so none is shown")
    page.screenshot(path=str(OUT / "01_ed.png"))

    # 3. adopt items under the scene's headings and take them into a record (made then): the scenes after the admission open up
    tick(section(t1, "問題リスト").locator(".adopt input").nth(0))
    tick(section(t1, "問題リスト").locator(".adopt input").nth(1))
    tick(section(t1, "critical の除外の根拠").locator(".adopt input").first)
    tick(section(t1, "重症度と安定化").locator(".adopt input").nth(1))
    tick(section(t1, "行き先・帰宅条件・申し送り").locator(".adopt input").first)
    t1.locator(".record-add").click()
    expect(t1.locator(".record-add")).to_contain_text("記録に取り込みました（新しく 5 件）", timeout=8000)
    roles = [a["role"] for a in api("GET", "/api/records/" + api("GET", "/api/records")["body"]["records"][0]["id"])["body"]["record"]["ed"]["adopted"]]
    check(sorted(roles) == sorted(["problems", "problems", "assessment", "plan", "contingency"]), f"each heading's role decided the part of the chart ({roles})")
    check(page.locator("#casebar-record").inner_text() == "記録（連動中）", "the record is linked")
    states = option_states()
    check(all(states.values()), f"with a record open every scene can be chosen ({states})")

    # 4. the record: carry the problems, then the summary follows the record
    page.click("#casebar-record")
    adopted = page.locator(".rec-adopted")
    for i in range(adopted.count()):
        role = adopted.nth(i).locator(".rec-role").inner_text()
        if role.startswith("問題リスト"):
            adopted.nth(i).locator("select").select_option("new")
    check(page.locator(".rec-problem").count() == 2, "two problems from the two items")
    p1 = page.locator(".rec-problem").first
    p1.locator(".rec-cert .chip[data-opt=suspected]").click()
    p1.locator("button", has_text="＋ 計画を足す").click()
    p1.locator(".rec-entry textarea").last.fill("経過観察のうえ輸液を検討")
    wait_saved()
    page.keyboard.press("Escape")
    page.select_option("#scene-select", "prog")
    help_ = page.locator("#scene-help").inner_text()
    check("病棟・経過の見出しで作ります" in help_ and "入院1日目の時点" in help_ and "送る内容は下で確認できます" in help_, f"the help says what will be sent ({help_})")
    check(page.locator("#scene-brief").is_visible(), "the summary to be sent can be seen")
    page.locator("#scene-brief summary").click()
    expect(page.locator("#scene-brief-text")).to_contain_text("入院1日目の時点の記録")
    shown = page.locator("#scene-brief-text").inner_text()
    check(shown.startswith("入院1日目の時点の記録（確度・計画の状態・推移・課題の完了は、その日までに先生が記録したもの。問題名・評価と計画の文・問題の順序は、いまの記録のまま）") and "確度: 疑い" in shown and "（AI草案を採用したもの）" in shown, f"the summary: the day, the certainty as chosen, the AI-draft mark ({shown[:200]})")
    check("確度: 未選択" in shown, "a problem with no certainty chosen says so")
    check("経過観察のうえ輸液を検討" in shown and "予定・検討" in shown, "the doctor's own plan, still planned")
    page.screenshot(path=str(OUT / "02_prog_brief.png"))

    # 5. the identifier check on the summary: a record text with a number the guard knows blocks the send; fixing it lets it through
    page.click("#casebar-record")
    p2 = page.locator(".rec-problem").nth(1)
    old = p2.locator("input.rec-label").input_value()
    idnum = "".join(str(i) for i in range(1, 10))
    p2.locator("input.rec-label").fill(f"カルテ番号 {idnum}")
    page.wait_for_timeout(300)
    page.keyboard.press("Escape")
    n_before = len(asks)
    d_before = len(dialogs)
    page.click("#case-modes button[data-mode=assess]")
    expect(page.locator("#guard")).to_be_visible()
    check(len(dialogs) == d_before + 1 and "同じ患者" in dialogs[-1] and "いまの症例（70代・男性・病棟" in dialogs[-1], f"the doctor is asked whose record it is before a summary goes with the case ({dialogs[-1][:120]})")
    check("識別" in page.locator("#guard-list").inner_text() or page.locator("#guard-list li").count() > 0, "the identifier prompt opens for the summary")
    check(len(asks) == n_before, "nothing was sent")
    page.keyboard.press("Escape")
    page.click("#casebar-record")
    page.locator(".rec-problem").nth(1).locator("input.rec-label").fill(old)
    wait_saved()
    page.keyboard.press("Escape")

    # 6. the draft for the scene after a record: the request carries the summary; the turn shows what was sent; the headings are the scene's
    d_before = len(dialogs)
    page.click("#case-modes button[data-mode=assess]")
    wait_done(2)
    check(len(dialogs) == d_before, "asked once for the same record and case, not again")
    t2 = page.locator(".turn").nth(1)
    ask = asks[-1]
    check(ask["scene"] == "prog" and ask["record_brief"].startswith("入院1日目の時点の記録") and "確度: 疑い" in ask["record_brief"], "the request carries the scene and the record's summary")
    check(heads(t2) == PROG, f"the draft has the progress headings ({heads(t2)})")
    check(section(t2, "前回からの変化").locator(".adopt").count() == 0, "the summary of the record is read, not carried over by a tick")
    for name in ("問題ごとの更新", "計画の変更案と、その理由", "新しく立つ問題", "翌日の確認・コール条件"):
        check(section(t2, name).locator(".adopt").count() > 0, f"{name}: ticks")
    t2.locator(".casebox summary").first.click()
    t2.locator(".casebox details > summary").last.click()
    sent = t2.locator(".casebox details").last
    check("送った症例の記録の要約（入院1日目の時点）" in sent.inner_text() and ask["record_brief"].splitlines()[0] in sent.inner_text(), "the turn shows exactly what was sent")
    tick(section(t2, "問題ごとの更新").locator(".adopt input").first)
    tick(section(t2, "新しく立つ問題").locator(".adopt input").first)
    t2.locator(".record-add").click()
    expect(t2.locator(".record-add")).to_contain_text("記録に取り込みました（新しく 2 件）", timeout=8000)
    page.screenshot(path=str(OUT / "03_prog.png"))

    # 7. what is saved with the conversation: the scene, not the summary
    page.wait_for_timeout(800)
    convs = api("GET", "/api/conversations")["body"]["conversations"]
    saved = api("GET", f"/api/conversations/{convs[0]['id']}")["body"]
    blob = json.dumps(saved, ensure_ascii=False)
    pays = [t["payload"] for t in saved["turns"]]
    check([p.get("scene") for p in pays] == ["ed", "prog"], f"the scene of each draft is saved ({[p.get('scene') for p in pays]})")
    check("後日の事実は含みません" not in blob and "（AI草案を採用したもの）" not in blob and "record_brief" not in blob, "the record's summary is not saved with the conversation")
    store = page.evaluate("JSON.stringify([localStorage, sessionStorage])")
    check("入院1日目の時点の記録" not in store and "確度" not in store and "ゼルニア" not in store, "nothing of it is kept in localStorage / sessionStorage")

    # 7b. another patient's record must not ride along unnoticed: once the case's text changes the doctor is asked again, and cancelling sends nothing
    page.click("#btn-case")
    page.fill("#case-complaint", CASE["complaint"] + "追加の記載。")
    page.click("#case-pin")
    check(page.locator("#scene-select option[value=prog]").evaluate("o => !o.disabled"), "editing the pinned case keeps the scenes of the record open (the record follows the case)")
    page.select_option("#scene-select", "prog")
    policy["accept"] = False
    n_before, d_before = len(asks), len(dialogs)
    page.click("#case-modes button[data-mode=assess]")
    page.wait_for_timeout(500)
    check(len(dialogs) == d_before + 1 and "同じ患者" in dialogs[-1] and "問題:" in dialogs[-1] and len(asks) == n_before, "the case's text changed: asked again; cancelled, nothing was sent")
    policy["accept"] = True
    check(page.locator("#scene-select").input_value() == "prog", "the choice of scene is kept")

    # 8. the pages kept for a problem: the ones an adopted item cited are listed; the doctor searches by the problem's name, keeps one, takes it back
    page.click("#casebar-record")
    p1 = page.locator(".rec-problem").first
    cited = p1.locator(".rec-ref:not(.found)")
    check(cited.count() == 1 and "採用した草案の引用" in cited.first.inner_text() and cited.locator("button").count() == 0, "p1: the page its adopted item cited is listed as such, and is not taken back from here")
    p2 = page.locator(".rec-problem").nth(1)
    refs = p2.locator(".rec-refs")
    check("まだありません" in refs.inner_text(), "p2: no page yet, and the section says how to leave one")
    p2.locator("input.rec-label").fill("架空症候群")
    refs.locator("button[data-act=find-refs]").click()
    expect(refs.locator(".rec-ref.found").first).to_be_visible(timeout=10000)
    check(refs.locator(".rec-ref.found").count() >= 1 and "架空内科ハンドブック" in refs.locator(".rec-ref.found").first.inner_text(), "the search by the problem's name found sections")
    keep = refs.locator(".rec-ref.found button[data-act=keep-ref]").first
    check(keep.inner_text() == "この問題の根拠に残す" and keep.is_enabled(), "a page is left only by the doctor's own button")
    check(p2.locator(".rec-ref:not(.found)").count() == 0, "nothing is kept before that")
    keep.click()
    check(p2.locator(".rec-ref:not(.found)").count() == 1 and "p." in p2.locator(".rec-ref:not(.found)").first.inner_text(), "the page is in the problem's list")
    check("先生が検索で残した頁" in p2.locator(".rec-ref:not(.found)").first.inner_text(), "and says how it came")
    check(p2.locator(".rec-ref.found button[data-act=keep-ref]").first.inner_text() == "残してあります" and p2.locator(".rec-ref.found button[data-act=keep-ref]").first.is_disabled(), "the same page can not be left twice")
    wait_saved()
    rid = api("GET", "/api/records")["body"]["records"][0]["id"]
    srv = api("GET", f"/api/records/{rid}")["body"]["record"]
    saved_refs = srv["problems"][1].get("refs")
    check(saved_refs and sorted(saved_refs[0]) == ["added", "page", "section", "title", "via"] and saved_refs[0]["via"] == "found", f"the server holds a title, a page and a section's name only ({saved_refs})")
    check(all("snippet" not in r and "text" not in r for r in saved_refs), "no text of the book is kept")
    p2.locator(".rec-ref:not(.found) button", has_text="外す").click()
    check(page.locator(".rec-problem").nth(1).locator(".rec-ref:not(.found)").count() == 0, "a page the doctor left can be taken back")
    page.locator(".rec-problem").nth(1).locator(".rec-ref.found button[data-act=keep-ref]").first.click()
    wait_saved()
    check(len(api("GET", f"/api/records/{rid}")["body"]["record"]["problems"][1]["refs"]) == 1, "and left again")
    page.screenshot(path=str(OUT / "04_refs.png"))

    # 9. a name with an identifier-like number is not searched (the name as it is typed now, not as the card was drawn); the problem is thrown away
    page.locator("button", has_text="＋ 問題を足す").click()
    p3 = page.locator(".rec-problem").nth(2)
    p3.locator("input.rec-label").fill("検索のためのメモ")
    check(p3.locator("button[data-act=find-refs]").is_enabled(), "a name makes the search possible as soon as it is typed")
    p3.locator("input.rec-label").fill(f"カルテ番号 {idnum}")
    n_search = []
    page.on("request", lambda r: n_search.append(r.url) if r.url.endswith("/api/search") else None)
    p3.locator("button[data-act=find-refs]").click()
    expect(page.locator(".rec-problem").nth(2).locator(".rec-refs .msg.err")).to_contain_text("検索しません")
    check(not n_search, "nothing was sent to the search")
    p3.locator("input.rec-label").fill("")
    check(p3.locator("button[data-act=find-refs]").is_disabled(), "with no name there is nothing to search")
    page.locator(".rec-problem").nth(2).locator("button", has_text="削除").click()
    wait_saved()

    # 9b. a problem carried from the progress scene's draft is not marked as from the emergency (the first two, from the emergency draft, are)
    page.click("#casebar-record") if not page.locator("#record").is_visible() else None
    rows = page.locator(".rec-adopted")
    idx = [i for i in range(rows.count()) if rows.nth(i).locator("select").input_value() == "" and rows.nth(i).locator(".rec-role").inner_text().startswith("問題リスト")]
    check(len(idx) == 1, f"one item of the problem list is still undecided ({idx})")
    rows.nth(idx[0]).locator("select").select_option("new")
    cards = page.locator(".rec-problem")
    check("救急から" in cards.nth(0).inner_text() and "救急から" in cards.nth(1).inner_text(), "the two problems from the emergency draft say so")
    check(cards.count() == 3 and "救急から" not in cards.nth(2).inner_text(), "the one from the progress draft does not")
    wait_saved()

    # 10. the discharge summary lists the pages under the diagnoses the doctor classed, and the copy without the marks of origin leaves them out
    page.locator(".rec-problem").nth(1).locator(".rec-cert .chip[data-opt=likely]").click()
    page.locator(".rec-problem").nth(1).locator(".rec-dx .chip[data-opt=main]").click()
    page.locator("details.rec-sec summary", has_text="退院時サマリー（A08）").click()
    page.locator("button[data-act=discharge-decide]").click()
    d = page.locator(".rec-discharge-text").inner_text()
    check("書籍の根拠（先生が残した頁・採用した草案の引用の頁です。この記載の内容を書籍が支える確認ではありません）" in d and "［先生が検索で残した頁］" in d, f"the pages are under the diagnosis, with what they are and are not ({d[:300]})")
    src_box = page.locator("label", has_text="出どころの印").first.locator("input")
    src_box.uncheck()
    check("書籍の根拠" not in page.locator(".rec-discharge-text").inner_text(), "without the marks of origin, the pages are left out")
    src_box.check()
    check("書籍の根拠" in page.locator(".rec-discharge-text").inner_text(), "and back with them")
    page.keyboard.press("Escape")

    # 10b. the admission scene stays as of day 1 while the record moves on; the progress scene follows the working day
    page.click("#casebar-record")
    page.locator("button[data-act=next-day]").click()
    wait_saved()
    page.keyboard.press("Escape")
    page.select_option("#scene-select", "adm")
    check("入院1日目の時点" in page.locator("#scene-help").inner_text(), "the admission draft is given the record as of day 1")
    page.select_option("#scene-select", "prog")
    check("入院2日目の時点" in page.locator("#scene-help").inner_text(), "the progress draft is given the record as of the working day")

    # 11. the conversation reopened in a fresh page: the scene comes back with the draft, and the headings still take ticks
    page2 = ctx.new_page()
    page2.on("dialog", lambda d: d.accept())
    page2.goto(BASE + "/")
    page2.wait_for_function("() => document.querySelector('#chip-books').textContent.includes('(1)')")
    page2.click("#btn-convs")
    page2.click("#tab-saved")
    page2.wait_for_selector(".conv-open")
    page2.click(".conv-open")
    page2.wait_for_selector(".turn .foot button")
    turns = page2.locator(".turn")
    check(turns.count() == 2, "both drafts are back")
    turns.nth(1).locator(".casebox summary").first.click()
    check("病棟・経過" in turns.nth(1).locator(".casebox").first.inner_text(), "the restored turn says which scene it was made for")
    check(turns.nth(1).locator("details.sec").count() == 7 and turns.nth(1).locator(".adopt").count() > 0, "the restored scene draft keeps its sections and its ticks")
    check(turns.nth(1).locator(".casebox details").count() == 0, "the summary that was sent is not in a restored turn (it was never saved)")
    page2.screenshot(path=str(OUT / "05_restored.png"))

    errs = [l for l in logs if l[0] in ("error", "pageerror") and "Failed to load resource" not in l[1] and "status of 4" not in l[1]]
    check(not errs, f"no console errors other than refusals ({errs})")
    br.close()

print(f"\n{len(passed)} passed, {len(fails)} failed")
sys.exit(1 if fails else 0)
