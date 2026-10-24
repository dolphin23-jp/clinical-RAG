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

bridge = [
  { q = "age", ent = "context" },
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
        self.assertEqual(list(q), ["age", "sex", "onset", "assoc", "preg", "note"])  # the file's order
        self.assertEqual(q["age"], {"id": "age", "slot": 1, "label": "年齢", "type": "number", "unit": "歳", "core": True})
        self.assertEqual(q["onset"]["options"][0], {"id": "sudden", "label": "突然（秒〜分）", "short": "突然"})
        self.assertEqual(q["onset"]["options"][1], {"id": "gradual", "label": "徐々に"})
        self.assertEqual(q["onset"]["line"], "発症様式：{value}")
        self.assertTrue(q["onset"]["core"] and q["onset"]["required"])
        self.assertEqual(q["assoc"]["exclusive"], ["none"])

    def test_judgement_and_prose_are_not_taken(self):
        text = imp.render(self.flows, self.scenes, "abc")
        for left_out in ("ZZ_SENTINEL_RULE_TEXT", "ZZ_SENTINEL_HINT", "ZZ_SENTINEL_HELP", "ZZ_SENTINEL_DDX", "ZZ_SENTINEL_SCENE_BODY", "ddx_slot", "bridge", '"help"', '"hint"', '"up"', "r1"):
            self.assertNotIn(left_out, text)
        for q in self.flow["questions"]:
            self.assertLessEqual(set(q), set(imp.QUESTION_KEYS) | {"options"})
        # the scene keeps its frames' names and purposes, not their contents
        s = self.scenes[0]
        self.assertEqual(s["frames"], [{"n": 1, "name": "事前情報", "purposes": ["P1", "P3"]}, {"n": 2, "name": "初期評価", "purposes": ["P2"]}, {"n": 3, "name": "病歴", "purposes": ["P1", "P4"]}])

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
            self.assertLessEqual(set(f), {"id", "scene", "module", "version", "title", "phases", "questions", "defs", "skipped"})
            self.assertTrue(f["questions"] and f["phases"])
            for p in f["phases"]:
                self.assertLessEqual(set(p), {"id", "name", "short", "slots"})
            for q in f["questions"]:
                self.assertLessEqual(set(q), set(imp.QUESTION_KEYS) | {"options"})
                self.assertIn(q["type"], imp.SUPPORTED_TYPES)
                for o in q.get("options", []):
                    self.assertLessEqual(set(o), {"id", "label", "short"})
        # the keys are checked above, structurally; the toml tables of the judgement never appear as text either
        for banned in ("[[rule]]", "[[ddx]]", "[[axis]]", "[[fact]]", "[[mark]]", "[[bridge]]", "ddx_slot"):
            self.assertNotIn(banned, text)

if __name__ == "__main__":
    unittest.main()
