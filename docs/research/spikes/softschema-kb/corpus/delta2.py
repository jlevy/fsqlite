"""
Round-2 W2 batches (format `softschema-kb-delta/v2`) for a round-2 corpus, and the
reference implementation that applies one to a KB.

    python delta2.py --scale S1 --corpus $KB_CORPORA/S1-r2          # write every batch
    python delta2.py --apply --base $KB_CORPORA/S1-r2/kb \
        --batch $KB_CORPORA/S1-r2/deltas/p05 --out DIR                # materialize a batch

Batches (in `<corpus>/deltas/`): bulk `p01`, `p05`, `p20` (1%, 5% and 20% of the nodes);
trickle `t0001`, `t0010`, `t0100` (1, 10 and 100 records); and `t0010-invalid`, which is
`t0010` with one record broken against its schema. Each batch's changes are 80% new
records, 2% deletes, 1% merges and the rest updates, half of which change a value and
half of which drop one reference and add another (so the record's edges change).

A batch directory holds:

    manifest.json   format, counts, and the invalid record (path, id, reason) if any
    records/        the full new file of every upserted record, at its KB path
    ops.jsonl       the operations, one per line, applied in file order

Operations:
- `{"op": "upsert", "path", "nodes", "edges", "search"}`: write the record at `path`,
  replace its node rows with `nodes`, delete every edge whose `origin` is `path`, then
  add `edges` (the complete edge set derived from the record, each with `origin`), and
  replace its search documents with `search`.
- `{"op": "delete", "path", "node_ids"}`: remove the record, its nodes, every edge whose
  origin is `path`, and every other edge incident to those nodes.
- `{"op": "merge", "absorbed", "survivor", "absorbed_path", "survivor_path"}`: replace
  the absorbed node with the survivor at every edge endpoint, change origin
  `absorbed_path` to `survivor_path`, then remove the absorbed node and its record.
  Payloads are not rewritten, so other records may still name the absorbed ID.

Every edge is incident to a node of its origin record, so a backend can find the edges
of a record from its nodes. Deletes and merges never touch a record that the same batch
upserts or an entity that a W3 v2 query names, and survivors are never deleted.
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

from generate2 import ROUND, edge_origins, shared_entities  # noqa: E402
from idmap import DEFAULT_SEED, SCALES, own_id, own_path  # noqa: E402
from overlay import _jsonl, dumps, link_tree, put  # noqa: E402
from templates import HUB_OR_NESTED, load_s0, ref_replica_for, render  # noqa: E402
from yamlio import read_doc, write_doc  # noqa: E402

DEFAULT_S0 = HERE.parents[4] / "attic" / "paraverse" / "vendor" / "universe2026-md" / "kb"
FORMAT = "softschema-kb-delta/v2"
_REPLICA = re.compile(r"-r\d+$")
BULK = {"p01": 1, "p05": 5, "p20": 20}
TRICKLE = {"t0001": 1, "t0010": 10, "t0100": 100}
TEXT_FIELDS = ("bio", "abstract", "description", "headline", "tagline")
MERGE_KINDS = ("person", "organization", "repository")
GRAPH_FILES = ("_graph/nodes.jsonl", "_graph/edges.jsonl", "_graph/stats.json", "_search/documents.jsonl")


def composition(n: int) -> dict[str, int]:
    new, deletes, merges = round(0.8 * n), round(0.02 * n), round(0.01 * n)
    updates = n - new - deletes - merges
    refs = updates // 2
    return {"new": new, "update_value": updates - refs, "update_refs": refs, "delete": deletes, "merge": merges}


def _value_update(kind: str, payload: dict[str, Any], rng: random.Random, tag: str) -> bool:
    if kind == "repository" and isinstance(payload.get("stars"), int):
        payload["stars"] += 1 + rng.randrange(50)
        return True
    for field in TEXT_FIELDS:
        if isinstance(payload.get(field), str):
            payload[field] = payload[field].rstrip() + f" (Updated by batch {tag}.)"
            return True
    return False


def make_batch(name: str, n: int, ctx: dict[str, Any], invalid: bool = False) -> dict[str, Any]:
    started = time.monotonic()
    s0, shared, base, replicas, seed = ctx["s0"], ctx["shared"], ctx["base"], ctx["replicas"], ctx["seed"]
    out = ctx["corpus"] / "deltas" / name
    records = out / "records"
    records.mkdir(parents=True, exist_ok=True)
    rng = random.Random(f"{seed}:{ROUND}:{ctx['scale']}:{name}")
    plan = composition(n)
    ops: list[dict[str, Any]] = []
    touched: set[str] = set()

    # New records: copies of non-hub, non-shared S0 templates under a fresh replica number,
    # wired like the template's copy in a random base replica.
    occurrences: Counter[str] = Counter()
    for _ in range(plan["new"]):
        path = rng.choice(ctx["eligible_templates"])
        tpl = s0.templates[path]
        new_r = replicas + occurrences[path]
        occurrences[path] += 1
        rb = rng.randrange(replicas)
        new_path = own_path(path, new_r)
        new_id = own_id(tpl.owner, new_r)
        (records / new_path).parent.mkdir(parents=True, exist_ok=True)
        (records / new_path).write_bytes(render(tpl.segments, rb, replicas, own_replica=new_r).encode())

        def ref(x: str, tpl=tpl, rb=rb, new_id=new_id) -> str:
            if x == tpl.owner:
                return new_id
            return x if x in shared else own_id(x, ref_replica_for(tpl.owner, x, rb, replicas, seed, shared))

        edges = []
        for e in ctx["s0_edges_by_origin"].get(path, []):
            row = {"source": ref(e["source"]), "relation": e["relation"], "target": ref(e["target"])}
            row.update({k: v for k, v in e.items() if k not in ("source", "relation", "target")})
            row["origin"] = new_path
            edges.append(row)
        doc = ctx["search_by_id"].get(tpl.owner)
        ops.append(
            {
                "op": "upsert",
                "change": "new",
                "path": new_path,
                "nodes": [{"id": new_id, "kind": tpl.owner_kind, "name": ctx["s0_names"][tpl.owner], "path": new_path}],
                "edges": edges,
                "search": [{**doc, "id": new_id, "path": new_path}] if doc else [],
            }
        )

    # Updates, deletes and merges draw from distinct existing records.
    order = rng.sample(range(len(ctx["candidates"])), len(ctx["candidates"]))
    pool = [ctx["candidates"][i] for i in order]
    updates_value, updates_refs, deletes, merges = [], [], [], []
    for row in pool:
        if len(updates_refs) < plan["update_refs"] and row["kind"] in ("session", "person"):
            updates_refs.append(row)
        elif len(updates_value) < plan["update_value"]:
            updates_value.append(row)
        elif len(deletes) < plan["delete"] and row["id"] not in ctx["protected"]:
            deletes.append(row)
        elif len(merges) < plan["merge"] and row["kind"] in MERGE_KINDS and row["id"] not in ctx["protected"]:
            merges.append(row)
        if (len(updates_refs), len(updates_value), len(deletes), len(merges)) == (
            plan["update_refs"], plan["update_value"], plan["delete"], plan["merge"]
        ):
            break
    touched |= {r["path"] for r in updates_refs + updates_value + deletes + merges}
    base_edges = ctx["base_edges_for"]({r["path"] for r in updates_refs + updates_value})
    invalid_info = None

    for row in updates_value + updates_refs:
        data, body, frontmatter = read_doc(base / row["path"])
        envelope = data["softschema"]["envelope"]
        payload = data[envelope]
        edges = list(base_edges.get(row["path"], []))
        if row in updates_refs:
            mentions = payload.get("mentions") or []
            if mentions:
                dropped = mentions.pop(rng.randrange(len(mentions)))
                for i, e in enumerate(edges):
                    if e["relation"] == "mentions" and e["target"] == dropped["target"] and e.get("field") == dropped["field"]:
                        edges.pop(i)
                        break
            named = {m["target"] for m in mentions}
            target = rng.choice([t for t in ctx["mention_targets"] if t not in named])
            field = "bio" if row["kind"] == "person" else "abstract"
            mentions.append({"target": target, "text": ctx["s0_names"][target], "field": field, "method": "gazetteer"})
            payload["mentions"] = mentions
            edges.append({"source": row["id"], "relation": "mentions", "target": target, "field": field, "origin": row["path"]})
            change = "update_refs"
        else:
            _value_update(row["kind"], payload, rng, name)  # some kinds have no such field
            change = "update_value"
        if invalid and invalid_info is None:
            if row["kind"] in ("session", "person"):
                key = "sponsored" if row["kind"] == "session" else "featured"
                payload[key] = "maybe"
                reason = f"{row['kind']}.{key} is the string 'maybe'; the schema requires a boolean"
            else:
                payload["unexpected_field"] = True
                reason = f"{row['kind']} has unexpected_field; the schema has additionalProperties: false"
            invalid_info = {"path": row["path"], "id": row["id"], "reason": reason}
        put(records, row["path"], write_doc(data, body, frontmatter))
        ops.append({"op": "upsert", "change": change, "path": row["path"], "nodes": [row], "edges": edges, "search": ctx["search_rows_for"](row)})
    for row in deletes:
        ops.append({"op": "delete", "path": row["path"], "node_ids": [row["id"]]})
    for row in merges:
        survivor = ctx["merge_survivor"](row, touched, rng)
        if survivor is None:
            continue
        touched.add(survivor["path"])
        ops.append({"op": "merge", "absorbed": row["id"], "survivor": survivor["id"], "absorbed_path": row["path"], "survivor_path": survivor["path"]})

    with (out / "ops.jsonl").open("w", encoding="utf-8") as fh:
        for op in ops:
            fh.write(dumps(op) + "\n")
    counts = Counter(op.get("change", op["op"]) for op in ops)
    manifest = {
        "format": FORMAT,
        "scale": ctx["scale_name"],
        "batch": name,
        "seed": seed,
        "changes": len(ops),
        "counts": dict(sorted(counts.items())),
        "edges_in_upserts": sum(len(op.get("edges", [])) for op in ops),
        "invalid": invalid_info,
        "seconds": round(time.monotonic() - started, 2),
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def build_context(scale: str, corpus: Path, seed: int, s0_root: Path) -> dict[str, Any]:
    replicas = SCALES[scale]
    s0 = load_s0(s0_root, replicas, seed)
    s0.templates_by_owner = {t.owner: t for t in s0.templates.values()}  # type: ignore[attr-defined]
    shared = shared_entities(s0)
    s0 = load_s0(s0_root, replicas, seed, shared)
    origins = edge_origins(s0, shared)
    by_origin: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for e, o in zip(s0.edges, origins, strict=True):
        by_origin[o].append(e)
    base = corpus / "kb"
    nodes = list(_jsonl(base / "_graph" / "nodes.jsonl"))
    shared_paths = {n["path"] for n in nodes if n["id"] in shared}
    candidates = [n for n in nodes if n["kind"] not in HUB_OR_NESTED and n["id"] not in shared and n["path"] not in shared_paths]
    by_template: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for n in candidates:
        if n["kind"] in MERGE_KINDS:
            by_template[(n["kind"], _REPLICA.sub("", n["id"]))].append(n)
    search_rows: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for d in _jsonl(base / "_search" / "documents.jsonl"):
        search_rows[d["id"]].append(d)

    def base_edges_for(paths: set[str]) -> dict[str, list[dict[str, Any]]]:
        found: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for e in _jsonl(base / "_graph" / "edges.jsonl"):
            if e.get("origin") in paths:
                found[e["origin"]].append(e)
        return found

    def merge_survivor(row: dict[str, Any], touched: set[str], rng: random.Random) -> dict[str, Any] | None:
        """Prefer another replica's copy of the same S0 entity: a duplicate to fold in."""
        key = (row["kind"], _REPLICA.sub("", row["id"]))
        options = [n for n in by_template.get(key, []) if n["id"] != row["id"] and n["path"] not in touched]
        if not options:
            options = [n for n in candidates if n["kind"] == row["kind"] and n["path"] not in touched and n["id"] != row["id"]][:50]
        return rng.choice(options) if options else None

    eligible = sorted(p for p, t in s0.templates.items() if t.owner_kind not in HUB_OR_NESTED and t.owner not in shared)
    mention_targets = sorted(i for i in shared if s0.kind[i] in ("software", "organization"))
    return {
        "s0": s0,
        "shared": shared,
        "base": base,
        "corpus": corpus,
        "scale": scale,
        "scale_name": f"{scale}-{ROUND}",
        "replicas": replicas,
        "seed": seed,
        "eligible_templates": eligible,
        "s0_edges_by_origin": by_origin,
        "s0_names": {n["id"]: n["name"] for n in s0.nodes},
        "search_by_id": {d["id"]: d for d in s0.search},
        "candidates": candidates,
        "node_count": len(nodes),
        "base_edges_for": base_edges_for,
        "merge_survivor": merge_survivor,
        "search_rows_for": lambda row: search_rows.get(row["id"], []),
        "mention_targets": mention_targets,
        "protected": protected_ids(f"{scale}-{ROUND}"),
    }


def protected_ids(scale_name: str) -> frozenset[str]:
    """Entities named by the W3 v2 queries: never deleted or absorbed by a batch."""
    path = HERE.parent / "harness" / "queries.json"
    if not path.is_file():
        return frozenset()
    doc = json.loads(path.read_text(encoding="utf-8"))
    out = set()
    for q in doc.get("queries_v2", []):
        p = q["params"].get(scale_name, {})
        out |= {p[k] for k in ("id", "a", "b", "org") if isinstance(p.get(k), str)}
    return frozenset(out)


## Applying a batch (the reference implementation)


def apply_batch(base: Path, batch: Path, out: Path) -> dict[str, Any]:
    """Materialize the post-batch KB: hard links, overlaid records, rewritten _graph."""
    import shutil

    started = time.monotonic()
    if out.exists():
        shutil.rmtree(out)
    ops = list(_jsonl(batch / "ops.jsonl"))
    link_tree(base, out, skip=GRAPH_FILES)
    for path in (batch / "records").rglob("*"):
        if path.is_file():
            put(out, str(path.relative_to(batch / "records")), path.read_bytes())
    upserts = {op["path"]: op for op in ops if op["op"] == "upsert"}
    removed_paths = {op["path"] for op in ops if op["op"] == "delete"} | {op["absorbed_path"] for op in ops if op["op"] == "merge"}
    deleted_nodes = {i for op in ops if op["op"] == "delete" for i in op["node_ids"]}
    retarget = {op["absorbed"]: op["survivor"] for op in ops if op["op"] == "merge"}
    origin_map = {op["absorbed_path"]: op["survivor_path"] for op in ops if op["op"] == "merge"}
    for rel in removed_paths:
        (out / rel).unlink(missing_ok=True)
    gone = deleted_nodes | set(retarget)

    def final(x: str) -> str:
        while x in retarget:
            x = retarget[x]
        return x

    node_rows = {n["id"]: n for op in upserts.values() for n in op["nodes"]}
    node_counts: Counter[str] = Counter()
    seen: set[str] = set()
    with (out / "_graph" / "nodes.jsonl").open("w", encoding="utf-8") as fh:
        for n in _jsonl(base / "_graph" / "nodes.jsonl"):
            if n["id"] in gone:
                continue
            n = node_rows.get(n["id"], n)
            seen.add(n["id"])
            node_counts[n["kind"]] += 1
            fh.write(dumps(n) + "\n")
        for nid, n in node_rows.items():
            if nid not in seen and nid not in gone:
                node_counts[n["kind"]] += 1
                fh.write(dumps(n) + "\n")
    edge_counts: Counter[str] = Counter()
    drop_origins = set(upserts) | {op["path"] for op in ops if op["op"] == "delete"}

    def emit(fh: Any, e: dict[str, Any]) -> None:
        e = {**e, "source": final(e["source"]), "target": final(e["target"])}
        if e["source"] in deleted_nodes or e["target"] in deleted_nodes:
            return
        if e.get("origin") in origin_map:
            e["origin"] = origin_map[e["origin"]]
        edge_counts[e["relation"]] += 1
        fh.write(dumps(e) + "\n")

    with (out / "_graph" / "edges.jsonl").open("w", encoding="utf-8") as fh:
        for e in _jsonl(base / "_graph" / "edges.jsonl"):
            if e.get("origin") not in drop_origins:
                emit(fh, e)
        for op in upserts.values():
            for e in op["edges"]:
                emit(fh, e)
    with (out / "_search" / "documents.jsonl").open("w", encoding="utf-8") as fh:
        replaced = {d["id"] for op in upserts.values() for d in op["search"]}
        for d in _jsonl(base / "_search" / "documents.jsonl"):
            if d["id"] not in gone and d["id"] not in replaced:
                fh.write(dumps(d) + "\n")
        for op in upserts.values():
            for d in op["search"]:
                fh.write(dumps(d) + "\n")
    stats = {
        "nodes": dict(sorted(node_counts.items())),
        "edges": dict(sorted(edge_counts.items())),
        "node_total": sum(node_counts.values()),
        "edge_total": sum(edge_counts.values()),
    }
    (out / "_graph" / "stats.json").write_text(json.dumps(stats, indent=2) + "\n")
    return {"ops": len(ops), "nodes": stats["node_total"], "edges": stats["edge_total"], "seconds": round(time.monotonic() - started, 2)}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--scale", choices=sorted(SCALES))
    ap.add_argument("--corpus", type=Path, help="the round-2 corpus directory holding kb/")
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--s0", type=Path, default=DEFAULT_S0)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--base", type=Path)
    ap.add_argument("--batch", type=Path)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()
    if args.apply:
        print(json.dumps(apply_batch(args.base, args.batch, args.out)))
        return
    ctx = build_context(args.scale, args.corpus, args.seed, args.s0)
    batches = [(name, round(ctx["node_count"] * pct / 100), False) for name, pct in BULK.items()]
    batches += [(name, n, False) for name, n in TRICKLE.items()]
    batches.append(("t0010-invalid", 10, True))
    for name, n, invalid in batches:
        m = make_batch(name, n, ctx, invalid)
        print(json.dumps({k: m[k] for k in ("batch", "changes", "counts", "edges_in_upserts", "invalid", "seconds")}))


if __name__ == "__main__":
    main()
