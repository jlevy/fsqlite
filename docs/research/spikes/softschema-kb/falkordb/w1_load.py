"""
W1, full rebuild import, "paraverse as built": paraverse's `load_kb` and `load_graph`
into an empty FalkorDBLite database, then SAVE.

Phases (C11) are timed by wrapping paraverse's own module functions, so its code runs
unchanged: discover (build_snapshot, called at the start and again at the end), parse
(read_artifact and the JSONL exports; PyYAML CSafeLoader, one process, one job),
validate (paraverse's envelope and contract checks; softschema validation is not part of
paraverse's default load and is timed separately with --validate), transform
(_group_nodes, _group_edges), ingest (the UNWIND/CREATE batches), index, verify (counts
against stats.json, duplicate IDs), schemas, constraint, meta, swap (RENAME) and durable
(an explicit SAVE).

Memory (C12): the loader's peak RSS (this process); the server's peak RSS alone and with
forked children (BGSAVE), sampled every 20 ms; FalkorDB's own counters. Servable and
durable times (C13) are both recorded. `--save-mode disabled` turns Redis's save rules off
for the load (CONFIG SET save "") and SAVEs once at the end; `default` keeps redislite's
rules (`save 900 1 / 300 100 / 60 200 / 15 1000`).

A memory guard aborts the run, and records the abort as the result, when the machine's
available memory falls below `--min-available-gb` (default 2.5), so an infeasible scale
never invokes the OOM killer on other processes.

    python w1_load.py --kb $CORPORA/S1/kb --data $DATA/S1 --scale S1 --out w1.json
"""

from __future__ import annotations

import argparse
import functools
import json
import os
import resource
import shutil
import signal
import threading
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

from fdb import GRAPH, PACKAGES, Server, corpus_info, write_json  # sets sys.path first

import paraverse_graph.kb as pkb  # noqa: E402
import paraverse_graph.loader as ploader  # noqa: E402
from machine import PeakSampler, machine, package_versions, rss_bytes

PHASES: dict[str, float] = defaultdict(float)
COUNTS: dict[str, int] = defaultdict(int)


def _timed(module: Any, name: str, phase: str, materialize: bool = False) -> None:
    original = getattr(module, name)

    @functools.wraps(original)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        t = time.perf_counter()
        try:
            result = original(*args, **kwargs)
            if materialize:
                result = list(result)
            return iter(result) if materialize else result
        finally:
            PHASES[phase] += time.perf_counter() - t
            COUNTS[phase] += 1

    setattr(module, name, wrapper)


def instrument() -> None:
    _timed(pkb, "build_snapshot", "discover")
    _timed(pkb, "read_artifact", "parse_artifacts")
    _timed(pkb, "_parse_jsonl", "parse_graph_export", materialize=True)
    _timed(pkb, "_check_envelopes", "validate_envelopes")
    _timed(ploader, "_group_nodes", "transform", materialize=True)
    _timed(ploader, "_group_edges", "transform", materialize=True)
    _timed(ploader, "_create_indexes", "index")
    for name in ("_count_nodes", "_count_edges", "_compare", "_duplicate_ids"):
        _timed(ploader, name, "verify")
    _timed(ploader, "_write_schemas", "schemas")
    _timed(ploader, "_create_unique_id_constraint", "constraint")
    _timed(ploader, "_relationship_stats", "meta")


def _available_bytes() -> int:
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) * 1024
    return 0


class MemoryGuard:
    """Abort before the machine runs out of memory; the abort is the recorded result."""

    def __init__(self, min_available: int, on_abort: Any, max_rss: int = 0):
        self.min_available = min_available
        self.max_rss = max_rss
        self.on_abort = on_abort
        self.lowest = _available_bytes()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self._stop.wait(0.2):
            avail = _available_bytes()
            self.lowest = min(self.lowest, avail)
            if avail < self.min_available:
                self.on_abort(avail, f"MemAvailable {avail / 1e9:.2f} GB below {self.min_available / 1e9:.1f} GB")
            elif self.max_rss and rss_bytes(os.getpid()) > self.max_rss:
                self.on_abort(avail, f"loader RSS above the {self.max_rss / 1e9:.1f} GB cap")

    def __enter__(self) -> MemoryGuard:
        self._thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._stop.set()


def run(kb_root: Path, data: Path, scale: str, save_mode: str, min_available_gb: float, out: Path, validate: bool, max_rss_gb: float = 0.0) -> dict:
    instrument()
    if data.exists():
        shutil.rmtree(data)
    data.mkdir(parents=True)
    started = time.perf_counter()
    server = Server(data)
    if save_mode == "disabled":
        server.db.connection.config_set("save", "")
    config = server.config()
    base = {
        "workflow": "W1",
        "backend": "falkordb",
        "arm": "paraverse as built",
        "scale": scale,
        "save_mode": save_mode,
        "machine": machine([kb_root, data]),
        "software": {**package_versions(PACKAGES), "falkordb_module": server.info()["falkordb_version"], "redis_server": server.info()["redis_version"]},
        "server_config": config,
        "corpus": corpus_info(kb_root),
        "parser": {"name": "PyYAML CSafeLoader via paraverse kb.read_artifact", "processes": 1, "jobs": 1},
    }
    sampler = PeakSampler({"loader": os.getpid(), "server": server.pid})
    stage = {"phase": "parse"}

    def abort(avail: int, reason: str) -> None:
        sampler.sample()
        doc = {
            **base,
            "aborted": True,
            "abort_reason": f"memory guard: {reason}",
            "abort_stage": stage["phase"],
            "artifacts_parsed_at_abort": COUNTS["parse_artifacts"],
            "elapsed_s_at_abort": round(time.perf_counter() - started, 3),
            "phases_s_at_abort": {k: round(v, 3) for k, v in PHASES.items()},
            "memory_at_abort": {
                "loader_peak_rss": sampler.peak["loader"],
                "server_peak_rss_with_children": sampler.peak_with_children["server"],
                "machine_available": avail,
            },
        }
        write_json(out, doc)
        print(f"aborted: {doc['abort_reason']}", flush=True)
        try:
            os.kill(server.pid, signal.SIGKILL)
        finally:
            os._exit(3)

    validate_s = None
    if validate:
        from paraverse_graph.validation import validate_artifacts

        t = time.perf_counter()
        report = validate_artifacts(kb_root)
        validate_s = {"seconds": round(time.perf_counter() - t, 3), "checked": report.checked, "problems": len(report.problems)}

    with MemoryGuard(int(min_available_gb * 1e9), abort, int(max_rss_gb * 1e9)) as guard, sampler:
        t0 = time.perf_counter()
        kb = pkb.load_kb(kb_root)
        t1 = time.perf_counter()
        stage["phase"] = "load_graph"
        conn = server.db.connection
        original_exec = conn.execute_command

        def exec_timed(*args: Any, **kwargs: Any) -> Any:
            t = time.perf_counter()
            try:
                return original_exec(*args, **kwargs)
            finally:
                if args and args[0] == "RENAME":
                    PHASES["swap"] += time.perf_counter() - t

        conn.execute_command = exec_timed
        report = ploader.load_graph(server.db, kb, GRAPH)
        t2 = time.perf_counter()
        conn.execute_command = original_exec
        del kb
        stage["phase"] = "save"
        save_s = server.save()
        t3 = time.perf_counter()
    info = server.info()
    known = sum(PHASES[k] for k in ("transform", "index", "verify", "schemas", "constraint", "meta", "swap"))
    read_known = sum(PHASES[k] for k in ("discover", "parse_artifacts", "parse_graph_export", "validate_envelopes"))
    phases = {
        "discover_s": PHASES["discover"],
        "parse_s": PHASES["parse_artifacts"] + PHASES["parse_graph_export"],
        "validate_s": PHASES["validate_envelopes"],
        "read_other_s": max(0.0, (t1 - t0) - read_known),
        "transform_s": PHASES["transform"],
        "ingest_s": (t2 - t1) - known,
        "index_s": PHASES["index"],
        "verify_s": PHASES["verify"],
        "schemas_s": PHASES["schemas"],
        "constraint_s": PHASES["constraint"],
        "meta_s": PHASES["meta"],
        "swap_s": PHASES["swap"],
        "durable_save_s": save_s,
    }
    result = {
        **base,
        "aborted": False,
        "phases": {k: round(v, 3) for k, v in phases.items()},
        "phase_notes": {
            "validate_s": "paraverse's envelope and contract checks only; softschema validation is not part of paraverse's default load (see softschema_validation)",
            "read_other_s": "load_kb's payload_for pass and bookkeeping (a residual, clamped at 0)",
            "parse_s": "includes reading the files, so it depends on whether the corpus is in the OS page cache; caches are not dropped on this shared VM",
            "ingest_s": "load_graph minus every other timed phase: the UNWIND/CREATE batches for nodes and edges",
        },
        "softschema_validation": validate_s,
        "timings": {
            "server_start_s": round(server.open_seconds, 3),
            "read_kb_s": round(t1 - t0, 3),
            "load_graph_s": round(t2 - t1, 3),
            "servable_s": round(t2 - t0, 3),
            "durable_s": round(t3 - t0, 3),
            "ingest_through_durable_s": round(t3 - t1, 3),
            "wall_s": round(time.perf_counter() - started, 3),
        },
        "memory": {
            "loader_peak_rss": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
            "loader_peak_rss_sampled": sampler.peak["loader"],
            "server_peak_rss": sampler.peak["server"],
            "server_peak_rss_with_children": sampler.peak_with_children["server"],
            "server_used_memory": info["used_memory"],
            "server_used_memory_peak": info["used_memory_peak"],
            "server_used_memory_rss": info["used_memory_rss"],
            "machine_available_lowest": guard.lowest,
        },
        "size": {"rdb_bytes": server.rdb_bytes(), "data_dir_files": sorted(p.name for p in data.iterdir())},
        "load_report": {"node_total": report.node_total, "edge_total": report.edge_total, "engine": report.engine},
        "notes": [
            "load_kb parses every artifact into memory before load_graph writes; both run in this process.",
            "servable_s is files to a renamed, queryable live graph; durable_s adds the explicit SAVE.",
            "The client is paraverse's open_db with socket_timeout=None: with redis-py 8.1.0's default 5 s timeout, paraverse's own load fails at S2 in loader._count_edges (see fdb.open_embedded).",
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
    ap.add_argument("--save-mode", choices=("default", "disabled"), default="default")
    ap.add_argument("--min-available-gb", type=float, default=2.5)
    ap.add_argument("--max-rss-gb", type=float, default=0.0, help="also abort when the loader's RSS passes this")
    ap.add_argument("--validate", action="store_true", help="also time softschema validation of every artifact")
    args = ap.parse_args()
    doc = run(args.kb, args.data, args.scale, args.save_mode, args.min_available_gb, args.out, args.validate, args.max_rss_gb)
    write_json(args.out, doc)
    print(json.dumps({k: doc[k] for k in ("phases", "timings", "memory")}))


if __name__ == "__main__":
    main()
