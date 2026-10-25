"""scripts/import_flow_schema.py: the question structure of clinical-modules' dialogue flows (docs/clinical-use.md 1e).

Synthetic flow files only. The committed web/flow-schema.js is also compared with a real clinical-modules checkout when one is
next to this repository (or named by MODULES_DIR); without one, that comparison is skipped.
"""
import json
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import import_flow_schema as imp  # noqa: E402

FLOW = """# 架空の場面 × 架空の症候 の対話フロー（これは試験用。臨床には使わない）
#
# Not for clinical use. 規則の文章や診断名は取り込まれないことの確認用の語: ZZ_SENTINEL_RULE_TEXT

scene = "demo-scene"
module = "demo"
version = 3
status = "draft"
ddx_slot = 5
origin_q = "t_onset"
origin_label = "発症"

bridge = [
  { q = "age", ent = "context" },
  { q = "onset", ent = "observation", concept = "ZZ_SENTINEL_CONCEPT", at = "t_onset", neg = ["gradual"], unable = ["unable"], wait = ["sudden"] },
  { q = "t_onset", ent = "time" },
  { q = "note", ent = "none", why = "ZZ_SENTINEL_WHY" },
]

[[phase]]
id = "p1"
name = "受け入れ"
short = "受け入れ"
slots = [1, 2]
hint = "ZZ_SENTINEL_HINT"

[[phase]]
id = "p2"
name = "病歴"
short = "病歴"
slots = [3]

[[question]]
id = "age"
slot = 1
label = "年齢"
type = "number"
unit = "歳"
core = true

[[question]]
id = "sex"
slot = 1
label = "性別"
type = "choice"
options = ["m:男性", "f:女性", "unk:不明"]

[[question]]
id = "onset"
slot = 3
label = "★1 発症様式"
type = "choice"
core = true
required = true
options = ["sudden:突然（秒〜分）|突然", "gradual:徐々に", "unable:評価不能|不能"]
line = "発症様式：{value}"
help = "ZZ_SENTINEL_HELP"

[[question]]
id = "assoc"
slot = 3
label = "随伴症状"
type = "multi"
exclusive = ["none"]
options = ["fever:発熱", "nausea:嘔気", "none:なし"]
when = "$any_unable | sex=f"

[[question]]
id = "preg"
slot = 3
label = "妊娠の可能性"
type = "choice"
when = "sex=f & onset?"
options = ["yes:あり", "no:なし"]

[[question]]
id = "note"
slot = 3
label = "メモ"
type = "text"

[[question]]
id = "t_onset"
slot = 3
label = "発症時刻"
type = "time"
line = "発症（{value}）"

[[question]]
id = "axis_pick"
slot = 2
label = "軸の選択"
type = "axis_sel"
options = ["a:軸A", "b:軸B"]

[[def]]
id = "any_unable"
expr = "onset=unable | $later"

[[def]]
id = "later"
expr = "preg=yes"

[[def]]
id = "never_used"
expr = "sex=m"

[[rule]]
id = "r1"
if = "onset=sudden"
tag = "推論"
up = ["ZZ_SENTINEL_DDX"]

[[ddx]]
id = "ZZ_SENTINEL_DDX"
label = "架空の鑑別"
"""

SCENE = """---
scene: 架空の場面
type: scene
---

# 架空の場面

| # | 枠 | 内容 | 目的 | 備考 |
|---|---|---|---|---|
| 1 | 事前情報 | 年齢・性別 ZZ_SENTINEL_SCENE_BODY | P1,P3 | — |
| 2 | 初期評価 | 気道・呼吸 | P2 | — |
| 3 | 病歴 | 発症様式 | P1, P4 | — |
"""


def make(flows: dict[str, str], scenes: dict[str, str] | None = None) -> Path:
    root = Path(tempfile.mkdtemp(prefix="flowschema-"))
    (root / "flows").mkdir()
    (root / "scenes").mkdir()
    for name, text in flows.items():
        (root / "flows" / name).write_text(text, encoding="utf-8")
    for name, text in (scenes or {}).items():
        (root / "scenes" / name).write_text(text, encoding="utf-8")
    return root


def js_json(text: str, name: str) -> dict:
    m = re.search(rf"export const {name} = (\{{.*?\n\}});", text, re.S)
    assert m, name
    return json.loads(re.sub(r",\s*\}$", "}", m.group(1)))  # the file is JavaScript: a trailing comma is allowed there


def source_of(text: str) -> dict:
    m = re.search(r"export const FLOW_SCHEMA_SOURCE = (\{.*?\});", text)
    assert m
    return json.loads(m.group(1))


class ImportTest(unittest.TestCase):
    def setUp(self):
        self.root = make({"demo-scene.demo.toml": FLOW}, {"demo-scene.md": SCENE})
        self.flows, self.scenes = imp.load_all(self.root)
        self.flow = self.flows[0]

    def test_the_flow_keeps_its_structure(self):
        f = self.flow
        self.assertEqual((f["id"], f["scene"], f["module"], f["version"]), ("demo-scene.demo", "demo-scene", "demo", 3))
        self.assertEqual(f["title"], "架空の場面 × 架空の症候")  # from the file's first comment line
        self.assertEqual([p["id"] for p in f["phases"]], ["p1", "p2"])
        self.assertEqual(f["phases"][0], {"id": "p1", "name": "受け入れ", "short": "受け入れ", "slots": [1, 2]})
        q = {x["id"]: x for x in f["questions"]}
        self.assertEqual(list(q), ["age", "sex", "onset", "assoc", "preg", "note", "t_onset"])  # the file's order
        self.assertEqual(q["age"], {"id": "age", "slot": 1, "label": "年齢", "type": "number", "unit": "歳", "core": True, "br": {"ent": "context"}})
        self.assertEqual(q["onset"]["options"][0], {"id": "sudden", "label": "突然（秒〜分）", "short": "突然"})
        self.assertEqual(q["onset"]["options"][1], {"id": "gradual", "label": "徐々に"})
        self.assertEqual(q["onset"]["line"], "発症様式：{value}")
        self.assertTrue(q["onset"]["core"] and q["onset"]["required"])
        self.assertEqual(q["assoc"]["exclusive"], ["none"])

    def test_judgement_and_prose_are_not_taken(self):
        text = imp.render(self.flows, self.scenes, "abc")
        for left_out in ("ZZ_SENTINEL_RULE_TEXT", "ZZ_SENTINEL_HINT", "ZZ_SENTINEL_HELP", "ZZ_SENTINEL_DDX", "ZZ_SENTINEL_SCENE_BODY", "ZZ_SENTINEL_CONCEPT", "ZZ_SENTINEL_WHY", "ddx_slot", "bridge", '"help"', '"hint"', '"up"', "r1", '"concept"', '"why"'):
            self.assertNotIn(left_out, text)
        for q in self.flow["questions"]:
            self.assertLessEqual(set(q), set(imp.QUESTION_KEYS) | {"options", "br"})
        # the scene keeps its frames' names and purposes, not their contents
        s = self.scenes[0]
        self.assertEqual(s["frames"], [{"n": 1, "name": "事前情報", "purposes": ["P1", "P3"]}, {"n": 2, "name": "初期評価", "purposes": ["P2"]}, {"n": 3, "name": "病歴", "purposes": ["P1", "P4"]}])

    def test_the_bridge_keeps_its_structure_and_leaves_its_prose(self):
        q = {x["id"]: x for x in self.flow["questions"]}
        # kind, the time question it hangs on, and the option ids that mean none / unable / waiting
        self.assertEqual(q["onset"]["br"], {"ent": "observation", "at": "t_onset", "neg": ["gradual"], "unable": ["unable"], "wait": ["sudden"]})
        self.assertEqual(q["t_onset"]["br"], {"ent": "time"})
        self.assertEqual(q["note"]["br"], {"ent": "none"})  # the reason it is not mapped (prose) is not taken
        self.assertNotIn("br", q["sex"])  # not declared: nothing is made up
        # the time axis starts at the flow's own question, with its own name
        self.assertEqual(self.flow["origin"], {"q": "t_onset", "label": "発症"})

    def test_a_bridge_or_origin_that_names_what_does_not_exist_is_refused(self):
        cases = {
            "bridge option": FLOW.replace('neg = ["gradual"]', 'neg = ["nonesuch"]'),
            "origin_q is no question": FLOW.replace('origin_q = "t_onset"', 'origin_q = "nowhere"'),
            "origin_q is not a time question": FLOW.replace('origin_q = "t_onset"', 'origin_q = "onset"'),
            "origin_label without origin_q": FLOW.replace('origin_q = "t_onset"\n', ""),
            "origin_q without origin_label": FLOW.replace('origin_label = "発症"\n', ""),
            "origin_label is a sentence": FLOW.replace('origin_label = "発症"', 'origin_label = "' + "あ" * 40 + '"'),
            "ent is prose": FLOW.replace('ent = "context"', 'ent = "これは文章であって種類ではない"'),
            "status is prose": FLOW.replace('{ q = "age", ent = "context" }', '{ q = "age", ent = "action", status = "ここに長い説明を書く" }'),
            "phase is not a phase": FLOW.replace('{ q = "age", ent = "context" }', '{ q = "age", ent = "observation", phase = "whenever" }'),
            "at is no question": FLOW.replace('at = "t_onset"', 'at = "t_nowhere"'),
            "of is no question": FLOW.replace('{ q = "age", ent = "context" }', '{ q = "age", ent = "assessment", of = "t_nowhere" }'),
            "a scalar that is not a string": FLOW.replace('{ q = "age", ent = "context" }', '{ q = "age", ent = 3 }'),
        }
        for name, text in cases.items():
            with self.subTest(name), self.assertRaises(SystemExit):
                imp.load_all(make({"x.toml": text}))

    def test_axis_questions_are_skipped_and_said(self):
        self.assertNotIn("axis_pick", [q["id"] for q in self.flow["questions"]])
        self.assertEqual(self.flow["skipped"], ["axis_pick"])

    def test_only_the_conditions_a_question_uses_come_across_with_what_they_use(self):
        # assoc uses $any_unable, which uses $later; never_used is not referenced by any question
        self.assertEqual(sorted(self.flow["defs"]), ["any_unable", "later"])
        self.assertEqual(self.flow["defs"]["any_unable"], "onset=unable | $later")

    def test_output_is_deterministic_and_records_where_it_came_from(self):
        a = imp.render(self.flows, self.scenes, "f00dfeed")
        b = imp.render(*imp.load_all(self.root), "f00dfeed")
        self.assertEqual(a, b)
        self.assertEqual(source_of(a), {"repository": "clinical-modules", "path": "flows/*.toml, scenes/*.md", "commit": "f00dfeed", "flows": 1, "scenes": 1})
        self.assertEqual(list(js_json(a, "FLOWS")), ["demo-scene.demo"])
        self.assertIn("GENERATED by scripts/import_flow_schema.py", a)
        self.assertIn("Structure only", a)

    def test_bad_input_is_refused(self):
        no_options = FLOW.replace('options = ["m:男性", "f:女性", "unk:不明"]', "")
        dup = FLOW.replace('id = "note"', 'id = "age"')
        missing_def = FLOW.replace('when = "$any_unable | sex=f"', 'when = "$nowhere"')
        no_phase = FLOW.split("[[phase]]")[0] + "[[question]]\nid = 'x'\nslot = 1\nlabel = 'x'\ntype = 'text'\n"
        for name, text in {"options": no_options, "duplicate id": dup, "undefined $name": missing_def, "no phases": no_phase}.items():
            with self.subTest(name), self.assertRaises(SystemExit):
                imp.load_all(make({"x.toml": text}))
        with self.assertRaises(SystemExit):
            imp.load_all(make({"a.toml": FLOW, "b.toml": FLOW}))  # the same flow twice
        with self.assertRaises(SystemExit):
            imp.load_all(make({}))

    def test_check_mode_writes_nothing_and_reports_staleness(self):
        out = Path(tempfile.mkdtemp()) / "flow-schema.js"
        args = ["--modules", str(self.root), "--out", str(out), "--commit", "c1"]
        self.assertEqual(imp.main(args), 0)
        before = out.read_text(encoding="utf-8")
        self.assertEqual(imp.main([*args, "--check"]), 0)
        (self.root / "flows" / "demo-scene.demo.toml").write_text(FLOW.replace("発症様式", "起こり方"), encoding="utf-8")
        self.assertEqual(imp.main([*args, "--check"]), 1)
        self.assertEqual(out.read_text(encoding="utf-8"), before)  # --check does not rewrite


# ---------------------------------------------------------------- cat: the category that ties a question to a field of a chart-note type
CAT_FLOW = """# 架空の場面 × 架空の症候 の対話フロー（試験用。臨床には使わない）
scene = "er-demo"
module = "demo"
version = 1
bridge = [
  { q = "temp", ent = "observation", cat = "abcde" },
  { q = "onset", ent = "observation", cat = "pending" },
  { q = "hx", ent = "context", cat = "hpi" },
  { q = "judge", ent = "assessment", cat = "initial" },
  { q = "given", ent = "action", cat = "pending" },
  { q = "t_temp", ent = "time" },
  { q = "memo", ent = "none", why = "ZZ_SENTINEL_WHY" },
]

[[phase]]
id = "p1"
name = "初期評価"
short = "初期"
slots = [1]

[[question]]
id = "temp"
slot = 1
label = "体温"
type = "number"
unit = "℃"

[[question]]
id = "onset"
slot = 1
label = "発症様式"
type = "choice"
options = ["sudden:突然", "gradual:徐々に"]

[[question]]
id = "hx"
slot = 1
label = "経過"
type = "text"

[[question]]
id = "judge"
slot = 1
label = "評価（医師の判断）"
type = "choice"
options = ["a:安定", "b:不安定"]

[[question]]
id = "given"
slot = 1
label = "行った処置"
type = "multi"
options = ["o2:酸素", "iv:輸液"]

[[question]]
id = "t_temp"
slot = 1
label = "測った時刻"
type = "time"

[[question]]
id = "memo"
slot = 1
label = "メモ"
type = "text"
"""

# the parts of the training repository's scripts that the importer reads as literals (never runs)
FLOW_PY = """# stand-in for clinical-modules' scripts/flow.py: only the declarations the importer reads
BRIDGE_CAT_PENDING = "pending"
BRIDGE_CAT_ENTITY = {"observation": "observation", "context": "patient_context", "assessment": "assessment", "action": "action"}
CAT_SCENE_NOTE = {"er-demo": "X04"}
"""

NOTE_PY = """ROUTES = {
    "X04": {
        "arrival": "patient_context:arrival",
        "hpi": "patient_context:hpi;observation:hpi",
        "initial": "observation:initial,abcde;assessment:initial",
        "exam": "observation:physical",
        "plan": "action:management,procedure;communication:consult_request",
    },
}
"""


def make_cat(flow_text=CAT_FLOW, flow_py=FLOW_PY, note_py=NOTE_PY) -> Path:
    root = make({"er-demo.demo.toml": flow_text})
    (root / "scripts").mkdir()
    if flow_py is not None:
        (root / "scripts" / "flow.py").write_text(flow_py, encoding="utf-8")
    if note_py is not None:
        (root / "scripts" / "note_expanded.py").write_text(note_py, encoding="utf-8")
    return root


def replace_decl(text: str, q: str, new: str) -> str:
    out, n = re.subn(rf'  \{{ q = "{q}", [^\n]*\}},\n', f"  {new},\n", text)
    assert n == 1, q
    return out


class CategoryTest(unittest.TestCase):
    def flow(self, text=CAT_FLOW, **kw):
        return imp.load_all(make_cat(text, **kw))[0][0]

    def test_a_category_comes_across_with_the_note_type_it_points_into(self):
        f = self.flow()
        by = {q["id"]: q["br"] for q in f["questions"]}
        self.assertEqual((by["temp"]["cat"], by["onset"]["cat"], by["hx"]["cat"], by["judge"]["cat"], by["given"]["cat"]), ("abcde", "pending", "hpi", "initial", "pending"))
        self.assertEqual(f["cat"], {"note": "X04", "entity": {"action": "action", "assessment": "assessment", "context": "patient_context", "observation": "observation"}, "pending": "pending"})
        for k in ("t_temp", "memo"):
            self.assertNotIn("cat", by[k])  # time and none take none
        self.assertNotIn("ZZ_SENTINEL_WHY", imp.render([f], [], "c1"))  # the prose of the declaration still does not come across

    def test_a_missing_category_is_refused(self):
        with self.assertRaisesRegex(SystemExit, r"question temp has no cat"):
            self.flow(replace_decl(CAT_FLOW, "temp", '{ q = "temp", ent = "observation" }'))

    def test_an_unknown_category_and_an_entity_ROUTES_does_not_take_it_for_are_refused(self):
        with self.assertRaisesRegex(SystemExit, r"temp.*'nonsense'.*does not take"):
            self.flow(replace_decl(CAT_FLOW, "temp", '{ q = "temp", ent = "observation", cat = "nonsense" }'))
        # hpi is a category of patient_context and of observation, but initial is not one for a context
        with self.assertRaisesRegex(SystemExit, r"hx.*'initial'.*patient_context"):
            self.flow(replace_decl(CAT_FLOW, "hx", '{ q = "hx", ent = "context", cat = "initial" }'))
        # arrival is a context category only
        with self.assertRaisesRegex(SystemExit, r"temp.*'arrival'"):
            self.flow(replace_decl(CAT_FLOW, "temp", '{ q = "temp", ent = "observation", cat = "arrival" }'))
        # a wildcard or prose is not a category
        for bad in ("*", "Initial", "初期", "initial x", ""):
            with self.subTest(bad), self.assertRaises(SystemExit):
                self.flow(replace_decl(CAT_FLOW, "temp", f'{{ q = "temp", ent = "observation", cat = "{bad}" }}'))

    def test_a_category_on_a_question_that_is_not_a_record_entry_is_refused(self):
        with self.assertRaisesRegex(SystemExit, r"t_temp.*cannot have a cat"):
            self.flow(replace_decl(CAT_FLOW, "t_temp", '{ q = "t_temp", ent = "time", cat = "pending" }'))
        with self.assertRaisesRegex(SystemExit, r"memo.*cannot have a cat"):
            self.flow(replace_decl(CAT_FLOW, "memo", '{ q = "memo", ent = "none", why = "w", cat = "hpi" }'))

    def test_a_scene_without_a_note_type_takes_no_category(self):
        other = CAT_FLOW.replace('scene = "er-demo"', 'scene = "op-demo"')
        with self.assertRaisesRegex(SystemExit, r"scene op-demo takes no cat"):
            imp.load_all(make_cat(other))
        # the same flow without any cat is fine in such a scene (a scene that has no note type yet)
        bare = re.sub(r', cat = "[a-z_]+"', "", other)
        f = self.flow(bare)
        self.assertNotIn("cat", f)

    def test_without_the_scripts_a_category_cannot_be_checked_so_it_is_refused(self):
        with self.assertRaisesRegex(SystemExit, r"no scripts/flow.py"):
            imp.load_all(make_cat(flow_py=None))
        # a checkout without them and without any cat is the synthetic one of the other tests: fine
        bare = re.sub(r', cat = "[a-z_]+"', "", CAT_FLOW)
        self.assertEqual(len(imp.load_all(make_cat(bare, flow_py=None, note_py=None))[0]), 1)

    def test_ROUTES_that_sends_one_category_to_two_fields_is_refused(self):
        twice = NOTE_PY.replace('"exam": "observation:physical"', '"exam": "observation:physical,abcde"')
        with self.assertRaisesRegex(SystemExit, r"observation:abcde goes to both"):
            self.flow(note_py=twice)

    def test_the_declarations_are_read_not_run(self):
        marker = Path(tempfile.mkdtemp()) / "ran"
        evil_flow = FLOW_PY + f'\nopen({str(marker)!r}, "w").write("x")\n'
        evil_note = NOTE_PY + f'\nopen({str(marker)!r}, "w").write("x")\n'
        self.flow(flow_py=evil_flow, note_py=evil_note)
        self.assertFalse(marker.exists())
        with self.assertRaisesRegex(SystemExit, r"not a plain literal"):
            self.flow(flow_py=FLOW_PY.replace('CAT_SCENE_NOTE = {"er-demo": "X04"}', 'CAT_SCENE_NOTE = dict(a="X04")'))

    def test_output_is_deterministic_and_check_notices_a_changed_category(self):
        root = make_cat()
        out = Path(tempfile.mkdtemp()) / "flow-schema.js"
        self.assertEqual(imp.main(["--modules", str(root), "--out", str(out), "--commit", "c1"]), 0)
        self.assertEqual(imp.main(["--modules", str(root), "--out", str(out), "--commit", "c1", "--check"]), 0)
        path = root / "flows" / "er-demo.demo.toml"
        path.write_text(replace_decl(CAT_FLOW, "onset", '{ q = "onset", ent = "observation", cat = "hpi" }'), encoding="utf-8")
        self.assertEqual(imp.main(["--modules", str(root), "--out", str(out), "--commit", "c1", "--check"]), 1)


class CommittedFileTest(unittest.TestCase):
    def test_web_flow_schema_matches_a_modules_checkout(self):
        committed = (ROOT / "web" / "flow-schema.js").read_text(encoding="utf-8")
        modules = Path(os.environ.get("MODULES_DIR", str(ROOT.parent / "clinical-modules")))
        if not (modules / "flows").is_dir():
            self.skipTest("no clinical-modules checkout (set MODULES_DIR)")
        commit = source_of(committed)["commit"]
        # a later Modules commit changes nothing here unless it changes a flow's questions or a scene's frames
        self.assertEqual(imp.render(*imp.load_all(modules), commit), committed, "web/flow-schema.js is out of date: re-run scripts/import_flow_schema.py")

    def test_committed_file_has_structure_only(self):
        text = (ROOT / "web" / "flow-schema.js").read_text(encoding="utf-8")
        flows = js_json(text, "FLOWS")
        self.assertGreaterEqual(len(flows), 13)
        for f in flows.values():
            self.assertLessEqual(set(f), {"id", "scene", "module", "version", "title", "phases", "questions", "defs", "skipped", "origin", "cat"})
            self.assertLessEqual(set(f.get("cat", {})), {"note", "entity", "pending"})
            self.assertTrue(f["questions"] and f["phases"])
            for p in f["phases"]:
                self.assertLessEqual(set(p), {"id", "name", "short", "slots"})
            self.assertLessEqual(set(f.get("origin", {})), {"q", "label"})
            for q in f["questions"]:
                self.assertLessEqual(set(q), set(imp.QUESTION_KEYS) | {"options", "br"})
                self.assertLessEqual(set(q.get("br", {})), set(imp.BRIDGE_SCALARS) | set(imp.BRIDGE_LISTS))
                for k in imp.BRIDGE_LISTS:  # the option ids the bridge names are the question's own
                    self.assertLessEqual(set(q.get("br", {}).get(k, [])), {o["id"] for o in q.get("options", [])})
                self.assertIn(q["type"], imp.SUPPORTED_TYPES)
                for o in q.get("options", []):
                    self.assertLessEqual(set(o), {"id", "label", "short"})
        # a category is a lower-case word, never prose; where a flow has them (the emergency scene) every question that becomes a record entry has one
        for f in flows.values():
            words = [q["br"]["cat"] for q in f["questions"] if "cat" in q.get("br", {})]
            self.assertTrue(all(re.fullmatch(r"[a-z][a-z_]{0,30}", w) for w in words), f["id"])
            if "cat" in f:
                # the emergency scene (A04) and, since 2026-10-25, the outpatient first visit (A01)
                self.assertEqual((f["scene"], f["cat"]["note"]), {"emergency-department": ("emergency-department", "A04"), "outpatient-first-visit": ("outpatient-first-visit", "A01")}[f["scene"]])
                for q in f["questions"]:
                    if q["br"]["ent"] in f["cat"]["entity"]:
                        self.assertIn("cat", q["br"], (f["id"], q["id"]))
                    else:
                        self.assertNotIn("cat", q["br"], (f["id"], q["id"]))
            else:
                self.assertEqual(words, [], f["id"])  # a scene without a note type in CAT_SCENE_NOTE takes none
        self.assertEqual(sorted(f["id"] for f in flows.values() if "cat" in f), sorted(i for i in flows if i.startswith(("emergency-department.", "outpatient-first-visit."))))
        # the keys are checked above, structurally; the toml tables of the judgement never appear as text either
        for banned in ("[[rule]]", "[[ddx]]", "[[axis]]", "[[fact]]", "[[mark]]", "[[bridge]]", "ddx_slot"):
            self.assertNotIn(banned, text)

if __name__ == "__main__":
    unittest.main()
