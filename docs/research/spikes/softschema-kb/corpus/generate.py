"""
Generate a synthetic softschema KB at scale S1, S2 or S3 from the real S0 KB.

The corpus is R replicas of S0 (see `idmap.py` for the ID scheme and cross-replica
rewiring, `templates.py` for record rendering). Generation is deterministic from the
seed, streams one replica at a time per worker, and writes the full KB layout:

    <out>/kb/<kind dirs>/   records, byte-identical to their S0 templates except IDs and links
    <out>/kb/_schemas/      copied from S0
    <out>/kb/_graph/        nodes.jsonl, edges.jsonl, stats.json, coverage.json
    <out>/kb/_search/       documents.jsonl
    <out>/manifest.json     seed, replicas, counts, sizes and timings

    python generate.py --scale S1 --out $CORPORA/S1 [--workers 4]

`--scale S0` writes an identity copy (one replica), which must equal the source.
"""

from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import os
import shutil
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from idmap import DEFAULT_SEED, SCALES, own_id, own_path  # noqa: E402
from safepath import replace_dir  # noqa: E402
from templates import S0, load_s0, ref_replica_for, render  # noqa: E402

DEFAULT_S0 = HERE.parents[4] / "attic" / "paraverse" / "vendor" / "universe2026-md" / "kb"
ROOT_FILES = ("README.md", "faq.yaml", "media.yaml")

_S0: S0 | None = None
_OUT: Path | None = None
_SEED = DEFAULT_SEED


def dumps(row: dict[str, Any]) -> str:
    return json.dumps(row, ensure_ascii=False)


def _remap_value(value: Any, owner: str, r: int, s0: S0) -> Any:
    if isinstance(value, str) and value in s0.kind:
        return own_id(value, ref_replica_for(owner, value, r, s0.replicas, _SEED))
    if isinstance(value, list):
        return [_remap_value(v, owner, r, s0) for v in value]
    if isinstance(value, dict):
        return {k: _remap_value(v, owner, r, s0) for k, v in value.items()}
    return value


def edge_row(edge: dict[str, Any], r: int, s0: S0) -> dict[str, Any]:
    s, t = edge["source"], edge["target"]
    row = {
        "source": own_id(s, r),
        "relation": edge["relation"],
        "target": own_id(t, ref_replica_for(s, t, r, s0.replicas, _SEED)),
    }
    for key, value in edge.items():
        if key not in row:
            row[key] = _remap_value(value, s, r, s0)
    return row


def render_replica(r: int) -> dict[str, Any]:
    """Write replica r's records and its part files; return its counts."""
    s0, out = _S0, _OUT
    assert s0 is not None and out is not None
    kb = out / "kb"
    parts = kb / "_graph" / ".parts"
    made: set[Path] = set()
    nbytes = 0
    for path, tpl in s0.templates.items():
        dest = kb / own_path(path, r)
        if dest.parent not in made:
            dest.parent.mkdir(parents=True, exist_ok=True)
            made.add(dest.parent)
        data = render(tpl.segments, r, s0.replicas).encode()
        dest.write_bytes(data)
        nbytes += len(data)
    with (parts / f"nodes.{r:05d}.jsonl").open("w", encoding="utf-8") as fh:
        for n in s0.nodes:
            row = {**n, "id": own_id(n["id"], r), "path": own_path(n["path"], r)}
            fh.write(dumps(row) + "\n")
    with (parts / f"edges.{r:05d}.jsonl").open("w", encoding="utf-8") as fh:
        for e in s0.edges:
            fh.write(dumps(edge_row(e, r, s0)) + "\n")
    with (parts / f"search.{r:05d}.jsonl").open("w", encoding="utf-8") as fh:
        for d in s0.search:
            if d["id"] in s0.kind:
                row = {**d, "id": own_id(d["id"], r), "path": own_path(d["path"], r)}
            elif r == 0:
                row = d
            else:
                continue
            fh.write(dumps(row) + "\n")
    return {"replica": r, "record_bytes": nbytes, "records": len(s0.templates)}


def _init(s0: S0, out: Path, seed: int) -> None:
    global _S0, _OUT, _SEED
    _S0, _OUT, _SEED = s0, out, seed


def _concat(parts: list[Path], dest: Path) -> int:
    lines = 0
    with dest.open("wb") as fh:
        for part in parts:
            with part.open("rb") as src:
                shutil.copyfileobj(src, fh, 1 << 20)
            with part.open("rb") as src:
                lines += sum(1 for _ in src)
            part.unlink()
    return lines


def generate(scale: str, out: Path, s0_root: Path, seed: int, workers: int) -> dict[str, Any]:
    replicas = SCALES[scale]
    started = time.monotonic()
    s0 = load_s0(s0_root, replicas, seed)
    prep_s = time.monotonic() - started
    kb = replace_dir(out / "kb")
    (kb / "_graph" / ".parts").mkdir(parents=True)
    (kb / "_search").mkdir()
    shutil.copytree(s0_root / "_schemas", kb / "_schemas")
    shutil.copy2(s0_root / "_graph" / "coverage.json", kb / "_graph" / "coverage.json")
    for name in ROOT_FILES:
        if (s0_root / name).is_file():
            shutil.copy2(s0_root / name, kb / name)

    ctx = mp.get_context("fork")
    with ctx.Pool(workers, initializer=_init, initargs=(s0, out, seed)) as pool:
        reports = list(pool.imap_unordered(render_replica, range(replicas)))
    parts = kb / "_graph" / ".parts"
    n_nodes = _concat(sorted(parts.glob("nodes.*.jsonl")), kb / "_graph" / "nodes.jsonl")
    n_edges = _concat(sorted(parts.glob("edges.*.jsonl")), kb / "_graph" / "edges.jsonl")
    _concat(sorted(parts.glob("search.*.jsonl")), kb / "_search" / "documents.jsonl")
    parts.rmdir()

    node_counts = Counter(n["kind"] for n in s0.nodes)
    edge_counts = Counter(e["relation"] for e in s0.edges)
    stats = {
        "nodes": {k: v * replicas for k, v in sorted(node_counts.items())},
        "edges": {k: v * replicas for k, v in sorted(edge_counts.items())},
        "node_total": len(s0.nodes) * replicas,
        "edge_total": len(s0.edges) * replicas,
    }
    assert stats["node_total"] == n_nodes and stats["edge_total"] == n_edges
    (kb / "_graph" / "stats.json").write_text(json.dumps(stats, indent=2) + "\n")
    total_bytes = sum(p.stat().st_size for p in kb.rglob("*") if p.is_file())
    files = sum(1 for p in kb.rglob("*") if p.is_file())
    manifest = {
        "scale": scale,
        "seed": seed,
        "replicas": replicas,
        "source": str(s0_root),
        "nodes": n_nodes,
        "edges": n_edges,
        "record_files": len(s0.templates) * replicas,
        "files": files,
        "bytes": total_bytes,
        "record_bytes": sum(r["record_bytes"] for r in reports),
        "workers": workers,
        "prepare_seconds": round(prep_s, 2),
        "seconds": round(time.monotonic() - started, 2),
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--scale", required=True, choices=sorted(SCALES))
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--s0", type=Path, default=DEFAULT_S0)
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--workers", type=int, default=min(4, os.cpu_count() or 1))
    args = ap.parse_args()
    manifest = generate(args.scale, args.out, args.s0, args.seed, args.workers)
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
