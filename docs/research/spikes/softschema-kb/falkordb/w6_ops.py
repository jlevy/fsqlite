"""
W6, operations, from the W1 database of a scale:

- artifacts: files in the data directory and in redislite's runtime directory;
- standard tools: what can read the RDB without a FalkorDB server;
- serving start-up: spawning the server on the RDB until the first query answers;
- resident memory at rest;
- crash safety (C25): SIGKILL the client (loader) mid-load; SIGKILL the server mid-load;
  SIGKILL the server a few seconds after a completed load. Each records orphan staging
  graphs, what the restarted server serves (by GraphMeta load_id) and whether the next
  load succeeds.

    python w6_ops.py --scale S1 --corpus $CORPORA/S1 --data $DATA/S1 --out w6.json
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from fdb import GRAPH, PACKAGES, Server, corpus_info, write_json
from machine import machine, package_versions, rss_bytes
from w2_update import fresh_server, graph_counts

STAGING = f"{GRAPH}__staging_"


def loader_main(socket: str, kb: Path) -> None:
    from falkordb import FalkorDB
    from paraverse_graph.kb import load_kb
    from paraverse_graph.loader import load_graph

    db = FalkorDB(unix_socket_path=socket)
    load_graph(db, load_kb(kb), GRAPH)


def _spawn_loader(server: Server, kb: Path) -> subprocess.Popen:
    return subprocess.Popen(
        [sys.executable, __file__, "loader", "--socket", server.socket, "--kb", str(kb)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )


def _graphs(server: Server) -> list[str]:
    return sorted(server.db.list_graphs())


def _wait_for_staging(server: Server, timeout: float) -> float:
    t0 = time.perf_counter()
    while time.perf_counter() - t0 < timeout:
        if any(g.startswith(STAGING) for g in _graphs(server)):
            return time.perf_counter() - t0
        time.sleep(0.05)
    raise TimeoutError("no staging graph appeared")


def _staging_nodes(server: Server) -> dict[str, int]:
    out = {}
    for g in _graphs(server):
        if g.startswith(STAGING):
            out[g] = server.db.select_graph(g).ro_query("MATCH (n) RETURN count(n)").result_set[0][0]
    return out


def crash_loader(base_rdb: Path, kb: Path, work: Path, kill_after: float) -> dict[str, Any]:
    server = fresh_server(base_rdb, work / "crash-loader")
    before = graph_counts(server.graph)
    proc = _spawn_loader(server, kb)
    staged_after = _wait_for_staging(server, 600)
    time.sleep(kill_after)
    proc.send_signal(signal.SIGKILL)
    proc.wait()
    after = graph_counts(server.graph)
    orphans = _staging_nodes(server)
    t0 = time.perf_counter()
    proc = _spawn_loader(server, kb)
    rc = proc.wait(timeout=3600)
    retry_s = time.perf_counter() - t0
    result = {
        "staging_appeared_after_s": round(staged_after, 3),
        "killed_after_staging_s": kill_after,
        "live_graph_unchanged": after == before,
        "orphan_staging_graphs": orphans,
        "retry_exit_code": rc,
        "retry_s": round(retry_s, 3),
        "live_graph_after_retry_matches_kb": graph_counts(server.graph) == before,
        "graphs_after_retry": _graphs(server),
    }
    server.shutdown(save=False)
    return result


def crash_server(base_rdb: Path, kb: Path, work: Path, kill_after: float) -> dict[str, Any]:
    data = work / "crash-server"
    server = fresh_server(base_rdb, data)
    before = graph_counts(server.graph)
    old_id = _load_id(server)
    proc = _spawn_loader(server, kb)
    _wait_for_staging(server, 600)
    time.sleep(kill_after)
    os.kill(server.pid, signal.SIGKILL)
    rc = proc.wait(timeout=600)
    err = (proc.stderr.read() or b"").decode(errors="replace").strip().splitlines()
    server.db.connection.running = False
    rdb_ok = (data / base_rdb.name).is_file()
    t0 = time.perf_counter()
    restart_error = None
    try:
        server = Server(data)
    except Exception as e:  # noqa: BLE001  redislite trips over its stale registry
        restart_error = f"{type(e).__name__}: {e}"[:200]
        (data / f"{base_rdb.name}.settings").unlink(missing_ok=True)
        server = Server(data)
    restart_s = time.perf_counter() - t0
    graphs = _graphs(server)
    after = graph_counts(server.graph) if GRAPH in graphs else None
    served = _load_id(server) if GRAPH in graphs else None
    orphans = _staging_nodes(server)
    t0 = time.perf_counter()
    proc = _spawn_loader(server, kb)
    retry_rc = proc.wait(timeout=3600)
    retry_s = time.perf_counter() - t0
    result = {
        "killed_after_staging_s": kill_after,
        "loader_exit_code": rc,
        "loader_error": err[-1][:200] if err else None,
        "rdb_present_after_kill": rdb_ok,
        "restart_error_before_manual_cleanup": restart_error,
        "restart_s": round(restart_s, 3),
        "graphs_after_restart": graphs,
        "live_graph_intact_after_restart": after == before,
        "restarted_serves": "previous load" if served == old_id else f"other ({served})",
        "orphan_staging_graphs_after_restart": orphans,
        "retry_exit_code": retry_rc,
        "retry_s": round(retry_s, 3),
        "live_graph_after_retry_matches_kb": graph_counts(server.graph) == before,
    }
    server.shutdown(save=False)
    return result


def _load_id(server: Server) -> str | None:
    rows = server.graph.ro_query("MATCH (m:GraphMeta) RETURN m.load_id").result_set
    return rows[0][0] if rows else None


def _restart(data: Path, rdb_name: str) -> tuple[Server, float, str | None]:
    t0 = time.perf_counter()
    error = None
    try:
        server = Server(data)
    except Exception as e:  # noqa: BLE001  redislite trips over its stale registry
        error = f"{type(e).__name__}: {e}"[:200]
        (data / f"{rdb_name}.settings").unlink(missing_ok=True)
        server = Server(data)
    return server, time.perf_counter() - t0, error


def crash_after_load(base_rdb: Path, kb: Path, work: Path, kill_after: float) -> dict[str, Any]:
    """SIGKILL the server `kill_after` seconds after a load completed (RENAME done)."""
    data = work / "crash-after-load"
    server = fresh_server(base_rdb, data)
    old_id = _load_id(server)
    proc = _spawn_loader(server, kb)
    rc = proc.wait(timeout=3600)
    done = time.perf_counter()
    new_id = _load_id(server)
    last_save = server.db.connection.lastsave()
    time.sleep(kill_after)
    bgsave_ran = server.db.connection.lastsave() != last_save
    os.kill(server.pid, signal.SIGKILL)
    killed_after = time.perf_counter() - done
    server.db.connection.running = False
    server, restart_s, error = _restart(data, base_rdb.name)
    served = _load_id(server)
    result = {
        "loader_exit_code": rc,
        "killed_after_completed_load_s": round(killed_after, 3),
        "bgsave_between_load_and_kill": bgsave_ran,
        "restart_error_before_manual_cleanup": error,
        "restart_s": round(restart_s, 3),
        "restarted_serves": "new load" if served == new_id else "previous load" if served == old_id else f"other ({served})",
        "graphs_after_restart": _graphs(server),
        "orphan_staging_graphs_after_restart": _staging_nodes(server),
    }
    server.shutdown(save=False)
    return result


def standard_tools(rdb: Path, work: Path) -> dict[str, Any]:
    import redislite

    binary = Path(redislite.__file__).parent / "bin" / "redis-server"
    check = work / "redis-check-rdb"
    check.parent.mkdir(parents=True, exist_ok=True)
    if not check.exists():
        check.symlink_to(binary)
    proc = subprocess.run([str(check), str(rdb)], capture_output=True, text=True, timeout=600)
    tail = [line for line in (proc.stdout + proc.stderr).splitlines() if line.strip()][-3:]
    magic = rdb.read_bytes()[:9].decode(errors="replace")
    stock = shutil.which("redis-server", path="/usr/bin:/usr/local/bin:/bin")
    stock_result = None
    if stock:
        d = work / "stock-redis"
        d.mkdir(parents=True, exist_ok=True)
        shutil.copy2(rdb, d / "dump.rdb")
        sock = d / "s.sock"
        proc = subprocess.Popen(
            [stock, "--port", "0", "--unixsocket", str(sock), "--dir", str(d), "--dbfilename", "dump.rdb", "--save", ""],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        try:
            out, _ = proc.communicate(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()
            out, _ = proc.communicate()
        version = subprocess.run([stock, "--version"], capture_output=True, text=True).stdout.strip()
        stock_result = {
            "binary": stock,
            "version": version,
            "exit_code": proc.returncode,
            "log_tail": [line.split("* ")[-1].split("# ")[-1] for line in out.splitlines() if line.strip()][-3:],
        }
        (d / "dump.rdb").unlink(missing_ok=True)
    return {
        "rdb_magic": magic,
        "redis_check_rdb_exit_code": proc.returncode,
        "redis_check_rdb_tail": tail,
        "stock_redis_server_without_module": stock_result,
        "notes": [
            "redis_check_rdb is the bundled binary in check mode: it validates the file's structure, not the graph contents.",
            "The RDB is Redis's binary snapshot format; graphs are module values that only a redis-server with the FalkorDB module can load.",
            "Any Redis client (redis-cli, redis-py) can query a running server with GRAPH.QUERY; nothing reads the file directly.",
        ],
    }


def startup(data: Path, repeats: int = 3) -> dict[str, Any]:
    times, rss, used = [], [], []
    for _ in range(repeats):
        t0 = time.perf_counter()
        server = Server(data)
        server.graph.ro_query("MATCH (n:Entity) RETURN n.id LIMIT 1")
        times.append(time.perf_counter() - t0)
        time.sleep(2.0)
        rss.append(rss_bytes(server.pid))
        used.append(server.info()["used_memory"])
        server.shutdown(save=False)
    return {
        "start_to_first_query_s": [round(t, 3) for t in times],
        "median_s": round(statistics.median(times), 3),
        "server_rss_at_rest": int(statistics.median(rss)),
        "server_used_memory_at_rest": int(statistics.median(used)),
    }


def run(scale: str, corpus: Path, data: Path, w1: dict[str, Any] | None) -> dict[str, Any]:
    kb = corpus / "kb"
    rdb = data / "paraverse-graph.rdb"
    work = data.parent / f"{data.name}-w6"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    server = Server(data)
    runtime_dir = Path(server.db.connection.redis_dir)
    runtime = sorted(p.name for p in runtime_dir.iterdir())
    server.shutdown(save=False)
    artifacts = {
        "data_dir": {p.name: p.stat().st_size for p in sorted(data.iterdir())},
        "runtime_dir_while_serving": runtime,
        "count": len(list(data.iterdir())),
        "bytes": sum(p.stat().st_size for p in data.iterdir()),
    }
    load_s = (w1 or {}).get("timings", {}).get("load_graph_s", 5.0)
    print("startup", flush=True)
    start = startup(data)
    print("tools", flush=True)
    tools = standard_tools(rdb, work)
    print("crash: loader", flush=True)
    loader = crash_loader(rdb, kb, work, kill_after=round(load_s * 0.4, 2))
    print("crash: server", flush=True)
    srv = crash_server(rdb, kb, work, kill_after=round(load_s * 0.4, 2))
    print("crash: server after a completed load", flush=True)
    after = crash_after_load(rdb, kb, work, kill_after=5.0)
    shutil.rmtree(work, ignore_errors=True)
    return {
        "workflow": "W6",
        "backend": "falkordb",
        "scale": scale,
        "machine": machine([corpus, data]),
        "software": package_versions(PACKAGES),
        "corpus": corpus_info(kb),
        "artifacts": artifacts,
        "standard_tools": tools,
        "startup": start,
        "crash_loader_killed": loader,
        "crash_server_killed": srv,
        "crash_server_killed_after_load": after,
    }


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "loader":
        ap = argparse.ArgumentParser()
        ap.add_argument("role")
        ap.add_argument("--socket", required=True)
        ap.add_argument("--kb", type=Path, required=True)
        a = ap.parse_args()
        loader_main(a.socket, a.kb)
        return
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--scale", required=True)
    ap.add_argument("--corpus", type=Path, required=True)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    w1_path = args.out.parent / "w1.json"
    w1 = json.loads(w1_path.read_text()) if w1_path.is_file() else None
    write_json(args.out, run(args.scale, args.corpus, args.data, w1))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
