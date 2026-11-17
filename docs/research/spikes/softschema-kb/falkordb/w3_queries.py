"""
W3, UI queries: start the server from the W1 RDB, then run every query in
harness/queries.json once cold and 50 times warm, recording the canonical results.

"Cold" is the first run of each query after the server starts from the RDB (catalog
order). Also records paraverse's own full-text search (`/api/search`'s RediSearch
query) per term as a FalkorDB-only extra; its score order is not comparable.

    python w3_queries.py --data $DATA/S1 --kb $CORPORA/S1/kb --scale S1 \
        --out results/falkordb/S1/w3.json
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

from fdb import PACKAGES, RUNNERS, Server, corpus_info, q_search_fulltext, write_json
from machine import machine, package_versions, time_query
from oracle import instances


def run(data: Path, kb_root: Path, scale: str, warm: int) -> dict:
    t0 = time.perf_counter()
    server = Server(data)
    graph = server.graph
    graph.ro_query("MATCH (n:Entity) RETURN n.id LIMIT 1")
    ready_s = time.perf_counter() - t0
    info = server.info()
    queries = []
    for inst in instances(scale):
        fn = RUNNERS[inst["category"]]
        result, timings = time_query(lambda fn=fn, p=inst["params"]: fn(graph, p), warm)
        queries.append({**inst, "result": result, "timings": timings})
        print(f"{inst['name']:32} cold {timings['cold_ms']:9.2f}  p50 {timings['p50_ms']:9.2f}  p95 {timings['p95_ms']:9.2f} ms", flush=True)
    extras = []
    for inst in instances(scale):
        if inst["category"] == "search":
            result, timings = time_query(lambda p=inst["params"]: q_search_fulltext(graph, p), warm)
            extras.append({"name": inst["name"] + ".fulltext", "params": inst["params"], "result": result, "timings": timings})
    doc = {
        "workflow": "W3",
        "backend": "falkordb",
        "scale": scale,
        "machine": machine([kb_root, data]),
        "software": {**package_versions(PACKAGES), **{k: info[k] for k in ("redis_version", "falkordb_version")}},
        "corpus": corpus_info(kb_root),
        "server": {"start_to_first_query_s": round(ready_s, 3), "used_memory": info["used_memory"]},
        "warm_iterations": warm,
        "queries": queries,
        "extras": extras,
    }
    server.shutdown(save=False)
    return doc


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--kb", type=Path, required=True)
    ap.add_argument("--scale", required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--warm", type=int, default=50)
    args = ap.parse_args()
    write_json(args.out, run(args.data, args.kb, args.scale, args.warm))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
