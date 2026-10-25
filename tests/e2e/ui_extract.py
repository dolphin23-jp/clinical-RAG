"""Browser test of "文章から取り込む（試作）" inside the scene x symptom panel (docs/enhancement-plan.md 8.12, 8.15)
against worker/test/devserver.ts (whose Anthropic API is a fake extractor) on the synthetic fixture (iPad width).

  python3 -m ingest build --db /tmp/fx.sqlite fx tests/fixtures/synthetic_ch.md
  node --no-warnings worker/test/devserver.ts /tmp/fx.sqlite 8787 &
  python3 tests/e2e/ui_extract.py http://localhost:8787 OUT_DIR

Checks: the panel appears with a flow and is told what it does and does not do; nothing is entered by a proposal (the answers stay blank until the
doctor says so); the proposals come with the words they come from, split into those confirmed together (none ticked at first) and those looked at
one by one (a negation, a time, a condition of a measurement); an answer already entered is not overwritten unless its own button is pressed;
a quote that is not in the memo, a judgment and a question asked twice are dropped and counted; a memo with an identifier is not sent; dates are
made relative before sending; the request carries the flow, the schema version and the memo only; the memo is kept nowhere (no storage); changing
the flow or clearing removes memo and proposals (the answers stay); an upstream failure is told without the memo.
"""
import json
import re
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8787"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/ui_extract")
OUT.mkdir(parents=True, exist_ok=True)
TOKEN = "test-token-0123456789abcdef"
FLOW = "emergency-department.dyspnea"
passed, fails = [], []


def check(cond, msg):
    (passed if cond else fails).append(msg)
    print(("PASS " if cond else "FAIL ") + msg, flush=True)


MEMO = "78歳男性。2時間前からの呼吸困難。病着 10:20。呼吸数28、室内気でSpO2 88%。両側でcrackles。胸痛なし。既往は特になし。体温38.5℃。"

with sync_playwright() as pw:
    br = pw.chromium.launch()
    ctx = br.new_context(viewport={"width": 820, "height": 1180}, device_scale_factor=2, has_touch=True, is_mobile=True, locale="ja-JP")
    page = ctx.new_page()
    logs, extracts, others = [], [], []
    page.on("console", lambda m: logs.append((m.type, m.text)) if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
    page.on("dialog", lambda d: d.accept())

    def on_request(r):
        if r.method == "POST" and r.url.endswith("/api/extract"):
            extracts.append(json.loads(r.post_data))
        elif r.method in ("POST", "PUT", "DELETE") and "/api/" in r.url and not r.url.endswith("/api/extract"):
            others.append((r.method, r.url))

    page.on("request", on_request)
    page.goto(BASE + "/")
    page.evaluate(f"localStorage.setItem('mb.token','{TOKEN}')")
    page.reload()
    page.wait_for_function("() => document.querySelector('#chip-books').textContent.includes('(1)')")

    def q(qid):
        return page.locator(f".intake-q[data-q={qid}]")

    def open_all():
        page.evaluate("() => document.querySelectorAll('details.intake-phase, details.intake-more').forEach((d) => { d.open = true; })")

    def progress():
        m = re.search(r"(\d+)/(\d+)", page.locator(".intake-progress").inner_text())
        return int(m.group(1)), int(m.group(2))

    def make(memo):
        page.locator("textarea.extract-memo").fill(memo)
        n = len(extracts)
        page.locator("button.extract-go").click()
        page.wait_for_function("() => !document.querySelector('button.extract-go').disabled")
        page.wait_for_timeout(150)

    def pressed(qid, opt):
        return q(qid).locator(f".chip[data-opt={opt}]").get_attribute("aria-pressed") == "true"

    # 1. the panel is only there with a flow open, and says what it does
    page.click("#btn-case")
    page.locator("details.intake > summary").first.click()
    expect(page.locator("#intake-flow option")).to_have_count(14)
    check(not page.locator("details.extract").is_visible(), "no extraction panel before a flow is chosen")
    page.select_option("#intake-flow", FLOW)
    panel = page.locator("details.extract")
    check(panel.is_visible(), "the extraction panel appears with a flow")
    panel.locator("summary").first.click()
    t = panel.inner_text()
    check("提案は、先生が確認するまで入力に入りません" in t and "書かれていない項目は提案しません" in t and "陰性にはしません" in t, "it says a proposal is not an answer and a blank is not negative")
    check("氏名・ID・生年月日・電話番号は消してから貼ってください" in t and "貼った文章は保存しません" in t, "it says what not to paste and that the memo is not kept")
    check("診断・鑑別・判断の提案はしません" in t, "and that it proposes no diagnosis or judgment")
    open_all()
    done0, all0 = progress()
    check(done0 == 0, "no core question is answered at first")

    # 2. a memo: the proposals come, and nothing is entered
    make(MEMO)
    check(len(extracts) == 1, "one request was made")
    req = extracts[0]
    check(set(req.keys()) == {"flow", "schema", "text"} and req["flow"] == FLOW and re.fullmatch(r"[0-9a-f]{6,40}", req["schema"]) and req["text"] == MEMO, "it carries the flow, the schema version and the memo only")
    check(progress()[0] == 0 and q("rr").locator("input").input_value() == "" and q("spo2").locator("input").input_value() == "", "nothing is entered by the proposals")
    out = page.locator(".extract-out")
    summary = out.locator(".extract-summary").inner_text()
    check("提案 8件" in summary and "まとめて確認 4" in summary and "1件ずつ確認 4" in summary, f"8 proposals: 4 together, 4 one by one ({summary})")
    low = out.locator(".extract-item")
    check(low.count() == 4 and not any(low.nth(i).locator("input").is_checked() for i in range(4)), "the ones confirmed together: none is ticked at first")
    check("元の文: 「呼吸数28」" in out.inner_text() and "元の文: 「SpO2 88」" in out.inner_text(), "each carries the words it comes from")
    check(out.locator("button.extract-take").is_disabled() and "選んだ 0 件を入れる" in out.locator("button.extract-take").inner_text(), "taking is off until something is ticked")
    cards = out.locator(".extract-card")
    kinds = {c.get_attribute("data-q"): c.locator(".extract-why").inner_text() for c in cards.all()}
    check(set(kinds) == {"t_arrival", "o2", "hx_chest", "pmh"}, f"a time, a condition, a negation and a 'none of the history' are looked at alone ({sorted(kinds)})")
    check("時刻" in kinds["t_arrival"] and "測定の条件" in kinds["o2"] and "否定の言い方" in kinds["hx_chest"], "each says why")
    check(not out.locator("[data-q=age], [data-q=sex]").count(), "age and sex are the case's own fields: not proposed")
    out.locator(".extract-summary").scroll_into_view_if_needed()
    page.screenshot(path=str(OUT / "01_proposals.png"))

    # 3. taking the ones confirmed together: only the ticked
    low.nth(0).locator("input").check()
    check("選んだ 1 件を入れる" in out.locator("button.extract-take").inner_text() and out.locator("button.extract-take").is_enabled(), "ticking one enables taking one")
    out.locator("button", has_text="すべて選ぶ").click()
    check(out.locator(".extract-item input:checked").count() == 4, "'select all' is a button the doctor presses (it is not the default)")
    out.locator(".extract-item").nth(1).locator("input").uncheck()
    skipped = out.locator(".extract-item").nth(1).get_attribute("data-q")
    out.locator("button.extract-take").click()
    vals = {"rr": q("rr").locator("input").input_value(), "spo2": q("spo2").locator("input").input_value(), "temp": q("temp").locator("input").input_value()}
    entered = [k for k, v in vals.items() if v]
    check(progress()[0] >= 1, f"the core count follows what was taken ({progress()})")
    check(len(entered) + (1 if pressed("lung_exam", "crackles") else 0) == 3, f"three of the four were entered, as ticked ({vals}, crackles={pressed('lung_exam', 'crackles')})")
    check(skipped not in [i.get_attribute("data-q") for i in out.locator(".extract-item").all()] or True, "(the one not ticked stays a proposal)")
    check(out.locator(".extract-item").count() == 1 and out.locator(".extract-item").get_attribute("data-q") == skipped, "the one that was not ticked is still a proposal, not entered")
    skipped_blank = (q(skipped).locator("input").input_value() == "") if skipped in vals else (not pressed("lung_exam", "crackles"))
    check(skipped_blank, "and its question is still blank")

    # 3b. a ticked proposal that is answered by hand is not ticked any more, and does not come back ticked
    for qid in ("rr", "spo2", "temp"):
        q(qid).locator("input").fill("")
    if pressed("lung_exam", "crackles"):
        q("lung_exam").locator(".chip[data-opt=crackles]").click()
    make(MEMO)
    check(out.locator(".extract-item").count() == 4, "(the four plain ones again)")
    out.locator(".extract-item").nth(0).locator("input").check()
    first_q = out.locator(".extract-item").nth(0).get_attribute("data-q")
    check("選んだ 1 件を入れる" in out.locator("button.extract-take").inner_text(), "(one is ticked)")
    inp = q(first_q).locator("input") if q(first_q).locator("input").count() else None
    if inp is not None:
        inp.fill("1")
        check(not out.locator(f".extract-item[data-q={first_q}]").count(), "answered by hand: it leaves the list")
        check("選んだ 0 件を入れる" in out.locator("button.extract-take").inner_text() and out.locator("button.extract-take").is_disabled(), "and the count of ticked ones follows (nothing ticked, nothing to take)")
        inp.fill("")
        check(out.locator(f".extract-item[data-q={first_q}]").count() == 1 and not out.locator(f".extract-item[data-q={first_q}] input").is_checked(), "answer cleared: it comes back, and not ticked")
    out.locator("button", has_text="選びを外す").click()

    out.locator("button", has_text="すべて選ぶ").click()
    out.locator("button.extract-take").click()
    check(q("rr").locator("input").input_value() == "28" and q("spo2").locator("input").input_value() == "88", "(taken again, for the steps below)")

    # 4. the ones looked at alone: each decided by itself
    card = lambda qid: out.locator(f".extract-card[data-q={qid}]")
    card("hx_chest").locator("button", has_text="この答えを入れる").click()
    check(pressed("hx_chest", "none"), "a negation is entered when the doctor says so, and then")
    check(q("hx_chest").is_visible(), "(its question shows it)")
    card("t_arrival").locator("button", has_text="捨てる").click()
    check(not card("t_arrival").count() and q("t_arrival").locator("input").input_value() == "", "a dropped proposal is gone and its question stays blank")
    card("pmh").locator("button", has_text="直して入れる").click()
    check(card("pmh").count() == 1 and not pressed("pmh", "none"), "'fix and enter' goes to the question and enters nothing")
    page.screenshot(path=str(OUT / "02_after.png"))

    # 5. an answer already entered is not overwritten
    q("spo2").locator("input").fill("90")
    page.locator("textarea.extract-memo").fill("室内気でSpO2 88%")
    page.locator("button.extract-go").click()
    page.wait_for_selector(".extract-out .extract-card[data-q=spo2]")
    diff = out.locator(".extract-card[data-q=spo2]").inner_text()
    check("入力済み: 90 %" in diff and "提案: 88 %" in diff, f"another answer is entered: both are shown ({diff[:60]!r})")
    check(q("spo2").locator("input").input_value() == "90", "the entered answer did not change")
    out.locator(".extract-card[data-q=spo2] button", has_text="そのまま").click()
    check(q("spo2").locator("input").input_value() == "90" and not out.locator(".extract-card[data-q=spo2]").count(), "'leave it' keeps the answer and drops the proposal")
    page.locator("button.extract-go").click()
    page.wait_for_selector(".extract-out .extract-card[data-q=spo2]")
    out.locator(".extract-card[data-q=spo2] button", has_text="上書きして入れる").click()
    check(q("spo2").locator("input").input_value() == "88", "only its own button overwrites")

    # 6. what the checks drop: a quote that is not in the memo, a judgment, a question asked twice
    make("呼吸数28。SpO2 90%。__badquote__ __judgment__ __twice__")
    s = page.locator(".extract-out").inner_text()
    check("検査で外した提案: 4件" in s, f"the dropped ones are counted ({re.findall('検査で外した提案[^。]*。', s)})")
    shown = {e.get_attribute("data-q") for e in page.locator(".extract-out [data-q]").all()}
    check("jvd" not in shown and "spo2_cat" not in shown and "rr" not in shown, f"the made-up quote, the judgment and the doubled question are not shown ({sorted(shown)})")

    # 7. an identifier is not sent; a date is made relative before it is sent
    n = len(extracts)
    page.locator("textarea.extract-memo").fill(MEMO + " 患者ID 12345678")
    page.locator("button.extract-go").click()
    page.wait_for_timeout(300)
    check(len(extracts) == n and "送っていません" in page.locator(".extract-status").inner_text(), "a memo with an identifier is not sent, and it says so")
    check("12345678" not in page.locator(".extract-status").inner_text(), "and the message does not repeat it")
    page.locator("textarea.extract-memo").fill("10/20に入院、10/22に発熱。呼吸数28。")
    page.locator("button.extract-go").click()
    page.wait_for_function("() => !document.querySelector('button.extract-go').disabled")
    page.wait_for_timeout(150)
    sent = extracts[-1]["text"]
    check(len(extracts) == n + 1 and not re.search(r"10/2\d", sent) and re.search(r"日前|日目", sent), f"dates are made relative before sending ({sent!r})")
    check(not re.search(r"10/2\d", page.locator("textarea.extract-memo").input_value()), "and the box shows the relative form")

    # 8. a failure is told, without the memo
    make("呼吸数28。__apierror__")
    st = page.locator(".extract-status").inner_text()
    check("Anthropic API 529" in st and "呼吸数" not in st, f"an upstream failure is told without the memo ({st!r})")

    # 9. the memo is kept nowhere
    store = page.evaluate("JSON.stringify([localStorage, sessionStorage])")
    check("呼吸数" not in store and "crackles" not in store and "SpO2" not in store, "the memo is in no browser storage")
    check(not others, f"no other write request was made ({others[:2]})")

    # 10. clearing removes memo and proposals, not the answers; so does choosing another flow
    make(MEMO)
    check(page.locator(".extract-out .extract-summary").count() == 1, "(proposals again)")
    page.locator("button", has_text="文章と提案を消す").click()
    check(page.locator("textarea.extract-memo").input_value() == "" and page.locator(".extract-out").inner_text().strip() == "", "clearing removes the memo and the proposals")
    check(q("spo2").locator("input").input_value() == "88", "the answers entered stay")
    make(MEMO)
    page.select_option("#intake-flow", "emergency-department.chest-pain")
    check(page.locator("textarea.extract-memo").input_value() == "" and page.locator(".extract-out").inner_text().strip() == "", "another flow starts without the memo and proposals")

    bad = [l for l in logs if l[0] in ("error", "pageerror") and "Failed to load resource" not in l[1]]
    check(not bad, f"no console errors ({bad[:3]})")
    br.close()

print(f"\n{len(passed)} passed, {len(fails)} failed")
sys.exit(1 if fails else 0)
