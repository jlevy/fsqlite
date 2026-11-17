"""
Materialize a KB variant cheaply: hard-link every file of a base KB, then overlay
changed files and rewrite the graph export.

Hard links make a 250k-file variant cost only its changed files. Every write here
replaces a link with a new file (unlink, then write), so the base KB is never modified.

    python overlay.py --base $CORPORA/S1/kb --delta $CORPORA/S1/deltas/p05 --out DIR

applies a W2 delta batch (records/, nodes.jsonl, edges.jsonl, search.jsonl) to a base.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import time
from collections import Counter
from collections.abc import Callable, Iterable, Iterator
from pathlib import Path
from typing import Any

GRAPH_FILES = ("_graph/nodes.jsonl", "_graph/edges.jsonl", "_graph/stats.json")
SEARCH_FILE = "_search/documents.jsonl"


def link_tree(base: Path, out: Path, skip: Iterable[str] = ()) -> int:
    skipped = set(skip)
    count = 0
    for dirpath, _, filenames in os.walk(base):
        rel_dir = os.path.relpath(dirpath, base)
        target_dir = out / rel_dir
        target_dir.mkdir(parents=True, exist_ok=True)
        for name in filenames:
            rel = os.path.normpath(os.path.join(rel_dir, name))
            if rel in skipped:
                continue
            os.link(os.path.join(dirpath, name), target_dir / name)
            count += 1
    return count


def put(out: Path, rel: str, data: bytes) -> None:
    """Write a file in the variant without touching a hard-linked base file."""
    dest = out / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()
    dest.write_bytes(data)


def _jsonl(path: Path) -> Iterator[dict[str, Any]]:
    if not path.is_file():
        return
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                yield json.loads(line)


def dumps(row: dict[str, Any]) -> str:
    return json.dumps(row, ensure_ascii=False)


def materialize(
    base: Path,
    out: Path,
    *,
    records: Path | None = None,
    extra_files: dict[str, bytes] | None = None,
    add_nodes: Iterable[dict[str, Any]] = (),
    add_edges: Iterable[dict[str, Any]] = (),
    add_search: Iterable[dict[str, Any]] = (),
    edge_map: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """
    Build `out` from `base`: links, then `records/` files overlaid at their KB paths,
    then `extra_files`, then the graph export (base rows, mapped, plus added rows) and a
    recomputed stats.json.
    """
    started = time.monotonic()
    if out.exists():
        shutil.rmtree(out)
    linked = link_tree(base, out, skip=(*GRAPH_FILES, SEARCH_FILE))
    overlaid = 0
    if records is not None and records.is_dir():
        for path in records.rglob("*"):
            if path.is_file():
                put(out, str(path.relative_to(records)), path.read_bytes())
                overlaid += 1
    for rel, data in (extra_files or {}).items():
        put(out, rel, data)
        overlaid += 1

    node_counts: Counter[str] = Counter()
    with (out / "_graph" / "nodes.jsonl").open("w", encoding="utf-8") as fh:
        for row in _chain(_jsonl(base / "_graph" / "nodes.jsonl"), add_nodes):
            node_counts[row["kind"]] += 1
            fh.write(dumps(row) + "\n")
    edge_counts: Counter[str] = Counter()
    with (out / "_graph" / "edges.jsonl").open("w", encoding="utf-8") as fh:
        for row in _jsonl(base / "_graph" / "edges.jsonl"):
            row = edge_map(row) if edge_map else row
            edge_counts[row["relation"]] += 1
            fh.write(dumps(row) + "\n")
        for row in add_edges:
            edge_counts[row["relation"]] += 1
            fh.write(dumps(row) + "\n")
    (out / "_search").mkdir(exist_ok=True)
    with (out / SEARCH_FILE).open("w", encoding="utf-8") as fh:
        for row in _chain(_jsonl(base / SEARCH_FILE), add_search):
            fh.write(dumps(row) + "\n")
    stats = {
        "nodes": dict(sorted(node_counts.items())),
        "edges": dict(sorted(edge_counts.items())),
        "node_total": sum(node_counts.values()),
        "edge_total": sum(edge_counts.values()),
    }
    (out / "_graph" / "stats.json").write_text(json.dumps(stats, indent=2) + "\n")
    return {
        "linked": linked,
        "overlaid": overlaid,
        "nodes": stats["node_total"],
        "edges": stats["edge_total"],
        "seconds": round(time.monotonic() - started, 2),
    }


def _chain(*iterables: Iterable[dict[str, Any]]) -> Iterator[dict[str, Any]]:
    for it in iterables:
        yield from it


def apply_delta(base: Path, delta: Path, out: Path) -> dict[str, Any]:
    return materialize(
        base,
        out,
        records=delta / "records",
        add_nodes=_jsonl(delta / "nodes.jsonl"),
        add_edges=_jsonl(delta / "edges.jsonl"),
        add_search=_jsonl(delta / "search.jsonl"),
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--base", type=Path, required=True)
    ap.add_argument("--delta", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    print(json.dumps(apply_delta(args.base, args.delta, args.out), indent=2))


if __name__ == "__main__":
    main()
