"""
W2, round 2: apply the v2 batches (corpus/delta2.py, format softschema-kb-delta/v2) to a
round-2 corpus in both FalkorDB arms.

- paraverse as built: materialize the post-batch KB with the reference applier
  (`delta2.apply_batch`, standing in for the KB build), then `load_kb` + `load_graph`
  into the server holding the base graph (RENAME), then SAVE.
- incremental prototype: apply `ops.jsonl` in Cypher. An upsert maps the record with
  paraverse's own functions (labels_for, node_properties, readable_name, edge_properties),
  deletes the edges whose `origin` is the record (found from the record's nodes, since
  every edge is incident to a node of its origin), MERGEs the nodes and creates the new
  edge set. A delete is DETACH DELETE. A merge re-creates every edge of the absorbed
  node on the survivor (FalkorDB cannot re-point an edge), rewrites origins, and deletes
  the absorbed node. Then GraphMeta's load_id is bumped and the server SAVEs.

Checks: per-kind and per-relation counts and all W3 v2 results of the incremental graph
equal the rebuilt graph's; after p05 both are also compared with the oracle
(harness/expected/<scale>-p05). Also: trickle batches (1, 10, 100 records), a sustained
one-record-at-a-time rate, the invalid-record batch under three policies, 4 disjoint
writers with a reader, and two conflicting writers.

    python w2_v2.py --scale S1-r2 --corpus $CORPORA/S1-r2 --data $DATA/S1-r2 --out w2.json
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import statistics
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

from fdb import GRAPH, PACKAGES, Server, corpus_info, write_json  # sets sys.path first

from compare import compare  # noqa: E402
from delta2 import apply_batch  # noqa: E402
from machine import PeakSampler, machine, package_versions, percentile  # noqa: E402
from paraverse_graph.kb import KbEdge, KbNode, _find_by_id, load_kb, read_artifact  # noqa: E402
from paraverse_graph.loader import BATCH_SIZE, load_graph  # noqa: E402
from paraverse_graph.mapping import (  # noqa: E402
    ENTITY_LABEL,
    TYPED_REF,
    edge_properties,
    labels_for,
    node_properties,
    readable_name,
    relationship_type,
)
from paraverse_graph.validation import validate_artifacts  # noqa: E402
from w2_update import (  # noqa: E402
    _norm,
    _start_reader,
    _stop_reader,
    fresh_server,
    graph_counts,
    publish_change,
    w3_results,
)

PARENT_ENVELOPE = {"day": "event", "term": "facet"}
SPIKE = Path(__file__).resolve().parent.parent
BULK = ("p01", "p05", "p20")
TRICKLE = ("t0001", "t0010", "t0100")


def _jsonl(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def _batches(rows: list[Any], size: int = BATCH_SIZE):
    for i in range(0, len(rows), size):
        yield rows[i : i + size]


## Incremental prototype


def prepare(batch: Path, ops: list[dict[str, Any]], graph: Any) -> dict[str, Any]:
    """Map every upsert with paraverse's functions; group rows for batched Cypher."""
    parsed = []
    for op in ops:
        if op["op"] != "upsert":
            continue
        rel = op["path"]
        for row in op["nodes"]:
            node = KbNode(id=row["id"], kind=row["kind"], name=row.get("name") or row["id"], path=rel)
            artifact = read_artifact(batch / "records" / rel, rel, envelope_hint=PARENT_ENVELOPE.get(node.kind, node.kind))
            payload = artifact.payload
            if payload.get("id") not in (node.id, node.id.split(":", 1)[-1]):
                payload = _find_by_id(payload, node.id) or payload
            parsed.append((node, payload))
    names = {n.id: n.name for n, _ in parsed}
    refs = sorted(
        {v for n, payload in parsed if n.name == n.id for v in payload.values() if isinstance(v, str) and TYPED_REF.match(v)}
        - set(names)
    )
    if refs:
        for nid, name in graph.ro_query("MATCH (n:Entity) WHERE n.id IN $ids RETURN n.id, n.display_name", {"ids": refs}).result_set:
            names[nid] = name
    nodes: dict[tuple[str, ...], list[dict[str, Any]]] = defaultdict(list)
    for node, payload in parsed:
        nodes[labels_for(node, payload)].append(
            {"id": node.id, "props": node_properties(node, payload, display_name=readable_name(node, payload, names))}
        )
    edges: dict[str, list[dict[str, Any]]] = defaultdict(list)
    origins = []
    for op in ops:
        if op["op"] != "upsert":
            continue
        origins.append({"ids": [n["id"] for n in op["nodes"]], "path": op["path"]})
        for e in op["edges"]:
            attrs = {k: v for k, v in e.items() if k not in ("source", "relation", "target")}
            kb_edge = KbEdge(source=e["source"], relation=e["relation"], target=e["target"], attrs=attrs)
            edges[relationship_type(e["relation"])].append({"s": e["source"], "t": e["target"], "p": edge_properties(kb_edge)})
    return {
        "origins": origins,
        "nodes": dict(nodes),
        "edges": dict(edges),
        "deletes": [i for op in ops if op["op"] == "delete" for i in op["node_ids"]],
        "merges": [op for op in ops if op["op"] == "merge"],
    }


def apply_prepared(graph: Any, prep: dict[str, Any]) -> dict[str, float]:
    t: dict[str, float] = {}
    t0 = time.perf_counter()
    for batch in _batches(prep["origins"]):
        for arrow in ("-[r]->()", "<-[r]-()"):
            graph.query(
                f"UNWIND $rows AS row MATCH (n:{ENTITY_LABEL}) WHERE n.id IN row.ids "
                f"MATCH (n){arrow} WHERE r.origin = row.path DELETE r",
                {"rows": batch},
            )
    t["drop_origin_edges_s"] = time.perf_counter() - t0
    t0 = time.perf_counter()
    for labels, rows in sorted(prep["nodes"].items()):
        for batch in _batches(rows):
            graph.query(
                f"UNWIND $rows AS row MERGE (n:{ENTITY_LABEL} {{id: row.id}}) SET n = row.props SET n:{':'.join(labels)}",
                {"rows": batch},
            )
    t["upsert_nodes_s"] = time.perf_counter() - t0
    t0 = time.perf_counter()
    for rel_type, rows in sorted(prep["edges"].items()):
        for batch in _batches(rows):
            graph.query(
                f"UNWIND $rows AS row MATCH (a:{ENTITY_LABEL} {{id: row.s}}) MATCH (b:{ENTITY_LABEL} {{id: row.t}}) "
                f"CREATE (a)-[e:{rel_type}]->(b) SET e += row.p",
                {"rows": batch},
            )
    t["create_edges_s"] = time.perf_counter() - t0
    t0 = time.perf_counter()
    for batch in _batches(prep["deletes"]):
        graph.query(f"UNWIND $ids AS id MATCH (n:{ENTITY_LABEL} {{id: id}}) DETACH DELETE n", {"ids": batch})
    t["delete_s"] = time.perf_counter() - t0
    t0 = time.perf_counter()
    for m in prep["merges"]:
        merge(graph, m)
    t["merge_s"] = time.perf_counter() - t0
    return t


def merge(graph: Any, m: dict[str, Any]) -> None:
    a, b = m["absorbed"], m["survivor"]
    rows: dict[tuple[str, bool], list[dict[str, Any]]] = defaultdict(list)
    for out_dir, arrow in ((True, "-[r]->"), (False, "<-[r]-")):
        for rel, other, props in graph.ro_query(
            f"MATCH (x:{ENTITY_LABEL} {{id: $a}}){arrow}(o:{ENTITY_LABEL}) RETURN type(r), o.id, properties(r)", {"a": a}
        ).result_set:
            if not out_dir and other == a:
                continue  # a self-loop was already taken as outgoing
            if props.get("origin") == m["absorbed_path"]:
                props["origin"] = m["survivor_path"]
            rows[(rel, out_dir)].append({"o": b if other == a else other, "p": props})
    for (rel, out_dir), batch in rows.items():
        arrow = f"(s)-[e:{rel}]->(o)" if out_dir else f"(o)-[e:{rel}]->(s)"
        graph.query(
            f"MATCH (s:{ENTITY_LABEL} {{id: $b}}) UNWIND $rows AS row MATCH (o:{ENTITY_LABEL} {{id: row.o}}) "
            f"CREATE {arrow} SET e = row.p",
            {"b": b, "rows": batch},
        )
    graph.query(f"MATCH (x:{ENTITY_LABEL} {{id: $a}}) DETACH DELETE x", {"a": a})


def incremental(server: Server, batch: Path, ops: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    ops = ops if ops is not None else _jsonl(batch / "ops.jsonl")
    t0 = time.perf_counter()
    prep = prepare(batch, ops, server.graph)
    t1 = time.perf_counter()
    steps = apply_prepared(server.graph, prep)
    publish_change(server)
    t2 = time.perf_counter()
    save_s = server.save()
    return {
        "ops": len(ops),
        "parse_and_map_s": round(t1 - t0, 3),
        "steps_s": {k: round(v, 3) for k, v in steps.items()},
        "visible_s": round(t2 - t0, 3),
        "durable_s": round(t2 - t0 + save_s, 3),
    }


## paraverse as built


def rebuild(server: Server, post_kb: Path) -> dict[str, Any]:
    with PeakSampler({"loader": os.getpid(), "server": server.pid}) as sampler:
        t0 = time.perf_counter()
        kb = load_kb(post_kb)
        t1 = time.perf_counter()
        load_graph(server.db, kb, GRAPH)
        t2 = time.perf_counter()
    del kb
    save_s = server.save()
    return {
        "read_kb_s": round(t1 - t0, 3),
        "load_graph_s": round(t2 - t1, 3),
        "visible_s": round(t2 - t0, 3),
        "durable_s": round(t2 - t0 + save_s, 3),
        "loader_peak_rss": sampler.peak["loader"],
        "server_peak_rss_with_children": sampler.peak_with_children["server"],
    }


def _w3_file(graph: Any, scale: str, path: Path) -> dict[str, Any]:
    results = w3_results(graph, scale)
    from oracle import instances

    doc = {"workflow": "W3", "backend": "falkordb", "scale": scale, "queries": [{**i, "result": results[i["name"]]} for i in instances(scale)]}
    write_json(path, doc)
    return _norm(results)


def run_batch(scale: str, corpus: Path, base_rdb: Path, work: Path, name: str, out_dir: Path, do_rebuild: bool) -> dict[str, Any]:
    batch = corpus / "deltas" / name
    manifest = json.loads((batch / "manifest.json").read_text())
    result: dict[str, Any] = {"batch": name, "changes": manifest["changes"], "counts": manifest["counts"]}
    rebuilt = None
    if do_rebuild:
        post = work / f"post-{name}"
        t0 = time.perf_counter()
        build = apply_batch(corpus / "kb", batch, post)
        build_s = time.perf_counter() - t0
        server = fresh_server(base_rdb, work / "rebuild")
        r = rebuild(server, post)
        r["kb_build_s"] = round(build_s, 3)
        r["total_visible_s"] = round(build_s + r["visible_s"], 3)
        post_stats = json.loads((post / "_graph" / "stats.json").read_text())
        rebuilt_counts = graph_counts(server.graph)
        r["counts_match_post_batch_stats"] = rebuilt_counts["nodes"] == post_stats["nodes"] and rebuilt_counts["edges"] == post_stats["edges"]
        rebuilt = _w3_file(server.graph, f"{scale}-{name}", work / f"w3-rebuild-{name}.json")
        result["paraverse_as_built"] = r
        server.shutdown(save=False)
        shutil.rmtree(post, ignore_errors=True)
        result["post_batch"] = build
    server = fresh_server(base_rdb, work / "incremental")
    inc = incremental(server, batch)
    inc_counts = graph_counts(server.graph)
    w3_path = out_dir / f"w3-after-{name}.json" if name == "p05" else work / f"w3-incremental-{name}.json"
    inc_w3 = _w3_file(server.graph, f"{scale}-{name}", w3_path)
    if rebuilt is not None:
        inc["counts_match_rebuild"] = inc_counts == rebuilt_counts
        inc["w3_match_rebuild"] = inc_w3 == rebuilt
        inc["w3_differences"] = sorted(k for k in inc_w3 if inc_w3[k] != rebuilt.get(k))[:10]
    expected = SPIKE / "harness" / "expected" / f"{scale}-{name}" / "w3.json"
    if expected.is_file():
        ok, lines = compare(expected, w3_path, None, 3)
        inc["w3_matches_oracle"] = ok
        inc["oracle_differences"] = [line for line in lines if not line.startswith("OK")][:8]
    result["incremental_prototype"] = inc
    server.shutdown(save=False)
    return result


def sustained(base_rdb: Path, work: Path, batch: Path) -> dict[str, Any]:
    """Apply t0100 one operation at a time, each published before the next."""
    server = fresh_server(base_rdb, work / "sustained")
    ops = _jsonl(batch / "ops.jsonl")
    lat = []
    t0 = time.perf_counter()
    for op in ops:
        t = time.perf_counter()
        apply_prepared(server.graph, prepare(batch, [op], server.graph))
        publish_change(server)
        lat.append((time.perf_counter() - t) * 1000)
    total = time.perf_counter() - t0
    server.shutdown(save=False)
    return {
        "ops": len(ops),
        "records_per_s": round(len(ops) / total, 2),
        "visibility_ms_p50": round(percentile(lat, 50), 3),
        "visibility_ms_p95": round(percentile(lat, 95), 3),
        "note": "each op is mapped, written and published (GraphMeta load_id) before the next; no SAVE per op",
    }


def invalid_batch(scale: str, corpus: Path, base_rdb: Path, work: Path, do_rebuild: bool) -> dict[str, Any]:
    batch = corpus / "deltas" / "t0010-invalid"
    manifest = json.loads((batch / "manifest.json").read_text())
    ops = _jsonl(batch / "ops.jsonl")
    out: dict[str, Any] = {"invalid_record": manifest["invalid"]}
    post = work / "post-invalid"
    apply_batch(corpus / "kb", batch, post)
    if do_rebuild:
        server = fresh_server(base_rdb, work / "invalid-rebuild")
        try:
            load_graph(server.db, load_kb(post), GRAPH)
            loaded = bool(server.graph.ro_query("MATCH (n:Entity {id: $id}) RETURN n.id", {"id": manifest["invalid"]["id"]}).result_set)
            out["paraverse_default_load"] = {"outcome": "loads the batch, invalid record included" if loaded else "loads without it"}
        except Exception as e:  # noqa: BLE001
            out["paraverse_default_load"] = {"outcome": "rejects", "error": str(e)[:200]}
        server.shutdown(save=False)
    paths = sorted({op["path"] for op in ops if op["op"] == "upsert"})
    t0 = time.perf_counter()
    report = validate_artifacts(post, paths)
    out["paraverse_load_validate"] = {
        "outcome": "rejects the whole load (load --validate loads nothing if any artifact fails)" if report.problems else "loads",
        "problems": [p.line()[:200] for p in report.problems],
        "validate_changed_records_s": round(time.perf_counter() - t0, 3),
        "note": "load --validate re-validates every artifact, about 8.9 ms each on this VM (44 s for S0's 4,977)",
    }
    # Incremental prototype with per-record validation (against the KB's schemas):
    # quarantine the invalid record, apply the rest.
    server = fresh_server(base_rdb, work / "invalid-incremental")
    t0 = time.perf_counter()
    bad = {p.path: p.errors[:2] for p in validate_artifacts(post, paths).problems}
    keep = [op for op in ops if not (op["op"] == "upsert" and op["path"] in bad)]
    quarantined = [{"path": path, "errors": errors} for path, errors in sorted(bad.items())]
    validate_s = time.perf_counter() - t0
    inc = incremental(server, batch, keep)
    present = bool(server.graph.ro_query("MATCH (n:Entity {id: $id}) RETURN n.id", {"id": manifest["invalid"]["id"]}).result_set)
    server.shutdown(save=False)
    out["incremental_with_validation"] = {
        "outcome": "quarantines the record, applies the rest",
        "quarantined": quarantined,
        "validate_s": round(validate_s, 3),
        "applied": inc,
        "invalid_id_present_after": present,
        "note": "present after only if the record already existed (an update): the old version stays",
    }
    shutil.rmtree(post, ignore_errors=True)
    return out


def writer_main(socket: str, batch: Path, part: int, parts: int, out: Path, title: str | None, record_id: str | None) -> None:
    from falkordb import FalkorDB

    graph = FalkorDB(unix_socket_path=socket).select_graph(GRAPH)
    t0 = time.perf_counter()
    errors = []
    try:
        if title is not None:  # conflicting writer: set one record's title
            graph.query("MATCH (n:Entity {id: $id}) SET n.title = $t, n.display_name = $t", {"id": record_id, "t": title})
        else:
            ops = [op for i, op in enumerate(_jsonl(batch / "ops.jsonl")) if op["op"] == "upsert" and i % parts == part]
            apply_prepared(graph, prepare(batch, ops, graph))
    except Exception as e:  # noqa: BLE001
        errors.append(str(e)[:300])
    write_json(out, {"part": part, "seconds": round(time.perf_counter() - t0, 3), "errors": errors})


def concurrency(scale: str, corpus: Path, base_rdb: Path, work: Path, sequential_w3: dict[str, Any], sequential_counts: dict[str, Any]) -> dict[str, Any]:
    batch = corpus / "deltas" / "p05"
    tmp = work / "conc"
    server = fresh_server(base_rdb, tmp / "db")
    proc, stop, out = _start_reader(server, scale, tmp, "idle")
    time.sleep(5.0)
    idle = _stop_reader(proc, stop, out)
    proc, stop, out = _start_reader(server, scale, tmp, "writers")
    time.sleep(1.0)
    t0 = time.perf_counter()
    procs = [
        subprocess.Popen([sys.executable, __file__, "writer", "--socket", server.socket, "--batch", str(batch), "--part", str(i), "--parts", "4", "--out", str(tmp / f"w{i}.json")])
        for i in range(4)
    ]
    codes = [p.wait(timeout=3600) for p in procs]
    ops = _jsonl(batch / "ops.jsonl")
    apply_prepared(server.graph, prepare(batch, [op for op in ops if op["op"] != "upsert"], server.graph))
    publish_change(server)
    writers_s = time.perf_counter() - t0
    during = _stop_reader(proc, stop, out)
    reports = [json.loads((tmp / f"w{i}.json").read_text()) for i in range(4)]
    final_counts = graph_counts(server.graph)
    final_w3 = _norm(w3_results(server.graph, f"{scale}-p05"))
    disjoint = {
        "writers": 4,
        "exit_codes": codes,
        "writer_reports": reports,
        "wall_s": round(writers_s, 3),
        "then": "deletes and merges applied by one process after the writers",
        "final_counts_match_sequential": final_counts == sequential_counts,
        "final_w3_match_sequential": final_w3 == sequential_w3,
        "reader_idle": idle,
        "reader_during_writers": during,
    }
    # Two writers set one record to different values at the same time, 20 rounds.
    target = next(op["nodes"][0]["id"] for op in ops if op["op"] == "upsert" and op.get("change") == "update_value")
    wins: dict[str, int] = defaultdict(int)
    errors = 0
    for round_no in range(20):
        a_title, b_title = f"Writer A value {round_no}", f"Writer B value {round_no}"
        procs = [
            subprocess.Popen([sys.executable, __file__, "writer", "--socket", server.socket, "--batch", str(batch), "--part", str(i), "--parts", "2", "--out", str(tmp / f"c{i}.json"), "--title", t, "--record-id", target])
            for i, t in enumerate((a_title, b_title))
        ]
        [p.wait(timeout=600) for p in procs]
        errors += sum(len(json.loads((tmp / f"c{i}.json").read_text())["errors"]) for i in range(2))
        final = server.graph.ro_query("MATCH (n:Entity {id: $id}) RETURN n.title", {"id": target}).result_set[0][0]
        wins["A" if final == a_title else "B" if final == b_title else "other"] += 1
    server.shutdown(save=False)
    shutil.rmtree(tmp, ignore_errors=True)
    return {
        "disjoint": disjoint,
        "conflicting": {
            "record": target,
            "rounds": 20,
            "final_value_by_writer": dict(wins),
            "errors": errors,
            "both_values_recoverable": False,
            "note": "each write replaces the property; FalkorDB keeps no version history, so the losing value survives only if a snapshot happened to capture it",
        },
    }


def run(scale: str, corpus: Path, data: Path, rebuild_trickle: bool, rebuild_invalid: bool) -> dict[str, Any]:
    base_rdb = data / "paraverse-graph.rdb"
    work = data.parent / f"{data.name}-w2v2"
    out_dir = SPIKE / "results" / "falkordb" / scale
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    batches = []
    for name in BULK:
        print(f"batch {name}", flush=True)
        batches.append(run_batch(scale, corpus, base_rdb, work, name, out_dir, do_rebuild=True))
        print(json.dumps(batches[-1])[:600], flush=True)
    for name in TRICKLE:
        print(f"batch {name}", flush=True)
        batches.append(run_batch(scale, corpus, base_rdb, work, name, out_dir, do_rebuild=rebuild_trickle and name == "t0001"))
    print("sustained", flush=True)
    sus = sustained(base_rdb, work, corpus / "deltas" / "t0100")
    print("invalid", flush=True)
    inv = invalid_batch(scale, corpus, base_rdb, work, rebuild_invalid)
    print("concurrency", flush=True)
    seq = fresh_server(base_rdb, work / "seq")
    incremental(seq, corpus / "deltas" / "p05")
    seq_counts, seq_w3 = graph_counts(seq.graph), _norm(w3_results(seq.graph, f"{scale}-p05"))
    seq.shutdown(save=False)
    conc = concurrency(scale, corpus, base_rdb, work, seq_w3, seq_counts)
    shutil.rmtree(work, ignore_errors=True)
    return {
        "workflow": "W2",
        "round": 2,
        "backend": "falkordb",
        "scale": scale,
        "arms": {
            "paraverse_as_built": "delta2.apply_batch (the KB build), then paraverse load_kb + load_graph and RENAME",
            "incremental_prototype": "ops.jsonl applied in Cypher with paraverse's mapping functions; not part of paraverse",
        },
        "machine": machine([corpus, data]),
        "software": package_versions(PACKAGES),
        "corpus": corpus_info(corpus / "kb"),
        "batches": batches,
        "sustained": sus,
        "invalid_record": inv,
        "concurrency": conc,
        "notes": [
            "visible_s: until a new reader sees the change; durable_s adds an explicit SAVE (waiting out any BGSAVE).",
            "W3 after p05 for the incremental arm is in w3-after-p05.json and is compared with harness/expected/<scale>-p05.",
            "Search documents (_search) are not stored by paraverse, so batches' search rows are not applied in FalkorDB.",
        ],
    }


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "writer":
        sys.argv.pop(1)
        ap = argparse.ArgumentParser()
        ap.add_argument("--socket", required=True)
        ap.add_argument("--batch", type=Path, required=True)
        ap.add_argument("--part", type=int, required=True)
        ap.add_argument("--parts", type=int, required=True)
        ap.add_argument("--out", type=Path, required=True)
        ap.add_argument("--title")
        ap.add_argument("--record-id")
        a = ap.parse_args()
        writer_main(a.socket, a.batch, a.part, a.parts, a.out, a.title, a.record_id)
        return
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--scale", required=True)
    ap.add_argument("--corpus", type=Path, required=True)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--no-trickle-rebuild", action="store_true")
    ap.add_argument("--no-invalid-rebuild", action="store_true")
    args = ap.parse_args()
    write_json(args.out, run(args.scale, args.corpus, args.data, not args.no_trickle_rebuild, not args.no_invalid_rebuild))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
