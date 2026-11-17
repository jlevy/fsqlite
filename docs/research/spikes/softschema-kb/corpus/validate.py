"""
Check a generated KB: graph consistency, reference closure, payload fidelity against the
S0 templates, and softschema validation of a sample, the way paraverse validates.

    python validate.py --kb $CORPORA/S1/kb [--sample 40] [--s0 DIR] [--replicas R]

Checks:
1. Graph: node IDs are unique, every edge endpoint is a node, every node's path exists,
   and stats.json matches the export's counts.
2. Closure: every typed reference in every sampled payload names a node.
3. Fidelity: each sampled payload equals its S0 template's payload with IDs mapped by
   idmap (skipped with --no-fidelity, e.g. for evolved variants).
4. softschema: the sampled artifacts validate against the schema they name
   (paraverse_graph.validation.validate_artifacts).
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from prereq import require_paraverse_src  # noqa: E402

PARAVERSE_SRC = require_paraverse_src()

from idmap import DEFAULT_SEED, own_id  # noqa: E402
from paraverse_graph.kb import _find_by_id, read_artifact  # noqa: E402
from paraverse_graph.mapping import TYPED_REF  # noqa: E402
from paraverse_graph.validation import validate_artifacts  # noqa: E402
from templates import ref_replica_for  # noqa: E402

DEFAULT_S0 = HERE.parents[4] / "attic" / "paraverse" / "vendor" / "universe2026-md" / "kb"
PARENT_ENVELOPE = {"day": "event", "term": "facet"}
_REPLICA = re.compile(r"-r(\d+)$")


def _jsonl(path: Path):
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                yield json.loads(line)


def _refs(value: Any, out: list[str]) -> None:
    if isinstance(value, str):
        if TYPED_REF.match(value):
            out.append(value)
    elif isinstance(value, dict):
        for v in value.values():
            _refs(v, out)
    elif isinstance(value, list):
        for v in value:
            _refs(v, out)


def _payload(root: Path, node: dict[str, Any]) -> dict[str, Any]:
    kind = node["kind"]
    artifact = read_artifact(
        root / node["path"], node["path"], envelope_hint=PARENT_ENVELOPE.get(kind, kind)
    )
    own = artifact.payload.get("id")
    if isinstance(own, str) and (own == node["id"] or f"{kind}:{own}" == node["id"]):
        return artifact.payload
    return _find_by_id(artifact.payload, node["id"]) or {}


def _map_payload(value: Any, owner: str, r: int, replicas: int, s0_ids: set[str]) -> Any:
    if isinstance(value, str) and value in s0_ids:
        if value == owner:
            return own_id(value, r)
        return own_id(value, ref_replica_for(owner, value, r, replicas, DEFAULT_SEED))
    if isinstance(value, list):
        return [_map_payload(v, owner, r, replicas, s0_ids) for v in value]
    if isinstance(value, dict):
        return {k: _map_payload(v, owner, r, replicas, s0_ids) for k, v in value.items()}
    return value


def validate(kb: Path, s0: Path, sample: int, replicas: int | None, fidelity: bool) -> dict:
    started = time.monotonic()
    problems: list[str] = []
    nodes: dict[str, dict[str, Any]] = {}
    for row in _jsonl(kb / "_graph" / "nodes.jsonl"):
        if row["id"] in nodes:
            problems.append(f"duplicate node {row['id']}")
        nodes[row["id"]] = row
    edge_counts: Counter[str] = Counter()
    for row in _jsonl(kb / "_graph" / "edges.jsonl"):
        edge_counts[row["relation"]] += 1
        for end in ("source", "target"):
            if row[end] not in nodes:
                problems.append(f"edge {end} {row[end]} is not a node")
    for path in {n["path"] for n in nodes.values()}:
        if not (kb / path).is_file():
            problems.append(f"missing record {path}")
    stats = json.loads((kb / "_graph" / "stats.json").read_text())
    if stats["nodes"] != dict(sorted(Counter(n["kind"] for n in nodes.values()).items())):
        problems.append("stats.json node counts differ from nodes.jsonl")
    if stats["edges"] != dict(sorted(edge_counts.items())):
        problems.append("stats.json edge counts differ from edges.jsonl")
    if stats["node_total"] != len(nodes) or stats["edge_total"] != sum(edge_counts.values()):
        problems.append("stats.json totals differ")

    rng = random.Random(DEFAULT_SEED)
    by_kind: dict[str, list[str]] = defaultdict(list)
    for nid, n in nodes.items():
        by_kind[n["kind"]].append(nid)
    chosen = [nid for ids in by_kind.values() for nid in rng.sample(ids, min(sample, len(ids)))]

    s0_nodes = {n["id"]: n for n in _jsonl(s0 / "_graph" / "nodes.jsonl")} if fidelity else {}
    s0_ids = set(s0_nodes)
    checked_refs = fidelity_checked = 0
    for nid in chosen:
        payload = _payload(kb, nodes[nid])
        refs: list[str] = []
        _refs(payload, refs)
        checked_refs += len(refs)
        problems.extend(f"{nid}: dangling reference {ref}" for ref in refs if ref not in nodes)
        if fidelity and replicas:
            m = _REPLICA.search(nid)
            r = int(m.group(1)) if m else 0
            s0_id = nid[: m.start()] if m else nid
            template = s0_nodes.get(s0_id)
            if template is None:
                problems.append(f"{nid}: no S0 template {s0_id}")
                continue
            owner_kind = template["kind"]
            owner = s0_id
            if owner_kind in PARENT_ENVELOPE:  # nested: the owner is the container
                owner = next(
                    i
                    for i, n in s0_nodes.items()
                    if n["path"] == template["path"] and n["kind"] not in PARENT_ENVELOPE
                )
            expected = _map_payload(_payload(s0, template), owner, r, replicas, s0_ids)
            if owner_kind == "facet" and r:
                expected["id"] = expected["id"] + f"-r{r}"
            fidelity_checked += 1
            if expected != payload:
                problems.append(f"{nid}: payload differs from its mapped S0 template")

    paths = sorted({nodes[nid]["path"] for nid in chosen})
    report = validate_artifacts(kb, paths)
    problems.extend(p.line() for p in report.problems)
    return {
        "kb": str(kb),
        "nodes": len(nodes),
        "edges": sum(edge_counts.values()),
        "sampled_nodes": len(chosen),
        "sampled_refs": checked_refs,
        "fidelity_checked": fidelity_checked,
        "softschema_checked": report.checked,
        "softschema_contracts": dict(report.contracts),
        "problems": problems[:50],
        "problem_count": len(problems),
        "ok": not problems,
        "seconds": round(time.monotonic() - started, 2),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--kb", type=Path, required=True)
    ap.add_argument("--s0", type=Path, default=DEFAULT_S0)
    ap.add_argument("--sample", type=int, default=40, help="nodes sampled per kind")
    ap.add_argument("--replicas", type=int, help="replica count, for the fidelity check")
    ap.add_argument("--no-fidelity", action="store_true")
    ap.add_argument("--out", type=Path, help="write the report here as JSON")
    args = ap.parse_args()
    replicas = args.replicas
    manifest = args.kb.parent / "manifest.json"
    if replicas is None and not args.no_fidelity and manifest.is_file():
        replicas = json.loads(manifest.read_text()).get("replicas")
    result = validate(args.kb, args.s0, args.sample, replicas, not args.no_fidelity)
    text = json.dumps(result, indent=2) + "\n"
    if args.out:
        args.out.write_text(text)
    print(text)
    sys.exit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
