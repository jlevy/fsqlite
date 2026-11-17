"""
Parse a softschema KB directory, or a W2 delta batch, into one intermediate JSONL file.

Node has no YAML parser, so this pass reads every record (Markdown frontmatter or YAML),
the compiled schemas, and the `_graph` export, and writes typed lines that the Node
importer streams into fsqlite. Its wall time counts toward W1 import time. Worker
processes parse records in parallel and the output is streamed in path order, so memory
stays bounded at large scales.

Line types, in this order:
  {"t": "schema", "kind", "file", "schema"}          compiled schema, JSON text
  {"t": "file", "path", "text"}                       an opaque file kept byte for byte
  {"t": "line", "path", "n", "text"}                  one line of an opaque .jsonl file
  {"t": "node", "id", "kind", "name", "path"}         every graph node, before any entity
  {"t": "doc", "path", "format", "envelope", "owner", "head", "body"}
  {"t": "entity", "id", "kind", "name", "path", "payload"[, "update": true]}
  {"t": "edge", "source", "relation", "target", "ord", "props"}

`payload`, `head`, `props` and `schema` are JSON text produced here, so Node stores
Python's exact serialization and never re-encodes numbers. `head` is the document's
top-level mapping with the owning entity's payload replaced by null, so export can
rebuild the document in its original key order.

A delta batch (`--delta`, the layout corpus/delta.py writes) holds `records/`,
`nodes.jsonl` and `edges.jsonl` for its new records. A record that no new node owns is
an update to an existing entity: its entity line has `"update": true`, and the importer
keeps the stored kind, name and path.

A diff (`--diff <base_kb>`) compares a changed KB with its base: files whose inode or
bytes differ are parsed again, and the graph export is diffed row by row. Removals come
first as {"t": "unedge" | "unentity" | "undoc" | "unline", ...} lines, so the importer can
apply a whole schema-evolution variant as one data-only transaction.

A v2 batch (`--delta2 <base_kb>`, the softschema-kb-delta/v2 format of corpus/delta2.py)
becomes `op` lines (upsert, delete, merge) in ops.jsonl order, each followed by the rows
it writes. Upserted records are checked against the base KB's compiled schemas; a record
that fails becomes an `invalid` line and its op is skipped (quarantined). `--validate`
runs the same check over a whole KB and reports it as a timed phase.

Usage: parse_kb.py <kb_dir | delta_dir> <out.jsonl>
       [--delta | --diff <base_kb> | --delta2 <base_kb>] [--validate] [--jobs N]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections import defaultdict
from collections.abc import Iterator
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Any

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "corpus"))
from safepath import rel_path  # noqa: E402

_FRONTMATTER = re.compile(r"\A---\n(.*?)\n---[ \t]*(?:\n|\Z)", re.DOTALL)
_TIMESTAMP_TAG = "tag:yaml.org,2002:timestamp"
_BaseLoader: type[yaml.SafeLoader] = getattr(yaml, "CSafeLoader", yaml.SafeLoader)

GRAPH_FILES = {"_graph/nodes.jsonl", "_graph/edges.jsonl"}
SCHEMA_DIR = "_schemas"
RECORD_SUFFIXES = (".md", ".yaml", ".yml")


class PortableLoader(_BaseLoader):
    """Keep date- and timestamp-shaped scalars as strings, as softschema does."""


PortableLoader.yaml_implicit_resolvers = {
    first: [(tag, rx) for tag, rx in resolvers if tag != _TIMESTAMP_TAG]
    for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def admitted(value: Any, what: str) -> str:
    """A batch path that stays under its root (corpus/safepath.py), or exit naming it."""
    try:
        return rel_path(value, what)
    except ValueError as exc:
        raise SystemExit(f"refusing the batch: {exc}") from None


def read_text(path: Path) -> str:
    # Decode the bytes directly: text mode would translate \r\n inside Markdown bodies.
    return path.read_bytes().decode("utf-8")


def parse_document(text: str, rel: str) -> tuple[dict[str, Any], str | None] | None:
    """A softschema record's YAML mapping and Markdown body, or None for other files."""
    match = _FRONTMATTER.match(text) if rel.endswith(".md") else None
    if rel.endswith(".md") and not match:
        return None
    try:
        data = yaml.load(match.group(1) if match else text, Loader=PortableLoader)
    except yaml.YAMLError:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("softschema"), dict):
        return None
    return data, (text[match.end() :] if match else None)


def find_by_id(value: Any, wanted: str) -> dict[str, Any] | None:
    if isinstance(value, dict):
        if value.get("id") == wanted:
            return value
        children = list(value.values())
    elif isinstance(value, list):
        children = value
    else:
        return None
    for child in children:
        found = find_by_id(child, wanted)
        if found is not None:
            return found
    return None


def owns(payload: Any, node: dict[str, Any]) -> bool:
    """paraverse's rule: a node owns its artifact when the payload id names it."""
    own = payload.get("id") if isinstance(payload, dict) else None
    return isinstance(own, str) and (own == node["id"] or f"{node['kind']}:{own}" == node["id"])


def _type_ok(value: Any, kind: str) -> bool:
    if kind == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if kind == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    expected = {"string": str, "boolean": bool, "array": list, "object": dict}.get(kind)
    return value is None if kind == "null" else expected is not None and isinstance(value, expected)


def schema_errors(value: Any, schema: dict[str, Any], root: dict[str, Any], at: str = "$") -> list[str]:
    """
    The JSON Schema keywords the compiled softschema schemas use: $ref to $defs, anyOf,
    oneOf, allOf, type, enum, const, pattern, length and range bounds, items, required,
    properties and additionalProperties. Formats are not checked.
    """
    errors: list[str] = []
    ref = schema.get("$ref")
    if isinstance(ref, str) and ref.startswith("#/$defs/"):
        errors += schema_errors(value, root["$defs"][ref.rsplit("/", 1)[-1]], root, at)
    for key in ("anyOf", "oneOf"):
        if key in schema and not any(not schema_errors(value, s, root, at) for s in schema[key]):
            errors.append(f"{at}: matches no {key} branch")
    for sub in schema.get("allOf", []):
        errors += schema_errors(value, sub, root, at)
    kinds = schema.get("type")
    if kinds is not None:
        if not any(_type_ok(value, k) for k in (kinds if isinstance(kinds, list) else [kinds])):
            return [*errors, f"{at}: expected {kinds}"]
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{at}: not one of the enum values")
    if "const" in schema and value != schema["const"]:
        errors.append(f"{at}: not the const value")
    if isinstance(value, str):
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append(f"{at}: does not match {schema['pattern']}")
        if len(value) < schema.get("minLength", 0) or len(value) > schema.get("maxLength", len(value)):
            errors.append(f"{at}: length out of bounds")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{at}: below minimum")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{at}: above maximum")
    if isinstance(value, list):
        if isinstance(schema.get("items"), dict):
            for i, item in enumerate(value):
                errors += schema_errors(item, schema["items"], root, f"{at}[{i}]")
        if len(value) < schema.get("minItems", 0):
            errors.append(f"{at}: too few items")
    if isinstance(value, dict):
        props = schema.get("properties", {})
        for name in schema.get("required", []):
            if name not in value:
                errors.append(f"{at}: missing required {name}")
        extra = schema.get("additionalProperties", True)
        for name, item in value.items():
            if name in props:
                errors += schema_errors(item, props[name], root, f"{at}.{name}")
            elif extra is False:
                errors.append(f"{at}: unexpected property {name} (additionalProperties: false)")
            elif isinstance(extra, dict):
                errors += schema_errors(item, extra, root, f"{at}.{name}")
    return errors


_SCHEMA_CACHE: dict[str, dict[str, Any] | None] = {}
VALIDATION = {"seconds": 0.0, "checked": 0, "invalid": []}


def payload_errors(schemas_dir: str, envelope: str, payload: Any) -> list[str]:
    """Validate an envelope payload against its kind's compiled schema, timing the check."""
    started = time.monotonic()
    path = Path(schemas_dir) / f"{envelope.replace('_', '-')}.schema.yaml"
    key = str(path)
    if key not in _SCHEMA_CACHE:
        _SCHEMA_CACHE[key] = (
            yaml.load(read_text(path), Loader=PortableLoader) if path.is_file() else None
        )
    schema = _SCHEMA_CACHE[key]
    errors = [] if schema is None else schema_errors(payload, schema, schema)
    VALIDATION["seconds"] += time.monotonic() - started
    VALIDATION["checked"] += 1
    return errors


def record_lines(
    root: str,
    rel: str,
    nodes: list[dict[str, Any]],
    delta: bool,
    schemas_dir: str | None = None,
) -> list[str]:
    """The doc line and entity lines for one file, or a file line for a non-record."""
    text = read_text(Path(root) / rel)
    parsed = parse_document(text, rel) if rel.endswith(RECORD_SUFFIXES) else None
    if parsed is None:
        return [dumps({"t": "file", "path": rel, "text": text})]
    data, body = parsed
    envelope = data["softschema"].get("envelope")
    if not isinstance(envelope, str):
        candidates = [k for k in data if k != "softschema"]
        envelope = candidates[0] if len(candidates) == 1 else None
    payload = data.get(envelope) if envelope else None
    if schemas_dir and isinstance(envelope, str) and isinstance(payload, dict):
        errors = payload_errors(schemas_dir, envelope, payload)
        if errors:
            VALIDATION["invalid"].append({"path": rel, "id": payload.get("id"), "errors": errors[:5]})
    owner = next((n["id"] for n in nodes if owns(payload, n)), None)
    entities = []
    for node in nodes:
        value = payload if node["id"] == owner else find_by_id(payload, node["id"])
        if value is None:
            raise SystemExit(f"{node['id']}: no payload in {rel}")
        entities.append({"t": "entity", **node, "payload": dumps(value)})
    if delta and owner is None and isinstance(payload, dict) and isinstance(payload.get("id"), str):
        # A changed record of an existing entity: the importer keeps its graph node.
        owner = payload["id"]
        entities.append(
            {
                "t": "entity",
                "id": owner,
                "kind": envelope,
                "name": None,
                "path": rel,
                "payload": dumps(payload),
                "update": True,
            }
        )
    head = dict(data)
    if owner is not None:
        head[envelope] = None
    doc = {
        "t": "doc",
        "path": rel,
        "format": "md" if body is not None else "yaml",
        "envelope": envelope,
        "owner": owner,
        "head": dumps(head),
        "body": body,
    }
    return [dumps(doc), *(dumps(e) for e in entities)]


def parse_chunk(
    root: str,
    items: list[tuple[str, list[dict[str, Any]]]],
    delta: bool,
    schemas_dir: str | None = None,
) -> tuple[list[str], dict[str, Any]]:
    VALIDATION.update(seconds=0.0, checked=0, invalid=[])
    lines = [line for rel, nodes in items for line in record_lines(root, rel, nodes, delta, schemas_dir)]
    return lines, dict(VALIDATION)


def read_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    with open(path, encoding="utf-8", newline="") as fh:
        for line in fh:
            if line.strip():
                yield json.loads(line)


def edges_sorted(path: Path) -> bool:
    prev: tuple[str, str, str] | None = None
    for edge in read_jsonl(path):
        key = (edge["source"], edge["relation"], edge["target"])
        if prev is not None and key < prev:
            return False
        prev = key
    return True


def list_files(root: Path) -> list[str]:
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in filenames:
            files.append(os.path.relpath(os.path.join(dirpath, name), root).replace(os.sep, "/"))
    return sorted(files)


def changed_files(base: Path, variant: Path) -> tuple[list[str], list[str]]:
    """Files of `variant` that differ from `base` (new inode and new bytes), and removed ones."""
    a, b = set(list_files(base)), set(list_files(variant))
    changed = []
    for rel in sorted(b):
        if rel not in a:
            changed.append(rel)
            continue
        sa, sb = (base / rel).stat(), (variant / rel).stat()
        if (sa.st_dev, sa.st_ino) == (sb.st_dev, sb.st_ino):
            continue
        if sa.st_size != sb.st_size or (base / rel).read_bytes() != (variant / rel).read_bytes():
            changed.append(rel)
    return changed, sorted(a - b)


def keyed_edges(path: Path) -> dict[tuple[str, str, str, int], str | None]:
    """Every edge by (source, relation, target, ord), with its props as JSON text."""
    out: dict[tuple[str, str, str, int], str | None] = {}
    seen: dict[tuple[str, str, str], int] = {}
    for edge in read_jsonl(path):
        key = (edge.pop("source"), edge.pop("relation"), edge.pop("target"))
        ord_ = seen.get(key, 0)
        seen[key] = ord_ + 1
        out[(*key, ord_)] = dumps(edge) if edge else None
    return out


def emit_diff(base: Path, root: Path, emit: Any, jobs: int) -> None:
    changed, removed = changed_files(base, root)
    graph = {"_graph/nodes.jsonl", "_graph/edges.jsonl"}
    base_nodes = {n["id"]: n for n in read_jsonl(base / "_graph" / "nodes.jsonl")}
    nodes = {n["id"]: n for n in read_jsonl(root / "_graph" / "nodes.jsonl")}
    old_edges = keyed_edges(base / "_graph" / "edges.jsonl")
    new_edges = keyed_edges(root / "_graph" / "edges.jsonl")
    for key, props in old_edges.items():
        if key not in new_edges or new_edges[key] != props:
            emit(dumps({"t": "unedge", "source": key[0], "relation": key[1], "target": key[2], "ord": key[3]}), "unedge")
    for nid in sorted(set(base_nodes) - set(nodes)):
        emit(dumps({"t": "unentity", "id": nid}), "unentity")
    for rel in removed:
        emit(dumps({"t": "undoc", "path": rel}), "undoc")
    for rel in changed:
        if rel in graph:
            continue
        if rel.startswith(SCHEMA_DIR + "/"):
            kind = rel.removeprefix(SCHEMA_DIR + "/").removesuffix(".schema.yaml").replace("-", "_")
            schema = yaml.load(read_text(root / rel), Loader=PortableLoader)
            emit(dumps({"t": "schema", "kind": kind, "file": rel, "schema": dumps(schema)}), "schema")
        elif rel.endswith(".jsonl"):
            with open(root / rel, encoding="utf-8", newline="") as fh:
                n = -1
                for n, text in enumerate(fh):
                    emit(dumps({"t": "line", "path": rel, "n": n, "text": text}), "line")
            emit(dumps({"t": "unline", "path": rel, "from": n + 1}), "unline")
    by_path: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for n in nodes.values():
        node = {"id": n["id"], "kind": n["kind"], "name": n.get("name"), "path": n["path"]}
        by_path[node["path"]].append(node)
        if n["id"] not in base_nodes:
            emit(dumps({"t": "node", **node}), "node")
    records = [r for r in changed if r not in graph and not r.startswith(SCHEMA_DIR + "/") and not r.endswith(".jsonl")]
    lines, _ = parse_chunk(str(root), [(rel, by_path.get(rel, [])) for rel in records], False)
    for line in lines:
        emit(line, line[7 : line.index('"', 7)])
    for key, props in new_edges.items():
        if key not in old_edges or old_edges[key] != props:
            row = {"t": "edge", "source": key[0], "relation": key[1], "target": key[2]}
            emit(dumps({**row, "ord": key[3], "props": props}), "edge")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("kb")
    ap.add_argument("out")
    ap.add_argument("--delta", action="store_true", help="the input is a W2 delta batch")
    ap.add_argument("--diff", help="emit only the changes from this base KB")
    ap.add_argument("--delta2", help="the input is a v2 batch; validate against this KB's _schemas")
    ap.add_argument("--validate", action="store_true", help="check every record against its schema")
    ap.add_argument("--no-validate", action="store_true", help="with --delta2: load without the check")
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 1)
    args = ap.parse_args()
    started = time.monotonic()
    root = Path(args.kb)
    if args.delta2:
        counts2: dict[str, int] = defaultdict(int)
        with open(args.out, "w", encoding="utf-8", newline="") as out:

            def emit2(line: str, kind: str) -> None:
                counts2[kind] += 1
                out.write(line + "\n")

            schemas = None if args.no_validate else str(Path(args.delta2) / SCHEMA_DIR)
            info = emit_delta2(root, schemas, emit2)
        report = {
            "seconds": round(time.monotonic() - started, 3),
            "counts": counts2,
            "validation_seconds": round(VALIDATION["seconds"], 3),
            "validated": VALIDATION["checked"],
            **info,
        }
        print(json.dumps(report), file=sys.stderr)
        return 0
    if args.diff:
        counts_diff: dict[str, int] = defaultdict(int)
        with open(args.out, "w", encoding="utf-8", newline="") as out:

            def emit_line(line: str, kind: str) -> None:
                counts_diff[kind] += 1
                out.write(line + "\n")

            emit_diff(Path(args.diff), root, emit_line, args.jobs)
        report = {"seconds": round(time.monotonic() - started, 3), "counts": counts_diff}
        print(json.dumps(report), file=sys.stderr)
        return 0
    records_root = root / "records" if args.delta else root
    nodes_path = root / "nodes.jsonl" if args.delta else root / "_graph" / "nodes.jsonl"
    edges_path = root / "edges.jsonl" if args.delta else root / "_graph" / "edges.jsonl"

    files = list_files(records_root)
    schema_files = [] if args.delta else [f for f in files if f.startswith(SCHEMA_DIR + "/")]
    skip = GRAPH_FILES | set(schema_files)
    record_files = [f for f in files if f not in skip and not f.endswith(".jsonl")]
    line_files = [f for f in files if f not in skip and f.endswith(".jsonl")]

    nodes_by_path: dict[str, list[dict[str, Any]]] = defaultdict(list)
    counts: dict[str, int] = defaultdict(int)
    with open(args.out, "w", encoding="utf-8", newline="") as out:

        def emit(line: str, kind: str) -> None:
            counts[kind] += 1
            out.write(line)
            out.write("\n")

        for rel in schema_files:
            kind = rel.removeprefix(SCHEMA_DIR + "/").removesuffix(".schema.yaml").replace("-", "_")
            schema = yaml.load(read_text(records_root / rel), Loader=PortableLoader)
            emit(dumps({"t": "schema", "kind": kind, "file": rel, "schema": dumps(schema)}), "schema")
        for rel in line_files:
            with open(records_root / rel, encoding="utf-8", newline="") as fh:
                for n, text in enumerate(fh):
                    emit(dumps({"t": "line", "path": rel, "n": n, "text": text}), "line")
        for row in read_jsonl(nodes_path):
            node = {"id": row["id"], "kind": row["kind"], "name": row.get("name"), "path": row["path"]}
            nodes_by_path[node["path"]].append(node)
            emit(dumps({"t": "node", **node}), "node")
        missing = sorted(set(nodes_by_path) - set(record_files))
        if missing:
            raise SystemExit(f"{len(missing)} graph nodes point at missing files: {missing[:3]}")

        items = [(rel, nodes_by_path.get(rel, [])) for rel in record_files]
        size = max(1, min(500, len(items) // (args.jobs * 8) + 1))
        chunks = [items[i : i + size] for i in range(0, len(items), size)]
        schemas = str(records_root / SCHEMA_DIR) if args.validate else None
        validation = {"seconds": 0.0, "checked": 0, "invalid": []}
        with ProcessPoolExecutor(max_workers=max(1, args.jobs)) as pool:
            results = pool.map(
                parse_chunk,
                [str(records_root)] * len(chunks),
                chunks,
                [args.delta] * len(chunks),
                [schemas] * len(chunks),
            )
            for chunk_lines, v in results:
                for line in chunk_lines:
                    emit(line, line[7 : line.index('"', 7)])
                validation["seconds"] += v["seconds"]
                validation["checked"] += v["checked"]
                validation["invalid"] += v["invalid"]

        # `ord` numbers parallel edges in file order. A sorted export (the KB build sorts
        # it) needs only the previous key; an unsorted one needs a dictionary of keys.
        seen: dict[tuple[str, str, str], int] | None = None if edges_sorted(edges_path) else {}
        prev: tuple[str, str, str] | None = None
        ord_ = 0
        for edge in read_jsonl(edges_path):
            key = (edge.pop("source"), edge.pop("relation"), edge.pop("target"))
            if seen is not None:
                ord_ = seen.get(key, 0)
                seen[key] = ord_ + 1
            else:
                ord_ = ord_ + 1 if key == prev else 0
                prev = key
            row = {"t": "edge", "source": key[0], "relation": key[1], "target": key[2]}
            emit(dumps({**row, "ord": ord_, "props": dumps(edge) if edge else None}), "edge")

    report = {"seconds": round(time.monotonic() - started, 3), "jobs": args.jobs, "counts": counts}
    if args.validate:
        report["validation"] = {
            "cpu_seconds_summed_over_workers": round(validation["seconds"], 3),
            "checked": validation["checked"],
            "invalid": len(validation["invalid"]),
            "invalid_samples": validation["invalid"][:5],
            "validator": "parse_kb.py schema_errors (stdlib subset of JSON Schema; formats unchecked)",
        }
    print(json.dumps(report), file=sys.stderr)
    return 0


def emit_delta2(batch: Path, schemas_dir: str | None, emit: Any) -> dict[str, Any]:
    """
    A softschema-kb-delta/v2 batch, in ops.jsonl line order. Each op becomes an `op` line
    followed by the rows it writes; an upserted record that fails its schema becomes an
    `invalid` line instead, and its op is skipped, so the rest of the batch still applies.
    """
    ops = list(read_jsonl(batch / "ops.jsonl"))
    # Admission: every path a batch names stays under the KB root, checked before any read.
    for n, op in enumerate(ops, 1):
        for key in ("path", "absorbed_path", "survivor_path"):
            if key in op:
                admitted(op[key], f"ops.jsonl line {n}: {key}")
        for node in op.get("nodes", []):
            admitted(node.get("path"), f"ops.jsonl line {n}: node path")
        if op.get("op") == "upsert" and (batch / "records" / op["path"]).is_symlink():
            raise SystemExit(f"ops.jsonl line {n}: records/{op['path']} is a symbolic link")
    for op in ops:
        for node in op.get("nodes", []):
            emit(dumps({"t": "node", **{k: node.get(k) for k in ("id", "kind", "name", "path")}}), "node")
    quarantined = []
    for op in ops:
        kind = op["op"]
        if kind == "upsert":
            VALIDATION["invalid"] = []
            nodes = [{k: n.get(k) for k in ("id", "kind", "name", "path")} for n in op["nodes"]]
            lines = record_lines(str(batch / "records"), op["path"], nodes, False, schemas_dir)
            if VALIDATION["invalid"]:
                bad = VALIDATION["invalid"][0]
                quarantined.append(bad)
                emit(dumps({"t": "invalid", "op": "upsert", **bad}), "invalid")
                continue
            emit(dumps({"t": "op", "op": "upsert", "path": op["path"], "node_ids": [n["id"] for n in nodes]}), "op")
            for line in lines:
                emit(line, line[7 : line.index('"', 7)])
            for e in op["edges"]:
                props = {k: v for k, v in e.items() if k not in ("source", "relation", "target")}
                row = {"t": "edge", "source": e["source"], "relation": e["relation"], "target": e["target"]}
                emit(dumps({**row, "ord": None, "props": dumps(props) if props else None}), "edge")
        elif kind == "delete":
            emit(dumps({"t": "op", "op": "delete", "path": op["path"], "node_ids": op["node_ids"]}), "op")
        elif kind == "merge":
            keys = ("absorbed", "survivor", "absorbed_path", "survivor_path")
            emit(dumps({"t": "op", "op": "merge", **{k: op[k] for k in keys}}), "op")
        else:
            raise SystemExit(f"unknown op {kind}")
    return {"ops": len(ops), "quarantined": quarantined}


if __name__ == "__main__":
    sys.exit(main())
