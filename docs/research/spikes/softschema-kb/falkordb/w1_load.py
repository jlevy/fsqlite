"""
W1, full rebuild import: paraverse's `load_kb` and `load_graph` into an empty
FalkorDBLite database, then SAVE.

Records wall time per phase, the loader's peak RSS (this process), the server's peak
RSS (sampled every 20 ms, alone and with any BGSAVE child that redislite's default
`save` rules fork during the load), FalkorDB's memory counters, and the RDB size.

    python w1_load.py --kb $CORPORA/S1/kb --data $DATA/S1 --out results/falkordb/S1/w1.json
"""

from __future__ import annotations

import argparse
import os
import resource
import shutil
import time
from pathlib import Path

from fdb import GRAPH, PACKAGES, Server, corpus_info, write_json
from machine import PeakSampler, machine, package_versions
from paraverse_graph.kb import load_kb
from paraverse_graph.loader import load_graph


def run(kb_root: Path, data: Path, scale: str) -> dict:
    if data.exists():
        shutil.rmtree(data)
    data.mkdir(parents=True)
    started = time.perf_counter()
    server = Server(data)
    with PeakSampler({"loader": os.getpid(), "server": server.pid}) as sampler:
        t0 = time.perf_counter()
        kb = load_kb(kb_root)
        t1 = time.perf_counter()
        report = load_graph(server.db, kb, GRAPH)
        t2 = time.perf_counter()
    del kb
    info = server.info()
    save_s = server.save()
    rdb = server.rdb_bytes()
    result = {
        "workflow": "W1",
        "backend": "falkordb",
        "scale": scale,
        "machine": machine([kb_root, data]),
        "software": {**package_versions(PACKAGES), **{k: info[k] for k in ("redis_version", "falkordb_version")}},
        "corpus": corpus_info(kb_root),
        "timings": {
            "server_start_s": round(server.open_seconds, 3),
            "read_kb_s": round(t1 - t0, 3),
            "load_graph_s": round(t2 - t1, 3),
            "import_s": round(t2 - t0, 3),
            "save_s": round(save_s, 3),
            "wall_s": round(time.perf_counter() - started, 3),
        },
        "memory": {
            "loader_peak_rss": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
            "loader_peak_rss_sampled": sampler.peak["loader"],
            "server_peak_rss": sampler.peak["server"],
            "server_peak_rss_with_bgsave": sampler.peak_with_children["server"],
            "server_used_memory": info["used_memory"],
            "server_used_memory_peak": info["used_memory_peak"],
            "server_used_memory_rss": info["used_memory_rss"],
        },
        "size": {"rdb_bytes": rdb, "data_dir_files": sorted(p.name for p in data.iterdir())},
        "load_report": {
            "node_total": report.node_total,
            "edge_total": report.edge_total,
            "engine": report.engine,
            "loader_seconds": round(report.seconds, 3),
        },
        "notes": [
            "load_kb parses every artifact into memory before load_graph writes; both run in this process.",
            "redislite's default config keeps `save 900 1 / 300 100 / 60 200 / 15 1000`, so BGSAVE forks can run during the load.",
            "import_s is read_kb_s + load_graph_s: from files to a servable, renamed live graph.",
        ],
    }
    server.shutdown(save=False)
    return result


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--kb", type=Path, required=True)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--scale", required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    write_json(args.out, run(args.kb, args.data, args.scale))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
