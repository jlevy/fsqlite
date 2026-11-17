"""
Write W2 delta batches for a generated KB: 1%, 5% and 20% of its nodes, 80% new
records and 20% updated ones, as a crawler or agent would produce them.

    python delta.py --scale S1 --corpus $CORPORA/S1 [--pcts 1 5 20]

Each batch is `<corpus>/deltas/pNN/`:

    records/        new and updated record files at their KB paths
    nodes.jsonl     nodes of the new records
    edges.jsonl     edges of the new records (both directions)
    search.jsonl    search documents of the new records
    manifest.json   counts, new IDs and updated IDs

New records are copies of S0 templates (never hubs or containers) under a fresh replica
number `R + n`, wired like the template's copy in a seeded random base replica, so they
link to existing entities. Updated records change one value through the YAML
(repository stars, else the first of bio, abstract, description, headline or tagline)
and keep their IDs, edges and names. `overlay.py` applies a batch to the base KB.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from idmap import DEFAULT_SEED, SCALES, own_id, own_path  # noqa: E402
from templates import HUB_OR_NESTED, load_s0, ref_replica_for, render  # noqa: E402
from yamlio import read_doc, write_doc  # noqa: E402

DEFAULT_S0 = HERE.parents[4] / "attic" / "paraverse" / "vendor" / "universe2026-md" / "kb"
TEXT_FIELDS = ("bio", "abstract", "description", "headline", "tagline")
PARENT_ENVELOPE = {"day": "event", "term": "facet"}


def dumps(row: dict[str, Any]) -> str:
    return json.dumps(row, ensure_ascii=False)


def update_payload(kind: str, payload: dict[str, Any], rng: random.Random, pct: int) -> str | None:
    """Change one value in place; return the field changed, or None if none applies."""
    if kind == "repository" and isinstance(payload.get("stars"), int):
        payload["stars"] += 1 + rng.randrange(50)
        return "stars"
    for field in TEXT_FIELDS:
        if isinstance(payload.get(field), str):
            payload[field] = payload[field].rstrip() + f" (Updated by the {pct}% delta batch.)"
            return field
    return None


def make_delta(scale: str, corpus: Path, pct: int, seed: int, s0_root: Path) -> dict[str, Any]:
    started = time.monotonic()
    replicas = SCALES[scale]
    s0 = load_s0(s0_root, replicas, seed)
    base = corpus / "kb"
    out = corpus / "deltas" / f"p{pct:02d}"
    records = out / "records"
    records.mkdir(parents=True, exist_ok=True)
    rng = random.Random(f"{seed}:{scale}:{pct}")

    base_nodes: list[tuple[str, str, str]] = []
    with (base / "_graph" / "nodes.jsonl").open(encoding="utf-8") as fh:
        for line in fh:
            row = json.loads(line)
            base_nodes.append((row["id"], row["kind"], row["path"]))
    total = round(len(base_nodes) * pct / 100)
    n_new = round(total * 0.8)
    n_upd = total - n_new

    edges_of: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for e in s0.edges:
        edges_of[e["source"]].append(e)
        if e["target"] != e["source"]:
            edges_of[e["target"]].append(e)
    search_of = {d["id"]: d for d in s0.search}
    eligible = sorted(p for p, t in s0.templates.items() if t.owner_kind not in HUB_OR_NESTED)
    occurrences: Counter[str] = Counter()
    new_ids: list[str] = []
    n_edges = 0
    with (
        (out / "nodes.jsonl").open("w", encoding="utf-8") as nodes_fh,
        (out / "edges.jsonl").open("w", encoding="utf-8") as edges_fh,
        (out / "search.jsonl").open("w", encoding="utf-8") as search_fh,
    ):
        for _ in range(n_new):
            path = rng.choice(eligible)
            tpl = s0.templates[path]
            new_r = replicas + occurrences[path]
            occurrences[path] += 1
            rb = rng.randrange(replicas)
            owner = tpl.owner
            dest = records / own_path(path, new_r)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(render(tpl.segments, rb, replicas, own_replica=new_r).encode())
            new_id = own_id(owner, new_r)
            new_ids.append(new_id)
            row = {
                "id": new_id,
                "kind": tpl.owner_kind,
                "name": s0_name(s0, owner),
                "path": own_path(path, new_r),
            }
            nodes_fh.write(dumps(row) + "\n")
            for e in edges_of.get(owner, []):
                s, t = e["source"], e["target"]
                attrs = {k: v for k, v in e.items() if k not in ("source", "relation", "target")}
                if s == owner:
                    edge = {
                        "source": new_id,
                        "relation": e["relation"],
                        "target": own_id(t, ref_replica_for(owner, t, rb, replicas, seed)),
                    }
                else:
                    edge = {
                        "source": own_id(s, ref_replica_for(owner, s, rb, replicas, seed)),
                        "relation": e["relation"],
                        "target": new_id,
                    }
                edges_fh.write(dumps({**edge, **attrs}) + "\n")
                n_edges += 1
            doc = search_of.get(owner)
            if doc is not None:
                search_fh.write(dumps({**doc, "id": new_id, "path": row["path"]}) + "\n")

        updated: list[str] = []
        fields: Counter[str] = Counter()
        candidates = [n for n in base_nodes if n[1] not in HUB_OR_NESTED]
        order = rng.sample(range(len(candidates)), len(candidates))
        for index in order:
            if len(updated) >= n_upd:
                break
            nid, kind, path = candidates[index]
            data, body, frontmatter = read_doc(base / path)
            envelope = data.get("softschema", {}).get("envelope", kind)
            payload = data.get(envelope)
            if not isinstance(payload, dict):
                continue
            field = update_payload(kind, payload, rng, pct)
            if field is None:
                continue
            dest = records / path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(write_doc(data, body, frontmatter))
            updated.append(nid)
            fields[field] += 1

    manifest = {
        "scale": scale,
        "pct": pct,
        "seed": seed,
        "base_nodes": len(base_nodes),
        "changes": total,
        "new": len(new_ids),
        "updated": len(updated),
        "new_edges": n_edges,
        "updated_fields": dict(fields),
        "new_kinds": dict(Counter(i.split(":", 1)[0] for i in new_ids)),
        "new_ids": new_ids,
        "updated_ids": updated,
        "seconds": round(time.monotonic() - started, 2),
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return {k: v for k, v in manifest.items() if not k.endswith("_ids")}


_NAMES: dict[int, dict[str, str]] = {}


def s0_name(s0: Any, node_id: str) -> str:
    names = _NAMES.get(id(s0))
    if names is None:
        names = _NAMES[id(s0)] = {n["id"]: n["name"] for n in s0.nodes}
    return names[node_id]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--scale", required=True, choices=sorted(SCALES))
    ap.add_argument("--corpus", type=Path, required=True, help="the directory holding kb/")
    ap.add_argument("--pcts", type=int, nargs="+", default=[1, 5, 20])
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--s0", type=Path, default=DEFAULT_S0)
    args = ap.parse_args()
    for pct in args.pcts:
        print(json.dumps(make_delta(args.scale, args.corpus, pct, args.seed, args.s0)))


if __name__ == "__main__":
    main()
