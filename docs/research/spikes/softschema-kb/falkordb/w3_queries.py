"""
W3, UI queries: start the server from the W1 RDB, then run every query in
harness/queries.json once cold and 50 times warm, recording the canonical results, the
`GRAPH.EXPLAIN` plan of every statement each query ran (C7), and the server settings.

"Cold" is the first run of each query after the server starts from the RDB (catalog
order). Path queries use the same application-side bidirectional BFS as the fsqlite arm
(C5). Uncompared extras, labelled by `form`:

- `search.<term>.fulltext`: paraverse's /api/search, FalkorDB's stemmed RediSearch index;
- `path.<pair>.in_engine`: iterative deepening of paraverse's connecting_paths pattern;
- `path.<pair>.sppaths`: `algo.SPpaths`, which cannot exclude hubs.

Every statement has FalkorDB's per-query TIMEOUT (`FDB_STATEMENT_TIMEOUT_MS`, default
30 s); a timeout is recorded as the result.

    python w3_queries.py --data $DATA/S1 --kb $CORPORA/S1/kb --scale S1 \
        --out results/falkordb/S1/w3.json
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path
from typing import Any

import fdb
from fdb import (
    PACKAGES,
    RUNNERS,
    QueryTimeout,
    Server,
    corpus_info,
    explain,
    q_path_engine,
    q_path_sppaths,
    q_search_fulltext,
    write_json,
)
from machine import machine, package_versions, time_query
from oracle import instances

SPPATHS_V2 = {"v2.path.00", "v2.path.05", "v2.path.10", "v2.path.15", "v2.path.hub"}

EXTRAS = (
    ("search", "fulltext", q_search_fulltext),
    ("path", "in_engine", q_path_engine),
    ("path", "sppaths", q_path_sppaths),
)


SLOW_COLD_MS = 1000.0
SLOW_WARM = 5


def measure(graph: Any, fn: Any, params: dict[str, Any], warm: int, adaptive: bool = False) -> tuple[Any, dict[str, Any], list]:
    """
    Cold run with statement recording, then warm runs; a timeout ends the instance. With
    `adaptive` (extras only), a cold run over 1 s gets 5 warm runs instead of `warm`.
    """
    fdb.RECORDER = []
    t = time.perf_counter()
    try:
        fn(graph, params)
    except QueryTimeout as e:
        statements, fdb.RECORDER = fdb.RECORDER, None
        elapsed = (time.perf_counter() - t) * 1000
        timings = {"cold_ms": round(elapsed, 3), "warm_ms": [], "p50_ms": None, "p95_ms": None}
        return {"timeout": True, "error": str(e)[:200]}, timings, explain(graph, statements)
    statements, fdb.RECORDER = fdb.RECORDER, None
    cold_ms = (time.perf_counter() - t) * 1000
    if adaptive and cold_ms > SLOW_COLD_MS:
        warm = min(warm, SLOW_WARM)
    result, timings = time_query(lambda: fn(graph, params), warm)
    timings["warm_iterations"] = warm
    # time_query's own first call is the second run; report the recorded cold run.
    timings["cold_ms"] = round(cold_ms, 3)
    return result, timings, explain(graph, statements)


def run(data: Path, kb_root: Path, scale: str, warm: int) -> dict:
    t0 = time.perf_counter()
    server = Server(data)
    graph = server.graph
    graph.ro_query("MATCH (n:Entity) RETURN n.id LIMIT 1")
    ready_s = time.perf_counter() - t0
    info = server.info()
    queries = []
    for inst in instances(scale):
        result, timings, plans = measure(graph, RUNNERS[inst["category"]], inst["params"], warm)
        queries.append({**inst, "result": result, "timings": timings, "plans": plans})
        print(f"{inst['name']:32} cold {timings['cold_ms']:9.2f}  p50 {timings['p50_ms'] or 0:9.2f}  p95 {timings['p95_ms'] or 0:9.2f} ms", flush=True)
    by_name = {q["name"]: q for q in queries}
    extras = []
    for inst in instances(scale):
        for category, form, fn in EXTRAS:
            if inst["category"] != category:
                continue
            # Round 2 has 21 path instances; algo.SPpaths (seconds per call) runs on a sample.
            if form == "sppaths" and "-r2" in scale and inst["name"] not in SPPATHS_V2:
                continue
            result, timings, plans = measure(graph, fn, inst["params"], warm, adaptive=True)
            entry = {"name": f"{inst['name']}.{form}", "form": form, "compared": False, "params": inst["params"], "result": result, "timings": timings, "plans": plans}
            if category == "path" and "hops" in result:
                entry["hops_equal_canonical"] = result["hops"] == by_name[inst["name"]]["result"]["hops"]
            extras.append(entry)
            print(f"{entry['name']:40} cold {timings['cold_ms']:9.2f}  p50 {timings['p50_ms'] or 0:9.2f} ms", flush=True)
    doc = {
        "workflow": "W3",
        "backend": "falkordb",
        "arm": "paraverse as built (graph from paraverse load_graph)",
        "scale": scale,
        "machine": machine([kb_root, data]),
        "software": {**package_versions(PACKAGES), **{k: info[k] for k in ("redis_version", "falkordb_version")}},
        "server_config": server.config(),
        "statement_timeout_ms": fdb.STATEMENT_TIMEOUT_MS,
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
