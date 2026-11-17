"""
Write the W4 schema-evolution variants of a generated KB, each a complete KB directory
(hard-linked to the base except for changed files, see `overlay.py`):

    <corpus>/evolve/new_kind/kb          a new `award` kind: schema, records, edges
    <corpus>/evolve/add_field/kb         sessions gain an optional `recording_url`
    <corpus>/evolve/rename_relation/kb   the `presents` relation becomes `speaks_at`
    <corpus>/evolve/string_to_object/kb  repository `primary_language` becomes an object

    python evolve.py --corpus $CORPORA/S1 [--cases new_kind add_field ...]

Changed schemas are re-hashed and rendered with softschema's own compiler helpers, so
they look like compiled schemas. Each variant writes `<variant>/manifest.json`.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import random
import re
import sys
import time
from pathlib import Path
from typing import Any

import yaml

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from idmap import DEFAULT_SEED  # noqa: E402
from overlay import materialize  # noqa: E402

from softschema.compile import _schema_sha256, _yaml_dump  # noqa: E402

CASES = ("new_kind", "add_field", "rename_relation", "string_to_object")
_REPLICA = re.compile(r"-r(\d+)$")
_PAYLOAD_ID = re.compile(r"^  id: (\S+)$", re.MULTILINE)
_LANGUAGE = re.compile(r"^  primary_language: (.+)$", re.MULTILINE)
RENAMED = ("presents", "speaks_at")


def _jsonl(path: Path):
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                yield json.loads(line)


def _render_schema(schema: dict[str, Any]) -> bytes:
    schema = copy.deepcopy(schema)
    meta = schema.setdefault("x-softschema", {})
    meta.pop("schema_sha256", None)
    meta["schema_sha256"] = _schema_sha256(schema)
    return _yaml_dump(schema).encode()


def _load_schema(kb: Path, name: str) -> dict[str, Any]:
    return yaml.safe_load((kb / "_schemas" / f"{name}.schema.yaml").read_text(encoding="utf-8"))


def _unit(seed: int, text: str) -> float:
    return int.from_bytes(hashlib.blake2b(f"{seed}:{text}".encode(), digest_size=8).digest()) / 2**64


def new_kind(base: Path, out: Path, seed: int) -> dict[str, Any]:
    """One `award` per 50 people, each awarded to a person at an event of its replica."""
    room = _load_schema(base, "room")
    schema = {
        "$defs": {"Source": room["$defs"]["Source"]},
        "$schema": room["$schema"],
        "additionalProperties": False,
        "description": "A recognition presented to a person at an event.",
        "properties": {
            "category": {"enum": ["community", "innovation", "open_source"], "title": "Category", "type": "string"},
            "citation": {"title": "Citation", "type": "string"},
            "event": {"pattern": r"^(event):[a-z0-9][a-z0-9._/@+-]*$", "title": "Event", "type": "string"},
            "id": {"pattern": r"^(award):[a-z0-9][a-z0-9._/@+-]*$", "title": "Id", "type": "string"},
            "name": {"title": "Name", "type": "string"},
            "recipient": {"pattern": r"^(person):[a-z0-9][a-z0-9._/@+-]*$", "title": "Recipient", "type": "string"},
            "sources": {"items": {"$ref": "#/$defs/Source"}, "title": "Sources", "type": "array"},
            "year": {"title": "Year", "type": "integer"},
        },
        "required": ["category", "event", "id", "name", "recipient", "sources", "year"],
        "title": "Award",
        "type": "object",
        "x-softschema": {"contract": "paraverse.conference:Award/v1"},
    }
    people = sorted(n["id"] for n in _jsonl(base / "_graph" / "nodes.jsonl") if n["kind"] == "person")
    rng = random.Random(f"{seed}:awards")
    chosen = rng.sample(people, max(4, len(people) // 50))
    files: dict[str, bytes] = {"_schemas/award.schema.yaml": _render_schema(schema)}
    nodes, edges = [], []
    categories = ("community", "innovation", "open_source")
    for n, person in enumerate(sorted(chosen)):
        m = _REPLICA.search(person)
        suffix = m.group(0) if m else ""
        year = 2023 + n % 4
        event = f"event:github-universe-{year}{suffix}"
        category = categories[n % 3]
        award_id = f"award:{category.replace('_', '-')}-{year}-{n:06d}"
        name = f"{category.replace('_', ' ').title()} Award {year}"
        path = f"awards/{award_id.split(':', 1)[1]}.yaml"
        doc = {
            "softschema": {
                "contract": "paraverse.conference:Award/v1",
                "schema": "../_schemas/award.schema.yaml",
                "envelope": "award",
                "status": "enforced",
            },
            "award": {
                "id": award_id,
                "name": name,
                "category": category,
                "recipient": person,
                "event": event,
                "year": year,
                "citation": f"Recognized at GitHub Universe {year} for {category.replace('_', ' ')} work.",
                "sources": [{"system": "curation"}],
            },
        }
        files[path] = yaml.safe_dump(doc, sort_keys=False, allow_unicode=True, width=100).encode()
        nodes.append({"id": award_id, "kind": "award", "name": name, "path": path})
        edges.append({"source": award_id, "relation": "awarded_to", "target": person})
        edges.append({"source": award_id, "relation": "presented_at", "target": event})
    report = materialize(base, out, extra_files=files, add_nodes=nodes, add_edges=edges)
    return {**report, "awards": len(nodes), "new_edges": len(edges)}


def add_field(base: Path, out: Path, seed: int) -> dict[str, Any]:
    """Add optional `recording_url` to the session schema and to 30% of sessions."""
    schema = _load_schema(base, "session")
    schema["properties"]["recording_url"] = {
        "anyOf": [{"pattern": "^https?://", "type": "string"}, {"type": "null"}],
        "default": None,
        "description": "Where the session recording can be watched.",
        "title": "Recording Url",
    }
    files = {"_schemas/session.schema.yaml": _render_schema(schema)}
    changed = 0
    for row in _jsonl(base / "_graph" / "nodes.jsonl"):
        if row["kind"] != "session" or _unit(seed, row["id"]) >= 0.3:
            continue
        text = (base / row["path"]).read_bytes().decode("utf-8")
        m = _PAYLOAD_ID.search(text)
        if m is None:
            raise ValueError(f"{row['path']}: no payload id line")
        slug = row["id"].split(":", 1)[1].replace("/", "-")
        line = f"\n  recording_url: https://videos.example.org/universe/{slug}"
        files[row["path"]] = (text[: m.end()] + line + text[m.end() :]).encode()
        changed += 1
    report = materialize(base, out, extra_files=files)
    return {**report, "sessions_changed": changed}


def rename_relation(base: Path, out: Path, seed: int) -> dict[str, Any]:
    """Rename `presents` to `speaks_at` in the graph export; records are unchanged."""
    old, new = RENAMED

    def rename(row: dict[str, Any]) -> dict[str, Any]:
        if row["relation"] == old:
            row["relation"] = new
        return row

    report = materialize(base, out, edge_map=rename)
    return {**report, "renamed": f"{old} -> {new}"}


def string_to_object(base: Path, out: Path, seed: int) -> dict[str, Any]:
    """Repository `primary_language: X` becomes `{name: X, source: github-linguist}`."""
    schema = _load_schema(base, "repository")
    schema["$defs"]["Language"] = {
        "additionalProperties": False,
        "description": "A repository's primary language, with where it came from.",
        "properties": {
            "name": {"title": "Name", "type": "string"},
            "source": {"title": "Source", "type": "string"},
        },
        "required": ["name", "source"],
        "title": "Language",
        "type": "object",
    }
    schema["properties"]["primary_language"] = {
        "anyOf": [{"$ref": "#/$defs/Language"}, {"type": "null"}],
        "default": None,
        "title": "Primary Language",
    }
    files = {"_schemas/repository.schema.yaml": _render_schema(schema)}
    changed = 0
    for row in _jsonl(base / "_graph" / "nodes.jsonl"):
        if row["kind"] != "repository":
            continue
        text = (base / row["path"]).read_bytes().decode("utf-8")
        new_text, n = _LANGUAGE.subn(
            lambda m: f"  primary_language:\n    name: {m.group(1)}\n    source: github-linguist", text, count=1
        )
        if n:
            files[row["path"]] = new_text.encode()
            changed += 1
    report = materialize(base, out, extra_files=files)
    return {**report, "repositories_changed": changed}


RUNNERS = {
    "new_kind": new_kind,
    "add_field": add_field,
    "rename_relation": rename_relation,
    "string_to_object": string_to_object,
}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--corpus", type=Path, required=True, help="the directory holding kb/")
    ap.add_argument("--cases", nargs="+", default=list(CASES), choices=CASES)
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    args = ap.parse_args()
    for case in args.cases:
        started = time.monotonic()
        out = args.corpus / "evolve" / case
        report = RUNNERS[case](args.corpus / "kb", out / "kb", args.seed)
        report["seconds"] = round(time.monotonic() - started, 2)
        report["case"] = case
        (out / "manifest.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report))


if __name__ == "__main__":
    main()
