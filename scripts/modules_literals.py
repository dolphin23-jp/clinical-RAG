"""Read plain literals (and the ROUTES table) out of a clinical-modules checkout without running its code.

The importers (import_flow_schema.py, import_note_types.py) borrow structure from the training repository.  Two pieces of that structure
live in Python files there, not in TOML: the routing table `ROUTES` (scripts/note_expanded.py: which record entries go to which field of
a chart-note type) and the declarations that say which scenes carry a routing category (scripts/flow.py: CAT_SCENE_NOTE, BRIDGE_CAT_ENTITY,
BRIDGE_CAT_PENDING).  They are read with `ast.literal_eval`, so nothing of the other repository is executed, and anything that is not a plain
literal (a call, a name, an f-string) is refused.

ROUTES' values are strings like "patient_context:hpi;observation:hpi" -> {"patient_context": ["hpi"], "observation": ["hpi"]}.  Only entity
names and category names (lower-case words) are accepted: prose or anything else stops the import.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

#: the common entities of the training repository's note model (docs/note-common-schema.md there)
ENTITIES = {"encounter", "patient_context", "observation", "problem", "assessment", "action", "communication", "decision", "task"}
CATEGORY = re.compile(r"^(?:\*|[a-z][a-z_]{0,30})$")
NOTE_ID = re.compile(r"^[A-Z][0-9]{2}$")
SECTION_KEY = re.compile(r"^[a-z][a-z_]{0,30}$")


def read_literal(path: Path, name: str):
    """The value of the top-level assignment `name = <literal>` in a Python file (parsed, never run)."""
    path = Path(path)
    if not path.is_file():
        raise SystemExit(f"{path}: not found")
    for node in ast.parse(path.read_text(encoding="utf-8")).body:
        targets = node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, ast.AnnAssign) and node.value else []
        if any(isinstance(t, ast.Name) and t.id == name for t in targets):
            try:
                return ast.literal_eval(node.value)
            except (ValueError, SyntaxError):
                raise SystemExit(f"{path.name}: {name} is not a plain literal") from None
    raise SystemExit(f"{path.name}: no top-level {name}")


def parse_selector(spec: str, where: str) -> dict[str, list[str]]:
    """"entity:cat,cat;entity:cat" -> {entity: [cat, ...]} (an empty spec is a field nothing routes to)."""
    if not isinstance(spec, str):
        raise SystemExit(f"{where}: a route must be a string")
    out: dict[str, list[str]] = {}
    for token in [t for t in spec.split(";") if t != ""] if spec else []:
        entity, sep, cats = token.partition(":")
        if not sep or entity not in ENTITIES:
            raise SystemExit(f"{where}: {token!r} is not entity:categories with a known entity")
        names = cats.split(",")
        if not names or any(not CATEGORY.match(c) for c in names):
            raise SystemExit(f"{where}: {token!r} has a category that is not a lower-case word")
        if entity in out:
            raise SystemExit(f"{where}: entity {entity} appears twice")
        out[entity] = names
    return out


def load_routes(modules: Path) -> dict[str, dict[str, dict[str, list[str]]]]:
    """ROUTES of scripts/note_expanded.py as {note type: {field key: {entity: [categories]}}}, fields in the file's order."""
    raw = read_literal(Path(modules) / "scripts" / "note_expanded.py", "ROUTES")
    if not isinstance(raw, dict) or not raw:
        raise SystemExit("note_expanded.py: ROUTES must be a non-empty dict")
    out = {}
    for note, sections in raw.items():
        if not isinstance(note, str) or not NOTE_ID.match(note) or not isinstance(sections, dict) or not sections:
            raise SystemExit(f"note_expanded.py: ROUTES[{note!r}] must be a note type id with a dict of fields")
        out[note] = {}
        for key, spec in sections.items():
            if not isinstance(key, str) or not SECTION_KEY.match(key):
                raise SystemExit(f"note_expanded.py: ROUTES[{note}] has a field key that is not a lower-case word: {key!r}")
            out[note][key] = parse_selector(spec, f"ROUTES[{note}][{key}]")
    return out


def load_cat_context(modules: Path):
    """The declarations of scripts/flow.py that say where a flow's question categories apply, or None when the checkout has no scripts/flow.py.

    {scene: note type} (CAT_SCENE_NOTE), {bridge ent: entity} (BRIDGE_CAT_ENTITY), the word for "not classified yet" (BRIDGE_CAT_PENDING),
    and the routes of the note types that a scene points to ({note: {entity: {category: field}}}).
    """
    flow_py = Path(modules) / "scripts" / "flow.py"
    if not flow_py.is_file():
        return None
    scene_note = read_literal(flow_py, "CAT_SCENE_NOTE")
    ent_entity = read_literal(flow_py, "BRIDGE_CAT_ENTITY")
    pending = read_literal(flow_py, "BRIDGE_CAT_PENDING")
    if not (isinstance(scene_note, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in scene_note.items())):
        raise SystemExit("flow.py: CAT_SCENE_NOTE must be {scene: note type}")
    if not (isinstance(ent_entity, dict) and all(v in ENTITIES for v in ent_entity.values())):
        raise SystemExit("flow.py: BRIDGE_CAT_ENTITY must map bridge ents to known entities")
    if not (isinstance(pending, str) and CATEGORY.match(pending)):
        raise SystemExit("flow.py: BRIDGE_CAT_PENDING must be a lower-case word")
    routes = load_routes(modules)
    by_note = {}
    for note in sorted(set(scene_note.values())):
        if note not in routes:
            raise SystemExit(f"flow.py: CAT_SCENE_NOTE names {note}, which note_expanded.py's ROUTES does not have")
        index: dict[tuple[str, str], str] = {}
        for field, rules in routes[note].items():
            for entity, cats in rules.items():
                for c in cats:
                    if c == "*":
                        continue
                    if (entity, c) in index:
                        raise SystemExit(f"ROUTES[{note}]: {entity}:{c} goes to both {index[(entity, c)]} and {field}; an answer must land in one field")
                    index[(entity, c)] = field
        by_note[note] = index
    return {"scene_note": dict(scene_note), "ent_entity": dict(ent_entity), "pending": pending, "index": by_note}
