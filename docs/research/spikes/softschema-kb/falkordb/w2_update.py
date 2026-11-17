"""
W2, incremental accumulation, for each delta batch (1%, 5%, 20%) of a scale:

1. Full rebuild, paraverse's only update path: materialize the post-delta KB (standing
   in for the KB build), then `load_kb` + `load_graph` into the server that still holds
   the base graph, which swaps in the new graph with RENAME.
2. Incremental prototype: from the same base RDB, upsert the delta's nodes with
   paraverse's own mapping (labels_for, node_properties, readable_name), create the new
   records' edges, and bump GraphMeta's load_id so browser caches refresh. No rebuild.
   Correctness: the incremental graph must give the same W3 results and the same
   per-kind and per-relation counts as the rebuilt one.
3. Concurrency (one batch): 4 writer processes apply the incremental delta while a reader
   process loops over the W3 queries; also the reader during a full rebuild. Records
   reader latency (idle vs under load), errors and writer time.

    python w2_update.py --scale S1 --corpus $CORPORA/S1 --data $DATA/S1 --out w2.json
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fdb import GRAPH, PACKAGES, RUNNERS, Server, corpus_info, write_json
from machine import PeakSampler, machine, package_versions, percentile
from oracle import instances
from overlay import apply_delta
from paraverse_graph.kb import KbEdge, KbNode, _find_by_id, load_kb, read_artifact
from paraverse_graph.loader import BATCH_SIZE, events_channel, load_graph
from paraverse_graph.mapping import (
    ENTITY_LABEL,
    TYPED_REF,
    edge_properties,
    labels_for,
    node_properties,
    readable_name,
    relationship_type,
)

PARENT_ENVELOPE = {"day": "event", "term": "facet"}
HERE = Path(__file__).resolve().parent


def _jsonl(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def _batches(rows: list[Any], size: int = BATCH_SIZE):
    for i in range(0, len(rows), size):
        yield rows[i : i + size]


## Incremental prototype


def prepare(base_kb: Path, delta: Path, part: int = 0, parts: int = 1, graph: Any = None) -> dict:
    """
    Parse this part's share of the delta into loader-shaped rows: nodes grouped by
    labels, edges grouped by type. Updated records reuse their base node rows.
    """
    manifest = json.loads((delta / "manifest.json").read_text())
    updated = set(manifest["updated_ids"])
    new_nodes = [n for i, n in enumerate(_jsonl(delta / "nodes.jsonl")) if i % parts == part]
    upd_nodes = []
    if updated:
        with (base_kb / "_graph" / "nodes.jsonl").open(encoding="utf-8") as fh:
            for line in fh:
                row = json.loads(line)
                if row["id"] in updated:
                    upd_nodes.append(row)
        upd_nodes = [n for i, n in enumerate(sorted(upd_nodes, key=lambda r: r["id"])) if i % parts == part]
    mine = {n["id"] for n in new_nodes}
    edges = [e for e in _jsonl(delta / "edges.jsonl") if (e["source"] in mine or e["target"] in mine)]

    parsed: list[tuple[KbNode, dict[str, Any], bool]] = []
    for row, is_new in [(n, True) for n in new_nodes] + [(n, False) for n in upd_nodes]:
        node = KbNode(id=row["id"], kind=row["kind"], name=row.get("name") or row["id"], path=row["path"])
        rel = row["path"]
        artifact = read_artifact(
            delta / "records" / rel, rel, envelope_hint=PARENT_ENVELOPE.get(node.kind, node.kind)
        )
        payload = artifact.payload
        if payload.get("id") not in (node.id, node.id.split(":", 1)[-1]):
            payload = _find_by_id(payload, node.id) or payload
        parsed.append((node, payload, is_new))

    # readable_name needs the export names of referenced entities (profiles name
    # themselves after their person); look up the referenced ones in the graph.
    names = {node.id: node.name for node, _, _ in parsed}
    refs = sorted(
        {v for node, payload, _ in parsed if node.name == node.id for v in payload.values()
         if isinstance(v, str) and TYPED_REF.match(v)} - set(names)
    )
    if refs and graph is not None:
        for nid, name in graph.ro_query(
            "MATCH (n:Entity) WHERE n.id IN $ids RETURN n.id, n.display_name", {"ids": refs}
        ).result_set:
            names[nid] = name

    groups: dict[tuple[tuple[str, ...], bool], list[dict[str, Any]]] = defaultdict(list)
    for node, payload, is_new in parsed:
        props = node_properties(node, payload, display_name=readable_name(node, payload, names))
        groups[(labels_for(node, payload), is_new)].append({"id": node.id, "props": props})
    edge_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in edges:
        e = KbEdge(source=row.pop("source"), relation=row.pop("relation"), target=row.pop("target"), attrs=row)
        edge_groups[relationship_type(e.relation)].append({"s": e.source, "t": e.target, "p": edge_properties(e)})
    return {
        "nodes": dict(groups),
        "edges": dict(edge_groups),
        "counts": {"new": len(new_nodes), "updated": len(upd_nodes), "edges": len(edges)},
    }


def apply_prepared(graph: Any, prepared: dict) -> None:
    for (labels, is_new), rows in sorted(prepared["nodes"].items()):
        label_expr = ":".join(labels)
        for batch in _batches(rows):
            if is_new:
                # MERGE on the uniquely constrained id, so a replayed batch is idempotent.
                graph.query(
                    f"UNWIND $rows AS row MERGE (n:{ENTITY_LABEL} {{id: row.id}}) "
                    f"SET n = row.props SET n:{label_expr}",
                    {"rows": batch},
                )
            else:
                graph.query(
                    f"UNWIND $rows AS row MATCH (n:{ENTITY_LABEL} {{id: row.id}}) SET n = row.props",
                    {"rows": batch},
                )
    for rel_type, rows in sorted(prepared["edges"].items()):
        for batch in _batches(rows):
            graph.query(
                f"""
                UNWIND $rows AS row
                MATCH (a:{ENTITY_LABEL} {{id: row.s}})
                MATCH (b:{ENTITY_LABEL} {{id: row.t}})
                CREATE (a)-[e:{rel_type}]->(b)
                SET e += row.p
                """,
                {"rows": batch},
            )


def publish_change(server: Server) -> None:
    """What paraverse's browser watches: GraphMeta's load_id, and the reload event."""
    load_id = secrets.token_hex(16)
    loaded_at = datetime.now(UTC).isoformat(timespec="seconds")
    server.graph.query(
        "MATCH (m:GraphMeta) SET m.load_id = $id, m.loaded_at = $at", {"id": load_id, "at": loaded_at}
    )
    server.db.connection.publish(
        events_channel(GRAPH), json.dumps({"type": "graph.loaded", "load_id": load_id, "loaded_at": loaded_at})
    )


## Graph summaries for correctness


def graph_counts(graph: Any) -> dict[str, dict[str, int]]:
    nodes = graph.ro_query(f"MATCH (n:{ENTITY_LABEL}) RETURN n.entity_kind, count(n)").result_set
    edges = graph.ro_query("MATCH ()-[e]->() RETURN type(e), count(e)").result_set
    return {"nodes": dict(sorted(nodes)), "edges": {t.lower(): c for t, c in sorted(edges)}}


def w3_results(graph: Any, scale: str) -> dict[str, Any]:
    return {i["name"]: RUNNERS[i["category"]](graph, i["params"]) for i in instances(scale)}


def _norm(results: dict[str, Any]) -> dict[str, Any]:
    return {k: ({"hops": v["hops"]} if k.startswith("path.") else v) for k, v in results.items()}


def fresh_server(base_rdb: Path, work: Path) -> Server:
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    shutil.copy2(base_rdb, work / base_rdb.name)
    return Server(work)


## Reader and writer processes


def reader_main(socket: str, scale: str, stop_file: Path, out: Path) -> None:
    from falkordb import FalkorDB

    graph = FalkorDB(unix_socket_path=socket).select_graph(GRAPH)
    lat: dict[str, list[float]] = defaultdict(list)
    errors: list[str] = []
    insts = instances(scale)
    started = time.monotonic()
    while not stop_file.exists():
        for inst in insts:
            t = time.perf_counter()
            try:
                RUNNERS[inst["category"]](graph, inst["params"])
                lat[inst["category"]].append((time.perf_counter() - t) * 1000)
            except Exception as e:  # noqa: BLE001  recorded, the run continues
                errors.append(f"{inst['name']}: {e}")
    write_json(out, {"seconds": time.monotonic() - started, "latency_ms": lat, "errors": errors[:20], "error_count": len(errors)})


def writer_main(socket: str, base_kb: Path, delta: Path, part: int, parts: int, out: Path) -> None:
    from falkordb import FalkorDB

    graph = FalkorDB(unix_socket_path=socket).select_graph(GRAPH)
    t0 = time.perf_counter()
    prepared = prepare(base_kb, delta, part, parts, graph)
    t1 = time.perf_counter()
    errors = []
    try:
        apply_prepared(graph, prepared)
    except Exception as e:  # noqa: BLE001
        errors.append(str(e))
    write_json(out, {"part": part, "prepare_s": t1 - t0, "apply_s": time.perf_counter() - t1, "counts": prepared["counts"], "errors": errors})


def _summarize_reader(doc: dict[str, Any]) -> dict[str, Any]:
    out = {}
    for cat, xs in sorted(doc["latency_ms"].items()):
        out[cat] = {"n": len(xs), "p50_ms": round(percentile(xs, 50), 3), "p95_ms": round(percentile(xs, 95), 3)}
    return {"by_category": out, "errors": doc["error_count"], "error_samples": doc["errors"][:3], "seconds": round(doc["seconds"], 2)}


def _start_reader(server: Server, scale: str, tmp: Path, tag: str) -> tuple[subprocess.Popen, Path, Path]:
    stop, out = tmp / f"{tag}.stop", tmp / f"{tag}.reader.json"
    stop.unlink(missing_ok=True)
    proc = subprocess.Popen([sys.executable, __file__, "reader", "--socket", server.socket, "--scale", scale, "--stop", str(stop), "--out", str(out)])
    return proc, stop, out


def _stop_reader(proc: subprocess.Popen, stop: Path, out: Path) -> dict[str, Any]:
    stop.touch()
    proc.wait(timeout=600)
    return _summarize_reader(json.loads(out.read_text()))


def concurrency(base_rdb: Path, base_kb: Path, delta: Path, post_kb: Path, work: Path, scale: str, writers: int) -> dict:
    tmp = work / "conc"
    server = fresh_server(base_rdb, tmp / "db")
    # Idle baseline: the reader alone for a few seconds.
    proc, stop, out = _start_reader(server, scale, tmp, "idle")
    time.sleep(5.0)
    idle = _stop_reader(proc, stop, out)
    # 4 writers + reader.
    proc, stop, out = _start_reader(server, scale, tmp, "writers")
    time.sleep(1.0)
    t0 = time.perf_counter()
    wprocs = [
        subprocess.Popen([sys.executable, __file__, "writer", "--socket", server.socket, "--base-kb", str(base_kb), "--delta", str(delta), "--part", str(i), "--parts", str(writers), "--out", str(tmp / f"writer{i}.json")])
        for i in range(writers)
    ]
    codes = [p.wait(timeout=3600) for p in wprocs]
    writers_s = time.perf_counter() - t0
    publish_change(server)
    loaded = _stop_reader(proc, stop, out)
    wdocs = [json.loads((tmp / f"writer{i}.json").read_text()) for i in range(writers)]
    counts = graph_counts(server.graph)
    post_stats = json.loads((post_kb / "_graph" / "stats.json").read_text())
    counts_ok = counts["nodes"] == post_stats["nodes"] and counts["edges"] == post_stats["edges"]
    # Reader during a full rebuild of the post-delta KB into the same server.
    server.shutdown(save=False)
    server = fresh_server(base_rdb, tmp / "db")
    proc, stop, out = _start_reader(server, scale, tmp, "rebuild")
    time.sleep(1.0)
    t0 = time.perf_counter()
    load_graph(server.db, load_kb(post_kb), GRAPH)
    rebuild_s = time.perf_counter() - t0
    during_rebuild = _stop_reader(proc, stop, out)
    server.shutdown(save=False)
    shutil.rmtree(tmp)
    return {
        "writers": writers,
        "writer_exit_codes": codes,
        "writers_wall_s": round(writers_s, 3),
        "writer_reports": [{k: (round(v, 3) if isinstance(v, float) else v) for k, v in d.items()} for d in wdocs],
        "counts_match_post_delta_stats": counts_ok,
        "reader_idle": idle,
        "reader_during_writers": loaded,
        "rebuild_with_reader_s": round(rebuild_s, 3),
        "reader_during_rebuild": during_rebuild,
    }


## One batch


def run_batch(scale: str, corpus: Path, base_rdb: Path, work: Path, pct: int, check_w3: bool) -> dict:
    base_kb = corpus / "kb"
    delta = corpus / "deltas" / f"p{pct:02d}"
    manifest = json.loads((delta / "manifest.json").read_text())
    post_kb = work / f"post-p{pct:02d}" / "kb"
    t0 = time.perf_counter()
    build = apply_delta(base_kb, delta, post_kb)
    build_s = time.perf_counter() - t0
    post_stats = json.loads((post_kb / "_graph" / "stats.json").read_text())

    # 1. Full rebuild into the server holding the base graph.
    server = fresh_server(base_rdb, work / "rebuild")
    with PeakSampler({"loader": os.getpid(), "server": server.pid}) as sampler:
        t0 = time.perf_counter()
        kb = load_kb(post_kb)
        t1 = time.perf_counter()
        load_graph(server.db, kb, GRAPH)
        t2 = time.perf_counter()
    del kb
    probe = manifest["new_ids"][0]
    visible = bool(server.graph.ro_query("MATCH (n:Entity {id: $id}) RETURN n.id", {"id": probe}).result_set)
    rebuilt_counts = graph_counts(server.graph)
    rebuilt_w3 = _norm(w3_results(server.graph, scale)) if check_w3 else None
    rebuild = {
        "kb_build_s": round(build_s, 3),
        "read_kb_s": round(t1 - t0, 3),
        "load_graph_s": round(t2 - t1, 3),
        "db_visible_s": round(t2 - t0, 3),
        "total_visible_s": round(t2 - t0 + build_s, 3),
        "server_peak_rss": sampler.peak["server"],
        "loader_peak_rss_sampled": sampler.peak["loader"],
        "new_record_visible": visible,
        "counts_match_post_delta_stats": rebuilt_counts["nodes"] == post_stats["nodes"]
        and rebuilt_counts["edges"] == post_stats["edges"],
    }
    server.shutdown(save=False)

    # 2. Incremental prototype on a fresh copy of the base graph.
    server = fresh_server(base_rdb, work / "incremental")
    t0 = time.perf_counter()
    prepared = prepare(base_kb, delta, graph=server.graph)
    t1 = time.perf_counter()
    apply_prepared(server.graph, prepared)
    t2 = time.perf_counter()
    publish_change(server)
    t3 = time.perf_counter()
    visible = bool(server.graph.ro_query("MATCH (n:Entity {id: $id}) RETURN n.id", {"id": probe}).result_set)
    inc_counts = graph_counts(server.graph)
    inc_w3 = _norm(w3_results(server.graph, scale)) if check_w3 else None
    incremental = {
        "parse_and_map_s": round(t1 - t0, 3),
        "write_s": round(t2 - t1, 3),
        "publish_s": round(t3 - t2, 3),
        "db_visible_s": round(t3 - t0, 3),
        "new_record_visible": visible,
        "counts": prepared["counts"],
        "counts_match_rebuild": inc_counts == rebuilt_counts,
        "w3_match_rebuild": (inc_w3 == rebuilt_w3) if check_w3 else None,
        "w3_differences": sorted(k for k in (inc_w3 or {}) if inc_w3[k] != (rebuilt_w3 or {}).get(k)),
    }
    server.shutdown(save=False)
    return {
        "pct": pct,
        "changes": manifest["changes"],
        "new": manifest["new"],
        "updated": manifest["updated"],
        "new_edges": manifest["new_edges"],
        "post_delta_nodes": post_stats["node_total"],
        "post_delta_edges": post_stats["edge_total"],
        "kb_materialize": build,
        "full_rebuild": rebuild,
        "incremental": incremental,
    }


def run(scale: str, corpus: Path, data: Path, pcts: list[int], conc_pct: int | None, writers: int) -> dict:
    base_rdb = data / "paraverse-graph.rdb"
    work = data.parent / f"{data.name}-w2"
    batches = []
    for pct in pcts:
        print(f"batch {pct}%", flush=True)
        batches.append(run_batch(scale, corpus, base_rdb, work, pct, check_w3=True))
        if pct != conc_pct:
            shutil.rmtree(work / f"post-p{pct:02d}", ignore_errors=True)
        print(json.dumps({k: batches[-1][k] for k in ("pct", "full_rebuild", "incremental")}), flush=True)
    conc = None
    if conc_pct is not None:
        print(f"concurrency at {conc_pct}%", flush=True)
        conc = concurrency(base_rdb, corpus / "kb", corpus / "deltas" / f"p{conc_pct:02d}", work / f"post-p{conc_pct:02d}" / "kb", work, scale, writers)
        conc["pct"] = conc_pct
    shutil.rmtree(work, ignore_errors=True)
    return {
        "workflow": "W2",
        "backend": "falkordb",
        "scale": scale,
        "machine": machine([corpus, data]),
        "software": package_versions(PACKAGES),
        "corpus": corpus_info(corpus / "kb"),
        "batches": batches,
        "concurrency": conc,
        "notes": [
            "paraverse supports only full rebuilds: a new staging graph, then RENAME over the live one.",
            "kb_build_s stands in for the KB build that regenerates _graph; it hard-links the base and overlays the delta.",
            "The incremental prototype is not part of paraverse: it upserts nodes with paraverse's mapping and creates new records' edges; edge changes of updated records would need an edge diff from the build (none in these deltas).",
            "Incremental correctness: per-kind and per-relation counts and all W3 results equal those of the full rebuild.",
        ],
    }


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] in ("reader", "writer"):
        role = sys.argv.pop(1)
        ap = argparse.ArgumentParser()
        ap.add_argument("--socket", required=True)
        ap.add_argument("--out", type=Path, required=True)
        if role == "reader":
            ap.add_argument("--scale", required=True)
            ap.add_argument("--stop", type=Path, required=True)
            a = ap.parse_args()
            reader_main(a.socket, a.scale, a.stop, a.out)
        else:
            ap.add_argument("--base-kb", type=Path, required=True)
            ap.add_argument("--delta", type=Path, required=True)
            ap.add_argument("--part", type=int, required=True)
            ap.add_argument("--parts", type=int, required=True)
            a = ap.parse_args()
            writer_main(a.socket, a.base_kb, a.delta, a.part, a.parts, a.out)
        return
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--scale", required=True)
    ap.add_argument("--corpus", type=Path, required=True)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--pcts", type=int, nargs="+", default=[1, 5, 20])
    ap.add_argument("--concurrency-pct", type=int, default=5)
    ap.add_argument("--no-concurrency", action="store_true")
    ap.add_argument("--writers", type=int, default=4)
    args = ap.parse_args()
    conc = None if args.no_concurrency else args.concurrency_pct
    if conc is not None and conc not in args.pcts:
        args.pcts = sorted({*args.pcts, conc})
    write_json(args.out, run(args.scale, args.corpus, args.data, args.pcts, conc, args.writers))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
