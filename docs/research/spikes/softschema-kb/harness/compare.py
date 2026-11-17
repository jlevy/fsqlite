"""
Compare the canonical W3 results of two runs.

    python compare.py results/falkordb/S1/w3.json results/fsqlite/S1/w3.json [--kb DIR]
    python compare.py expected/S1/w3.json results/falkordb/S1/w3.json

Each input is a `w3.json` (see queries.json `result_file`). Queries are matched by name,
and a name that appears twice in one file is an error. Results are compared
structurally: numbers compare by value (1 equals 1.0), booleans are never equal to
numbers, and dict key order is ignored; list order matters because every query defines
its order. A path result must carry `hops`, and path results compare on `hops` only.
With `--kb`, every returned path is also checked against the KB: consecutive nodes must
share an edge, no intermediate node may be a hub, and the length must equal `hops`.

A file slimmed by `slim_results.py` holds, for each non-path query, a digest of the
answer's canonical form (`canonical`) in place of the answer. A digest compares with a
full answer by digesting the full answer, and with another digest by value. A path
result is never slimmed; a digest where a path result is expected is a difference.

The verdict counts every difference; `--max-diffs` limits only the lines printed per
query. Exits 1 if any query differs or is missing from either side, and 2 if a file
holds no queries or repeats a name, else 0.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

HUB_KINDS = frozenset({"event", "day", "facet"})
DIGEST_KEYS = frozenset({"sha256", "json_bytes"})


class InputError(Exception):
    """A results file that cannot be compared: no queries, or a repeated name."""


def load(path: Path) -> tuple[dict[str, Any], bool]:
    """Queries by name, and whether the file is slimmed (its answers may be digests)."""
    doc = json.loads(path.read_text(encoding="utf-8"))
    queries = doc.get("queries") if isinstance(doc, dict) else None
    if not isinstance(queries, list) or not queries:
        raise InputError(f"{path}: no queries to compare")
    out: dict[str, Any] = {}
    for q in queries:
        name = q["name"]
        if name in out:
            raise InputError(f"{path}: query name {name!r} appears more than once")
        out[name] = q
    return out, "oracle_check" in doc


def canonical(value: Any) -> Any:
    """The form whose JSON text is equal exactly when `diffs` finds no difference."""
    if isinstance(value, bool) or value is None or isinstance(value, str | int):
        return value
    if isinstance(value, float):
        return int(value) if value.is_integer() else value
    if isinstance(value, dict):
        return {k: canonical(v) for k, v in value.items()}
    if isinstance(value, list):
        return [canonical(v) for v in value]
    raise TypeError(f"not a JSON value: {type(value).__name__}")


def digest(value: Any) -> dict[str, Any]:
    """The digest that `slim_results.py` stores in place of an answer."""
    text = json.dumps(canonical(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    data = text.encode("utf-8")
    return {"sha256": hashlib.sha256(data).hexdigest(), "json_bytes": len(data)}


def is_digest(result: Any, slimmed: bool) -> bool:
    return slimmed and isinstance(result, dict) and set(result) == DIGEST_KEYS


def normalize(category: str, result: Any) -> Any:
    """The part of a result that must match exactly."""
    if category == "path" and isinstance(result, dict) and "hops" in result:
        return {"hops": result["hops"]}
    return result


def path_problems(result: Any, slimmed: bool) -> list[str]:
    if is_digest(result, slimmed):
        return ["is a digest; a path result must keep hops and path"]
    if not isinstance(result, dict) or "hops" not in result:
        return ["has no hops"]
    return []


def diffs(a: Any, b: Any, where: str = "") -> list[str]:
    """Every structural difference between two values."""
    out: list[str] = []

    def walk(x: Any, y: Any, at: str) -> None:
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
            return
        if isinstance(x, list) and isinstance(y, list):
            if len(x) != len(y):
                out.append(f"{at or '/'}: list length {len(x)} != {len(y)}")
            for i, (xi, yi) in enumerate(zip(x, y, strict=False)):
                walk(xi, yi, f"{at}/{i}")
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


def query_diffs(qa: dict[str, Any], qb: dict[str, Any], slim_a: bool, slim_b: bool) -> list[str]:
    category = qa.get("category", "")
    ra, rb = qa["result"], qb["result"]
    if category == "path":
        found = [f"left result {p}" for p in path_problems(ra, slim_a)]
        found += [f"right result {p}" for p in path_problems(rb, slim_b)]
        return found or diffs(normalize(category, ra), normalize(category, rb))
    da, db = is_digest(ra, slim_a), is_digest(rb, slim_b)
    if da or db:
        ha = ra if da else digest(ra)
        hb = rb if db else digest(rb)
        return [] if ha == hb else [f"/: digest {ha['sha256'][:16]} != {hb['sha256'][:16]}"]
    return diffs(ra, rb)


def compare_files(
    left: Path, right: Path, kb: Path | None, limit: int, graph: KbGraph | None = None
) -> tuple[bool, list[str], dict[str, int]]:
    """The verdict, the report lines, and the count of ok, differing and missing queries."""
    (a, slim_a), (b, slim_b) = load(left), load(right)
    if graph is None and kb is not None:
        graph = KbGraph(kb)
    lines: list[str] = []
    tally = {"ok": 0, "differ": 0, "missing": 0}
    for name in sorted(set(a) | set(b)):
        if name not in a or name not in b:
            tally["missing"] += 1
            lines.append(f"MISSING {name}: only in {'left' if name in a else 'right'}")
            continue
        qa, qb = a[name], b[name]
        if qa.get("params") != qb.get("params"):
            tally["differ"] += 1
            lines.append(f"PARAMS  {name}: {_short(qa.get('params'))} != {_short(qb.get('params'))}")
            continue
        found = query_diffs(qa, qb, slim_a, slim_b)
        if graph and qa.get("category") == "path":
            for side, q, slim in (("left", qa, slim_a), ("right", qb, slim_b)):
                if not path_problems(q["result"], slim):
                    found += [f"{side} path: {p}" for p in graph.check_path(q["params"], q["result"])]
        if found:
            tally["differ"] += 1
            lines.append(f"DIFF    {name}")
            lines.extend(f"          {d}" for d in found[: max(limit, 0)])
            if len(found) > limit:
                lines.append(f"          ... {len(found) - max(limit, 0)} more")
        else:
            tally["ok"] += 1
            lines.append(f"OK      {name}")
    ok = tally["differ"] == 0 and tally["missing"] == 0 and tally["ok"] > 0
    return ok, lines, tally


def compare(left: Path, right: Path, kb: Path | None, limit: int) -> tuple[bool, list[str]]:
    ok, lines, _ = compare_files(left, right, kb, limit)
    return ok, lines


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("left", type=Path)
    ap.add_argument("right", type=Path)
    ap.add_argument("--kb", type=Path, help="KB directory, to validate returned paths")
    ap.add_argument("--max-diffs", type=int, default=5, help="difference lines printed per query")
    args = ap.parse_args()
    try:
        ok, lines, tally = compare_files(args.left, args.right, args.kb, args.max_diffs)
    except InputError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(2)
    print("\n".join(lines))
    differing = tally["differ"] + tally["missing"]
    print(f"\n{'MATCH' if ok else 'MISMATCH'}: {tally['ok']} ok, {differing} differ")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
