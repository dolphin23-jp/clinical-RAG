"""Browser test of the outpatient record (docs/enhancement-plan.md 8.19; docs/clinical-use.md 1g) against worker/test/devserver.ts on the synthetic
fixture (iPad width).

  python3 -m ingest build --db /tmp/fx.sqlite fx tests/fixtures/synthetic_ch.md
  node --no-warnings worker/test/devserver.ts /tmp/fx.sqlite 8787 &
  python3 tests/e2e/ui_outpatient.py http://localhost:8787 OUT_DIR

Checks: the two ways to begin (the pinned case as the first visit, or a revisit with the last plan pasted), that the screen is the outpatient one (no
emergency time axis, no admission note, no Casebook, and why), the pasted plan becoming plan entries of the base day that stay "planned", the working day
as "基準日からN日後" (never 入院N日目, never a date), the previous plan's outcome as the doctor chooses it, the visit's own texts, the trend that is blank
unless chosen, the revisit note (A02) with the previous plan and what was recorded about it, the first-visit note (A01), the record saved and read back on
a fresh page, an identifier refused, and that nothing of it is kept in the browser's own storage.
"""
import json
import re
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8787"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/ui_outpatient")
OUT.mkdir(parents=True, exist_ok=True)
TOKEN = "test-token-0123456789abcdef"
passed, fails = [], []


def check(cond, msg):
    (passed if cond else fails).append(msg)
    print(("PASS " if cond else "FAIL ") + msg, flush=True)


CASE = {"age": "58", "sex": "女性", "setting": "外来", "complaint": "高血圧と腎機能の経過観察。", "findings": "Cr 1.2 mg/dL", "history": "糖尿病"}
PLAN = "- 降圧薬を継続する\n2. 2週間後に採血\n・食事指導"

with sync_playwright() as pw:
    br = pw.chromium.launch()
    ctx = br.new_context(viewport={"width": 820, "height": 1180}, device_scale_factor=2, has_touch=True, is_mobile=True, locale="ja-JP")
    page = ctx.new_page()
    logs, puts = [], []
    page.on("console", lambda m: logs.append((m.type, m.text)) if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
    page.on("dialog", lambda d: d.accept())
    page.on("request", lambda r: puts.append(json.loads(r.post_data)) if "/api/records/" in r.url and r.method == "PUT" else None)
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

    def wait_saved():
        expect(page.locator("#record .rec-status")).to_have_text("保存済み", timeout=8000)

    def rec_text():
        return page.locator("#record-body").inner_text()

    api("DELETE", "/api/conversations")
    api("DELETE", "/api/records")

    # 1. pin an outpatient case; the list offers the two ways to begin an outpatient record
    page.click("#btn-case")
    page.fill("#case-age", CASE["age"])
    page.select_option("#case-sex", CASE["sex"])
    page.select_option("#case-setting", CASE["setting"])
    page.fill("#case-complaint", CASE["complaint"])
    page.fill("#case-findings", CASE["findings"])
    page.fill("#case-history", CASE["history"])
    page.click("#case-pin")
    page.click("#btn-records")
    dlg = page.locator("#record")
    expect(dlg).to_be_visible()
    first_btn = dlg.locator("[data-act=start-first]")
    revisit_btn = dlg.locator("[data-act=start-revisit]")
    check(first_btn.is_visible() and revisit_btn.is_visible(), "with a pinned case the list offers an outpatient record, from the first visit or from a revisit")
    check("基準日からN日後" in rec_text() and "再診から始め" in rec_text(), "and says how the days are counted (no dates)")
    check(dlg.locator("button", has_text="いま固定している症例を記録にする").is_visible(), "the admission record is still offered as before")

    # 2. begin at a revisit: the outpatient screen, not the admission's
    revisit_btn.click()
    expect(page.locator("#record-body .rec-title")).to_contain_text("外来: ", timeout=8000)
    wait_saved()
    t = rec_text()
    check("再診から始めた記録（基準日・前回の方針・問題の板）" in t and "再診の記録（基準日からの日数ごと・課題）" in t, "the outpatient sections are there")
    check("救急（時間軸" not in t and "入院時（引き継ぎ" not in t and "中間サマリー" not in t and "Casebook へ送る（試作）" not in t, "none of the emergency / admission / summary / Casebook sections")
    check("外来の記録は、Casebook へは送れません" in t and "受診日の暦日" in t, "and it says why there is no Casebook part")
    check("初診は別の場所の記録なので、この記録には入っていません" in t, "a record begun at a revisit says its first visit is not in it")
    check("いまの日: 基準日から1日後" in t, "it works on the day after the base day")
    check(not page.locator(".rec-first-text").count(), "no first-visit draft for a record begun at a revisit")
    page.screenshot(path=str(OUT / "01_revisit_start.png"))

    # 3. paste the last plan: lines become the base day's plan entries, planned, in the doctor's words (a date in them is made relative)
    page.locator(".rec-paste-text").fill("10/20 に血圧測定\n" + PLAN)
    page.locator(".rec-paste-text").blur()
    page.locator(".rec-paste input.rec-label").fill("高血圧・腎機能")
    page.locator("[data-act=paste-plan]").click()
    expect(page.locator(".rec-problem[data-p=p1]")).to_be_visible(timeout=8000)
    t = rec_text()
    check("4 件を、基準日の計画（予定・検討）として足しました" in t, "the pasted lines are counted and said")
    plan_values = page.locator(".rec-problem[data-p=p1] textarea").evaluate_all("els => els.map(e => e.value)")
    joined = " | ".join(plan_values)
    check("降圧薬を継続する" in joined and "2週間後に採血" in joined and "食事指導" in joined, f"each line is a plan entry with the list marks gone ({joined[:80]})")
    check("10/20" not in joined and "日前" in joined, "a typed date in what was pasted became relative")
    check(page.locator(".rec-problem[data-p=p1] .rec-entry").count() >= 4, "four plan entries under the new problem")
    wait_saved()

    # 4. the working day: 28 days after the base day; the previous plan's outcomes are the doctor's to choose
    day = page.locator("input[data-act=days-after]")
    check(day.input_value() == "1", "the day box starts at 1 day after the base day")
    day.fill("28")
    day.blur()
    expect(page.locator(".rec-daybar-label")).to_have_text("いまの日: 基準日から28日後")
    check("入院" not in page.locator("#record-body").inner_text().replace("入院時の記載", ""), "no 入院N日目 anywhere on the outpatient screen")
    outcomes = page.locator(".rec-outcome")
    check(outcomes.count() == 4, f"the plans of the base day with no result recorded are listed ({outcomes.count()})")
    check("予定のまま" in rec_text() or "未記録" in rec_text() or "結果を記録していない" in rec_text() or "前回までに立てた計画" in rec_text(), "the screen counts them as planned (not done)")
    # the doctor chooses: the second entry (降圧薬を継続する) done, the third (2週間後に採血) changed with a reason, the others stay planned
    ids = page.locator(".rec-outcome").evaluate_all("els => els.map(e => e.dataset.i)")
    page.locator(f".rec-outcome[data-i={ids[1]}] button[data-opt=done]").click()
    page.locator(f".rec-outcome[data-i={ids[2]}] input.rec-reason").fill("腎機能を見て4週後に延ばした")
    page.locator(f".rec-outcome[data-i={ids[2]}] button[data-opt=changed]").click()
    wait_saved()
    check(page.locator(".rec-outcome").count() == 2, "an entry the doctor recorded leaves the list of unrecorded ones; the others stay")

    # 5. the visit's own words (the outpatient fields), a trend chosen for the problem, a task
    for key, val in (("purpose", "血圧と腎機能の再評価"), ("interval", "内服は続けられていた。"), ("subjective", "ときどき頭痛。"), ("objective", "Cr 1.3 mg/dL"), ("handover", "悪化時は早めに受診するよう説明。")):
        page.locator(f"textarea.rec-day-text[data-key={key}]").fill(val)
    check(not page.locator("textarea.rec-day-text[data-key=overall]").count() and not page.locator("[data-act=turning]").count(), "the admission's fields (overall, turning point) are not on an outpatient visit")
    page.locator(".rec-trend[data-p=p1] button[data-opt=worse]").click()
    page.locator(".rec-trend[data-p=p1] input.rec-reason").fill("家庭血圧が上がっている")
    page.get_by_role("button", name="＋ 課題を足す").click()
    page.locator(".rec-task textarea").first.fill("次回の採血で腎機能")
    wait_saved()
    page.screenshot(path=str(OUT / "02_visit.png"))

    # 6. the revisit note (A02): the previous plan with what was recorded, the visit's words, the trend, no admission words, no date
    note = page.locator(".rec-progress-text").inner_text()
    check(note.startswith("【外来再診】下書き\n［日付］　［患者ID］　［氏名］"), "the draft is the revisit note with the blank placeholders")
    check("基準日から28日後（前回: 基準日）" in note and "血圧と腎機能の再診" not in note and "血圧と腎機能の再評価" in note, "the day and the purpose")
    check("実施（医師の記録）:\n・降圧薬を継続する" in note, "what the doctor recorded as done is shown as done")
    check("変更（医師の記録）:\n・2週間後に採血（理由: 腎機能を見て4週後に延ばした）" in note, "a change shows its reason")
    check("計画（予定・検討。実施の記録ではありません）:" in note and "食事指導" in note, "the entries the doctor did not record stay planned")
    check("推移（基準日から28日後）: 悪化 — 家庭血圧が上がっている" in note, "the trend is the one the doctor chose")
    check("次回の採血で腎機能" in note and "ときどき頭痛。" in note and "Cr 1.3 mg/dL" in note, "the tasks and the visit's words are in")
    check("入院" not in note and not re.search(r"20\d\d[-/年]\d", note), "no admission words and no calendar date")
    page.locator(".rec-noteday").select_option(index=0)
    check(page.locator(".rec-noteday option").count() == 1, "the picker offers only the days after the base day")
    page.screenshot(path=str(OUT / "03_note.png"))

    # 7. read back on a fresh page (the record is on the server): same plan states, same day
    rid = api("GET", "/api/records")["body"]["records"][0]["id"]
    stored = api("GET", f"/api/records/{rid}")["body"]["record"]
    check(stored.get("kind") == "outpatient" and stored.get("start") == "revisit", "the stored record says outpatient and how it began")
    check(stored["course"]["today"] == 29 and stored["course"]["days"][0]["purpose"] == "血圧と腎機能の再評価", "the day and the purpose are stored")
    check(not re.search(r"20\d\d[-/年]\d|10/20", json.dumps(stored, ensure_ascii=False)), "no calendar date is stored")
    states = sorted(e["state"] for e in stored["problems"][0]["plan"])
    check(states == ["changed", "done", "planned", "planned"], f"the plan states are exactly what the doctor chose ({states})")
    page2 = ctx.new_page()
    page2.on("dialog", lambda d: d.accept())
    page2.goto(BASE + "/")
    page2.wait_for_function("() => document.querySelector('#chip-books').textContent.includes('(1)')")
    page2.click("#btn-records")
    page2.locator("#record .rec-item button", has_text="開く").first.click()
    page2.wait_for_selector(".rec-progress-text")
    check("基準日から28日後" in page2.locator("#record-body").inner_text() and "再診から始めた記録" in page2.locator("#record-body").inner_text(), "opened again on a fresh page: the same day and kind")
    page2.close()

    # 8. an identifier is refused here and by the Worker
    page.locator("textarea.rec-day-text[data-key=subjective]").fill("患者ID 123456 の再診")
    expect(page.locator("#rec-warn")).to_be_visible(timeout=8000)
    check("患者を特定できる情報の可能性" in page.locator("#rec-warn").inner_text(), "an identifier-like text is warned and not saved")
    page.locator("textarea.rec-day-text[data-key=subjective]").fill("ときどき頭痛。")
    wait_saved()

    # 9. begin at the first visit instead: the first-visit draft (A01) is there, the Casebook is still not
    page.get_by_role("button", name="この症例を終える（削除）").click()
    expect(page.locator("[data-act=start-first]")).to_be_visible(timeout=8000)
    page.locator("[data-act=start-first]").click()
    expect(page.locator("#record-body .rec-title")).to_contain_text("外来: ", timeout=8000)
    wait_saved()
    t = rec_text()
    check("初診（基準日・症例・問題の板）" in t and "初診は別の場所の記録" not in t, "begun at the first visit: the case is the first visit")
    first = page.locator(".rec-first-text").inner_text()
    check(first.startswith("【外来初診】下書き") and "58歳・女性・外来" in first and "Cr 1.2 mg/dL" in first, "the first-visit draft is built from the case")
    check("いまの日: 基準日" in t and "いまの日: 基準日から" not in t, "the working day is the base day (the first visit)")
    day = page.locator("input[data-act=days-after]")
    day.fill("14")
    day.blur()
    expect(page.locator(".rec-daybar-label")).to_have_text("いまの日: 基準日から14日後")
    check(page.locator(".rec-noteday option").count() == 1, "the revisit note can be made for a day after the first visit")
    page.screenshot(path=str(OUT / "04_first_start.png"))
    wait_saved()

    # 10. nothing is kept in the browser's own storage
    store = page.evaluate("JSON.stringify([localStorage, sessionStorage])")
    check("降圧薬" not in store and "食事指導" not in store and "血圧と腎機能" not in store and "Cr 1.3" not in store, "the plan and the visit are not kept in localStorage / sessionStorage")

    api("DELETE", "/api/records")
    bad = [l for l in logs if l[0] in ("error", "pageerror")]
    check(not bad, f"no console errors ({bad[:3]})")
    br.close()

print(f"\n{len(passed)} passed, {len(fails)} failed")
sys.exit(1 if fails else 0)
