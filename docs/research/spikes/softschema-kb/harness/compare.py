"""
Compare the canonical W3 results of two runs.

    python compare.py results/falkordb/S1/w3.json results/fsqlite/S1/w3.json [--kb DIR]
    python compare.py expected/S1/w3.json results/falkordb/S1/w3.json

Each input is a `w3.json` (see queries.json `result_file`). Queries are matched by name.
Results are compared structurally: numbers compare by value (1 equals 1.0), booleans
are never equal to numbers, and dict key order is ignored; list order matters because
every query defines its order. Path results compare on `hops` only. With `--kb`, every
returned path is also checked against the KB: consecutive nodes must share an edge, no
intermediate node may be a hub, and the length must equal `hops`.

Exits 1 if any query differs or is missing from either side, else 0.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

HUB_KINDS = frozenset({"event", "day", "facet"})


def load(path: Path) -> dict[str, Any]:
    doc = json.loads(path.read_text(encoding="utf-8"))
    return {q["name"]: q for q in doc["queries"]}


def normalize(category: str, result: Any) -> Any:
    """The part of a result that must match exactly."""
    if category == "path" and isinstance(result, dict):
        return {"hops": result.get("hops")}
    return result


def diffs(a: Any, b: Any, where: str = "", limit: int = 5) -> list[str]:
    out: list[str] = []

    def walk(x: Any, y: Any, at: str) -> None:
        if len(out) >= limit:
            return
        if isinstance(x, bool) or isinstance(y, bool):
            if type(x) is not type(y) or x != y:
                out.append(f"{at or '/'}: {_short(x)} != {_short(y)}")
            return
        if isinstance(x, int | float) and isinstance(y, int | float):
            if x != y:
                out.append(f"{at or '/'}: {x!r} != {y!r}")
            return
        if isinstance(x, dict) and isinstance(y, dict):
            for key in sorted(set(x) | set(y)):
                if key not in x:
                    out.append(f"{at}/{key}: missing on left")
                elif key not in y:
                    out.append(f"{at}/{key}: missing on right")
                else:
                    walk(x[key], y[key], f"{at}/{key}")
                if len(out) >= limit:
                    return
            return
        if isinstance(x, list) and isinstance(y, list):
            if len(x) != len(y):
                out.append(f"{at or '/'}: list length {len(x)} != {len(y)}")
            for i, (xi, yi) in enumerate(zip(x, y, strict=False)):
                walk(xi, yi, f"{at}/{i}")
                if len(out) >= limit:
                    return
            return
        if type(x) is not type(y) or x != y:
            out.append(f"{at or '/'}: {_short(x)} != {_short(y)}")

    walk(a, b, where)
    return out


def _short(value: Any, width: int = 120) -> str:
    text = json.dumps(value, ensure_ascii=False, sort_keys=True)
    return text if len(text) <= width else text[: width - 3] + "..."


class KbGraph:
    """Just enough of a KB to check returned paths."""

    def __init__(self, root: Path):
        self.kind: dict[str, str] = {}
        with (root / "_graph" / "nodes.jsonl").open(encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    row = json.loads(line)
                    self.kind[row["id"]] = row["kind"]
        self.pairs: set[tuple[str, str]] = set()
        with (root / "_graph" / "edges.jsonl").open(encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    row = json.loads(line)
                    s, t = row["source"], row["target"]
                    self.pairs.add((s, t) if s < t else (t, s))

    def check_path(self, params: dict[str, Any], result: dict[str, Any]) -> list[str]:
        path, hops = result.get("path") or [], result.get("hops")
        if hops is None:
            return [] if not path else ["path given but hops is null"]
        problems = []
        if len(path) != hops + 1:
            problems.append(f"path has {len(path) - 1} edges, hops is {hops}")
        if path and (path[0] != params["a"] or path[-1] != params["b"]):
            problems.append("path endpoints differ from a and b")
        for u, v in zip(path, path[1:], strict=False):
            if ((u, v) if u < v else (v, u)) not in self.pairs:
                problems.append(f"no edge {u} -- {v}")
        for node in path[1:-1]:
            if self.kind.get(node) in HUB_KINDS:
                problems.append(f"hub {node} inside path")
        return problems


def compare(left: Path, right: Path, kb: Path | None, limit: int) -> tuple[bool, list[str]]:
    a, b = load(left), load(right)
    graph = KbGraph(kb) if kb else None
    lines: list[str] = []
    ok = True
    for name in sorted(set(a) | set(b)):
        if name not in a or name not in b:
            ok = False
            lines.append(f"MISSING {name}: only in {'left' if name in a else 'right'}")
            continue
        qa, qb = a[name], b[name]
        if qa.get("params") != qb.get("params"):
            ok = False
            lines.append(f"PARAMS  {name}: {_short(qa.get('params'))} != {_short(qb.get('params'))}")
            continue
        category = qa.get("category", "")
        found = diffs(normalize(category, qa["result"]), normalize(category, qb["result"]), "", limit)
        if graph and category == "path":
            for side, q in (("left", qa), ("right", qb)):
                found += [f"{side} path: {p}" for p in graph.check_path(q["params"], q["result"])]
        if found:
            ok = False
            lines.append(f"DIFF    {name}")
            lines.extend(f"          {d}" for d in found)
        else:
            lines.append(f"OK      {name}")
    return ok, lines


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("left", type=Path)
    ap.add_argument("right", type=Path)
    ap.add_argument("--kb", type=Path, help="KB directory, to validate returned paths")
    ap.add_argument("--max-diffs", type=int, default=5, help="differences shown per query")
    args = ap.parse_args()
    ok, lines = compare(args.left, args.right, args.kb, args.max_diffs)
    print("\n".join(lines))
    matching = sum(1 for line in lines if line.startswith("OK"))
    differing = sum(1 for line in lines if not line.startswith(("OK", " ")))
    print(f"\n{'MATCH' if ok else 'MISMATCH'}: {matching} ok, {differing} differ")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
