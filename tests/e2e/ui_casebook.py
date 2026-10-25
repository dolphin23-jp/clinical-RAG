"""Browser test of sending a case record to Casebook (docs/enhancement-plan.md 8.17; docs/clinical-use.md 1f) against worker/test/devserver.ts
on the synthetic fixture (iPad width).

  python3 -m ingest build --db /tmp/fx.sqlite fx tests/fixtures/synthetic_ch.md
  node --no-warnings worker/test/devserver.ts /tmp/fx.sqlite 8787 &
  python3 tests/e2e/ui_casebook.py http://localhost:8787 OUT_DIR

Checks: the part is folded and says nothing goes over the network; what a record offers (the case as typed, problems, the diagnosis only where
the doctor chose a certainty, assessments, plans in the words of a plan, the criteria to call), AI items unticked, a dated item and a ruled-out
diagnosis shown as not sendable with the reason; the new / existing choice, the patient block filled from the case, the real / fictional choice
that starts unmade; every error said; the packet read back the way Casebook reads it (CRC, base64url, JSON); no request is made by building it;
a mark is written only after "取り込みました" (and a bad case code is refused); sent items shown as sent, the next send an append with the code,
linked to the problem sent before; a changed item sent only as a new item; a reset; and that nothing is kept in the browser's own storage.
"""
import base64
import json
import sys
import zlib
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8787"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/ui_casebook")
OUT.mkdir(parents=True, exist_ok=True)
TOKEN = "test-token-0123456789abcdef"
RID = "rcasebooke2etest0000000000000001"
passed, fails = [], []


def check(cond, msg):
    (passed if cond else fails).append(msg)
    print(("PASS " if cond else "FAIL ") + msg, flush=True)


def decode(text):
    """Reads a packet the way Casebook does: prefix, CRC-32 of the base64url body, base64url, UTF-8, JSON."""
    assert text.startswith("CBH1:"), text[:20]
    body, crc = text[5:].rsplit(".", 1)
    assert format(zlib.crc32(body.encode()) & 0xFFFFFFFF, "08x") == crc, "crc"
    return json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)).decode("utf-8"))


MAKE = """async () => {
  const R = await import('/case-record.js');
  let rec = R.newRecord({ age: '72', sex: '男性', setting: '救急', complaint: 'ゼルニア値の低下を指摘された。3日前から腹痛と嘔気。', vitals: 'BP 92/54, HR 108, SpO2 94%', findings: 'Cr 2.4 mg/dL（ふだんは 0.9）, K 5.8 mEq/L', history: '高血圧。内服はアムロジピン。' });
  let a = R.addProblem(rec, '腎前性AKI'); rec = a.rec; const p1 = a.id;
  rec = R.setProblem(rec, p1, { certainty: 'suspected' });
  rec = R.addEntry(rec, p1, 'assess', '感染と脱水に伴う。NSAIDs の関与を疑う。').rec;
  rec = R.addEntry(rec, p1, 'assess', '2025年10月24日に再診').rec;
  rec = R.addEntry(rec, p1, 'plan', '補液と原因薬の中止を検討する。').rec;
  a = R.addProblem(rec, '高血圧の管理'); rec = a.rec; const p2 = a.id;
  const e = R.addEntry(rec, p2, 'assess', '降圧薬は腎機能をみて再開する。'); rec = e.rec;
  rec = JSON.parse(JSON.stringify(rec));
  rec.problems.find((p) => p.id === p2).ai = true;
  rec.problems.find((p) => p.id === p2).assess[0].from = 'ai';
  a = R.addProblem(rec, '急性膵炎'); rec = a.rec; const p3 = a.id;
  rec = R.setProblem(rec, p3, { certainty: 'ruled_out' });
  rec.contingency.push({ id: 'i90', text: '尿量が減ったら医師を呼ぶ。', from: 'typed', added: 1 });
  rec = R.setAdm(rec, 'summary', '高齢男性の脱水に伴う腎前性AKI。');
  return { rec, p1, p2, p3 };
}"""

with sync_playwright() as pw:
    br = pw.chromium.launch()
    ctx = br.new_context(viewport={"width": 820, "height": 1180}, device_scale_factor=2, has_touch=True, is_mobile=True, locale="ja-JP")
    page = ctx.new_page()
    logs, requests = [], []
    page.on("console", lambda m: logs.append((m.type, m.text)) if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
    page.on("request", lambda r: requests.append((r.method, r.url)))
    policy = {"accept": True, "log": []}

    def on_dialog(d):
        policy["log"].append(d.message)
        d.accept() if policy["accept"] else d.dismiss()

    page.on("dialog", on_dialog)
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

    def server_rec():
        return api("GET", f"/api/records/{RID}")["body"]["record"]

    def wait_saved():
        expect(page.locator("#record .rec-status")).to_have_text("保存済み", timeout=8000)

    def row(key):
        return page.locator(f".cb-row[data-key='{key}']")

    def open_part():
        d = page.locator("#rec-casebook")
        if not d.evaluate("el => el.open"):
            page.locator("#rec-casebook > summary").click()
        return d

    api("DELETE", "/api/conversations")
    api("DELETE", "/api/records")
    made = page.evaluate(MAKE)
    P1, P2, P3 = made["p1"], made["p2"], made["p3"]
    put = api("PUT", f"/api/records/{RID}", {"record": made["rec"]})
    check(put["status"] == 200, f"the test record was saved on the server ({put['status']})")
    page.reload()
    page.wait_for_function("() => document.querySelector('#chip-books').textContent.includes('(1)')")

    # 1. open the record; the part is folded; it says nothing goes over the network
    page.click("#btn-records")
    expect(page.locator("#record")).to_be_visible()
    page.locator("#record .rec-item button", has_text="開く").first.click()
    expect(page.locator("#rec-casebook")).to_be_attached()
    check(not page.locator("#rec-casebook").evaluate("el => el.open"), "the Casebook part is folded when the record opens")
    check("Casebook へ送る（試作）" in page.locator("#rec-casebook > summary").inner_text(), "it is named 試作")
    open_part()
    t = page.locator("#rec-casebook").inner_text()
    check("通信はしません" in t and "クリップボード" in t, "it says nothing goes over the network; the packet goes by the clipboard")
    check("このパケットに入らないもの" in t, "and where the list of what is not sent is")
    page.locator("#rec-casebook .cb-notsent summary").click()
    nt = page.locator("#rec-casebook .cb-notsent").inner_text()
    check("検査値・バイタルの数値の項目" in nt and "課題" in nt and "書籍の頁" in nt, "what is not sent is listed in words")
    page.screenshot(path=str(OUT / "01_part.png"))

    # 2. what the record offers
    keys = [r.get_attribute("data-key") for r in page.locator(".cb-row").all()]
    ed_keys = [k for k in keys if k.startswith("ed.")]
    check(keys[: len(ed_keys)] == ed_keys == ["ed.complaint.c1", "ed.vitals.c1", "ed.findings.c1", "ed.history.c1"], f"the case as typed comes first ({keys[:6]})")
    check(f"p.{P1}" in keys and f"p.{P1}.dx" in keys and f"p.{P2}" in keys and f"p.{P3}.dx" in keys, "problems and the diagnoses the doctor gave a certainty to are offered")
    check(f"p.{P2}.dx" not in keys, "a problem with no certainty chosen gets no diagnosis (a blank stays blank)")
    check(not any(k.startswith("p.") and "lab" in k for k in keys), "no lab / vital item is made")
    check("cont.i90.c1" in keys and "adm.summary.c1" in keys, "the criteria to call and the admission text are offered")
    plan_row = [r for r in page.locator(".cb-row").all() if ".plan." in (r.get_attribute("data-key") or "")][0]
    check("計画（予定・検討）: 補液と原因薬の中止を検討する。" in plan_row.inner_text(), "a plan is sent in the words of a plan")
    ai_row = row(f"p.{P2}")
    check(ai_row.locator(".rec-tag.ai").count() == 1 and not ai_row.locator(".cb-check").is_checked(), "an AI problem is marked and not ticked")
    ai_assess = [r for r in page.locator(".cb-row").all() if f"p.{P2}.assess" in (r.get_attribute("data-key") or "")][0]
    check(not ai_assess.locator(".cb-check").is_checked() and ai_assess.locator(".rec-tag.ai").count() == 1, "an AI entry is marked and not ticked")
    check(row(f"p.{P1}").locator(".cb-check").is_checked() and row("ed.complaint.c1").locator(".cb-check").is_checked(), "the doctor's own items are ticked")
    dated = [r for r in page.locator(".cb-row").all() if "assess" in (r.get_attribute("data-key") or "") and "再診" in r.inner_text()][0]
    check(dated.locator(".cb-check").is_disabled() and "送れません" in dated.inner_text() and "日付が含まれています" in dated.inner_text() and "2025" not in dated.locator(".cb-why").inner_text(), "an item with a date can not be sent and says why (the text is not repeated in the reason)")
    ruled = row(f"p.{P3}.dx")
    check(ruled.locator(".cb-check").is_disabled() and "除外" in ruled.inner_text(), "a ruled-out diagnosis can not be sent (Casebook has no such kind)")
    check(row(f"p.{P3}").locator(".cb-check").is_disabled() and "除外した問題です" in row(f"p.{P3}").inner_text(), "nor can the problem the doctor ruled out (it would read as an open problem in Casebook)")
    count = page.locator(".cb-count").inner_text()
    check(count.startswith("選んだ項目: ") and f"/ 100" in count, f"the count is said ({count})")

    # 3. the target; the patient block comes from the case; the real / fictional choice starts unmade
    check(page.locator("#cb-mode-new").is_checked() and not page.locator("#cb-mode-append").is_checked(), "a record never sent is a new case")
    check(page.locator("#cb-age").input_value() == "72" and page.locator("#cb-sex").input_value() == "M" and page.locator("#cb-setting").input_value() == "emergency", "age, sex and setting come from the case")
    check(page.locator("#cb-setting option").all_inner_texts() == ["（選ぶ）", "救急", "入院"], "outpatient is not offered")
    check(not page.locator("#cb-syn-real").is_checked() and not page.locator("#cb-syn-fiction").is_checked(), "real / fictional starts unmade")
    check("取り込んだあとに、実症例へ変えることはできません" in page.locator(".cb-synth").inner_text(), "the fictional choice says it can not be undone in Casebook")
    n0 = len(requests)
    page.locator("#cb-build").scroll_into_view_if_needed()
    page.click("#cb-build")
    expect(page.locator("#cb-errors")).to_be_visible()
    check("実症例か架空症例かを選んでください" in page.locator("#cb-errors").inner_text(), "building without the choice is refused and says so")
    check(page.locator("#cb-out").count() == 0, "no packet was made")
    page.fill("#cb-age", "")
    page.select_option("#cb-sex", "")
    page.select_option("#cb-setting", "")
    page.click("#cb-syn-fiction")
    page.click("#cb-build")
    err = page.locator("#cb-errors").inner_text()
    check("年齢" in err and "性別" in err and "場面" in err, f"each missing patient field is said ({err!r})")
    page.fill("#cb-age", "７２歳")
    page.select_option("#cb-sex", "M")
    page.select_option("#cb-setting", "emergency")

    # 4. the packet
    page.click("#cb-build")
    expect(page.locator("#cb-out")).to_be_visible()
    check(page.locator("#cb-errors").is_hidden(), "no error once it is complete")
    text = page.locator("#cb-packet").input_value()
    pk = decode(text)
    items = pk["items"]
    check(pk["magic"] == "CBH1" and pk["schemaVersion"] == 1 and pk["target"] == {"mode": "new"}, "the envelope is Casebook's")
    check(pk["patient"] == {"ageYears": 72, "sex": "M", "setting": "emergency"} and pk.get("synthetic") is True and pk["hospitalDay"] == 1, "the patient block (the age typed in full-width is read), the fictional mark and the hospital day")
    kinds = [i["body"]["kind"] for i in items]
    check(kinds[:2] == ["problem", "diagnosis"] and set(kinds) <= {"problem", "diagnosis", "course", "note"}, f"problems first; only problem / diagnosis / course / note ({kinds})")
    texts = [i["body"]["text"] for i in items]
    check(not any("2025" in x for x in texts) and not any("膵炎" in x for x in texts) and not any("降圧薬" in x or "高血圧の管理" == x for x in texts), "the dated item, the ruled-out diagnosis and the unticked AI items are not in it")
    check(all(i["source"] == "user" for i in items), "every item sent is the doctor's own")
    p1_item = next(i for i in items if i["body"]["kind"] == "problem")
    notes = [i for i in items if i["body"]["text"].startswith("評価: ")]
    check(len(notes) == 1 and notes[0]["problemId"] == p1_item["itemId"], "an assessment is linked to its problem")
    check(all("problemId" not in i for i in items if i["body"]["kind"] in ("problem", "diagnosis")), "a problem and a diagnosis carry no link")
    check(len({i["itemId"] for i in items}) == len(items) and all(len(i["itemId"]) == 26 for i in items), "every item has its own ULID")
    check("パケットを作りました" in page.locator("#cb-out").inner_text() and "Playbook から受け取る" in page.locator("#cb-out").inner_text(), "the screen says what to do in Casebook")
    new_requests = [(m, u) for m, u in requests[n0:] if "/api/records" not in u]
    check(not new_requests, f"building made no request other than saving the record ({new_requests})")
    wait_saved()
    srv = server_rec()
    check(len(srv["casebook"]["seed"]) == 10 and srv["casebook"]["sent"] == {} and srv["casebook"]["code"] == "", "the seed was made and saved; nothing is marked sent by copying")
    page.screenshot(path=str(OUT / "02_packet.png"))

    # 5. "取り込みました": a bad case code is refused; then the marks are written with the code
    page.fill("#cb-newcode", "ABC230")
    page.click("#cb-imported")
    check("症例コードの形ではありません" in page.locator("#cb-out").inner_text(), "a bad case code is refused")
    check(server_rec()["casebook"]["sent"] == {}, "and nothing was marked")
    page.fill("#cb-newcode", "abc 234")
    page.click("#cb-imported")
    wait_saved()
    srv = server_rec()
    check(srv["casebook"]["code"] == "ABC234" and len(srv["casebook"]["sent"]) == len(items) and srv["casebook"]["count"] == 1, f"the code and {len(items)} marks were saved")
    check(all(set(v) == {"h", "r"} and v["r"] == 0 for v in srv["casebook"]["sent"].values()), "a mark holds a hash and a revision, nothing else")
    check(page.locator("#cb-out").count() == 0, "the packet is gone from the screen")
    sent_rows = page.locator(".cb-row[data-state=sent]")
    check(sent_rows.count() == len(items) and all(sent_rows.nth(i).locator(".badge").inner_text() == "送信済み" and sent_rows.nth(i).locator(".cb-check").is_disabled() for i in range(sent_rows.count())), "sent items are shown as sent and can not be ticked again")
    check(page.locator("#cb-mode-append").is_checked() and page.locator("#cb-code").input_value() == "ABC234", "the next send is an append to that case")
    check(row("ed.complaint.c1").locator(".cb-check").is_checked() is False, "nothing sent is ticked")

    # 6. an append carries the code and only the new item, linked to the problem sent before
    first_card = page.locator(".rec-problem").first
    first_card.locator("button", has_text="＋ 評価を足す").click()
    area = first_card.locator("textarea.rec-entry-text")
    empty = area.evaluate_all("els => els.findIndex((e) => e.value === '')")
    area.nth(empty).fill("尿量は回復傾向。")
    area.nth(empty).blur()
    wait_saved()
    page.wait_for_timeout(700)  # the part draws itself again a moment after the record changes
    open_part()
    # the date typed earlier was made relative when the record was saved, so that item is sendable now; the new entry is the other new one
    fresh = page.locator(".cb-row[data-state=new]").filter(has=page.locator(".cb-check:checked"))
    fresh_texts = [fresh.nth(i).inner_text() for i in range(fresh.count())]
    check(fresh.count() == 2 and any("尿量は回復傾向" in t for t in fresh_texts) and any("日前に再診" in t or "か月前に再診" in t for t in fresh_texts), f"only the new entry and the item whose date was made relative are ticked ({fresh_texts})")
    check(not any("2025" in t for t in fresh_texts), "the calendar date is gone from the record")
    page.click("#cb-build")
    expect(page.locator("#cb-out")).to_be_visible()
    ap = decode(page.locator("#cb-packet").input_value())
    check(ap["target"] == {"mode": "append", "caseCode": "ABC234"} and "patient" not in ap and "synthetic" not in ap and "hospitalDay" not in ap, "an append has the code and no patient, mark or hospital day")
    check(len(ap["items"]) == 2 and all(i["problemId"] == p1_item["itemId"] for i in ap["items"]), "its items are linked to the problem that was sent before")
    check("取り込みました" in page.locator("#cb-out").inner_text() and page.locator("#cb-newcode").count() == 0, "an append asks for no new code")
    page.click("#cb-discard")
    check(page.locator("#cb-out").count() == 0 and server_rec()["casebook"]["count"] == 1, "discarding a packet marks nothing")

    # 7. a changed item is sent only as a new item
    first_assess = next(i for i in items if i["body"]["text"].startswith("評価: "))
    first_card = page.locator(".rec-problem").first
    first_card.locator("textarea.rec-entry-text").first.fill("感染と脱水に伴う。NSAIDs は中止済み。")
    first_card.locator("textarea.rec-entry-text").first.blur()
    wait_saved()
    page.wait_for_timeout(700)
    open_part()
    ch = page.locator(".cb-row[data-state=changed]")
    check(ch.count() == 1 and ch.first.locator(".badge").inner_text() == "送信後に直した" and not ch.first.locator(".cb-check").is_checked(), "an item changed after it was sent is said so and is not ticked")
    check("前の項目も Casebook に残ります" in page.locator("#rec-casebook").inner_text(), "and the screen says the earlier item stays in Casebook")
    ch.first.locator(".cb-check").check()
    page.click("#cb-build")
    expect(page.locator("#cb-out")).to_be_visible()
    re_pk = decode(page.locator("#cb-packet").input_value())
    re_items = [i for i in re_pk["items"] if i["body"]["text"].startswith("評価: 感染と脱水")]
    check(len(re_items) == 1 and re_items[0]["itemId"] != first_assess["itemId"] and "中止済み" in re_items[0]["body"]["text"], f"sent again it is a second item with its own id ({[i['body']['text'][:20] for i in re_pk['items']]})")
    page.click("#cb-imported")
    wait_saved()
    srv = server_rec()
    check(any(v["r"] == 1 for v in srv["casebook"]["sent"].values()) and srv["casebook"]["count"] == 2, "its mark moved to revision 1")

    # 7b. what is on the screen is what is sent: a record changed a moment ago is compared again when the button is pressed
    area = page.locator(".rec-problem").first.locator("textarea.rec-entry-text")
    area.nth(2).fill("尿量は回復傾向。さらに血圧も安定している。")
    page.click("#cb-build")
    expect(page.locator("#cb-note")).to_be_visible()
    check("記録が変わっていた" in page.locator("#cb-note").inner_text() and page.locator("#cb-out").count() == 0, "a record changed a moment ago: the list is updated and no packet is made until the button is pressed again")
    page.click("#cb-discard") if page.locator("#cb-discard").count() else None

    # 8. a fresh page: the marks and the code are the record's
    page.reload()
    page.wait_for_function("() => document.querySelector('#chip-books').textContent.includes('(1)')")
    page.click("#btn-records")
    page.locator("#record .rec-item button", has_text="開く").first.click()
    open_part()
    check(page.locator(".cb-row[data-state=sent]").count() >= len(items) and page.locator("#cb-code").input_value() == "ABC234", "after a reload the marks and the code are still there")
    stored = page.evaluate("() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])")
    check("CBH1" not in stored and "ABC234" not in stored and "casebook" not in stored.lower().replace("mb.", ""), "nothing of the packet, the code or the marks is in the browser's own storage")

    # 9. a reset: the code and the marks go; the next send is a new case again
    policy["log"].clear()
    page.click("#cb-reset")
    wait_saved()
    check(any("新しい症例として" in m for m in policy["log"]), "the reset asks first")
    srv = server_rec()
    check(srv["casebook"]["code"] == "" and srv["casebook"]["sent"] == {} and srv["casebook"]["count"] == 0 and len(srv["casebook"]["seed"]) == 10, "the code and the marks are gone, with a new seed")
    check(page.locator("#cb-mode-new").is_checked() and page.locator(".cb-row[data-state=sent]").count() == 0, "the record is a new case again")
    check(not page.locator("#cb-syn-fiction").is_checked() and not page.locator("#cb-syn-real").is_checked(), "and real / fictional is unmade again (it is chosen for each new case)")
    page.screenshot(path=str(OUT / "03_reset.png"))

    check(not [l for l in logs if l[0] in ("error", "pageerror")], f"no console errors ({logs})")
    br.close()

print(f"\n{len(passed)} passed, {len(fails)} failed")
if fails:
    print("FAILED:\n  " + "\n  ".join(fails))
    sys.exit(1)
