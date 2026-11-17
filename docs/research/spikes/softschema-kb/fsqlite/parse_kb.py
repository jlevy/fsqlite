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

Usage: parse_kb.py <kb_dir | delta_dir> <out.jsonl> [--delta] [--jobs N]
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


def record_lines(root: str, rel: str, nodes: list[dict[str, Any]], delta: bool) -> list[str]:
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


def parse_chunk(root: str, items: list[tuple[str, list[dict[str, Any]]]], delta: bool) -> list[str]:
    return [line for rel, nodes in items for line in record_lines(root, rel, nodes, delta)]


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


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("kb")
    ap.add_argument("out")
    ap.add_argument("--delta", action="store_true", help="the input is a W2 delta batch")
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 1)
    args = ap.parse_args()
    started = time.monotonic()
    root = Path(args.kb)
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
        with ProcessPoolExecutor(max_workers=max(1, args.jobs)) as pool:
            lines = pool.map(
                parse_chunk,
                [str(records_root)] * len(chunks),
                chunks,
                [args.delta] * len(chunks),
            )
            for chunk_lines in lines:
                for line in chunk_lines:
                    emit(line, line[7 : line.index('"', 7)])

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
    print(json.dumps(report), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
