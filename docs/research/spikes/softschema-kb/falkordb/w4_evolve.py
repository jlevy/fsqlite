"""
W4, schema evolution, for each variant in <corpus>/evolve/ (see corpus/evolve.py):

1. Unmodified paraverse: does `load_kb` + `load_graph` accept the variant at all?
2. Full rebuild of the variant into the server holding the base graph (paraverse's way),
   with the code change paraverse needs, if any, applied in-process.
3. In-place migration of a fresh copy of the base graph with Cypher (no rebuild),
   including the Schema and GraphMeta nodes the browser reads. Checked against the
   rebuild: per-kind and per-relation counts, W3 results, and the full properties of a
   sample of changed nodes.

    python w4_evolve.py --scale S1 --corpus $CORPORA/S1 --data $DATA/S1 --out w4.json
"""

from __future__ import annotations

import argparse
import json
import random
import shutil
import time
import traceback
from pathlib import Path
from typing import Any

from fdb import GRAPH, PACKAGES, Server, corpus_info, write_json  # sets sys.path first

import paraverse_graph.mapping as mapping  # noqa: E402
import paraverse_graph.schemas as schemas  # noqa: E402
from machine import machine, package_versions
from paraverse_graph.kb import KbNode, load_kb, read_artifact
from paraverse_graph.loader import _relationship_stats, load_graph
from paraverse_graph.mapping import labels_for, node_properties, readable_name
from paraverse_graph.schemas import load_kind_schemas
from w2_update import _norm, fresh_server, graph_counts, publish_change, w3_results

CASES = ("new_kind", "add_field", "rename_relation", "string_to_object")

# Lines of paraverse code or configuration each case needs changed for a full rebuild to
# serve it correctly, and what the in-place migration adds.
CODE_LINES = {
    "new_kind": {"rebuild": 2, "detail": "mapping.LABELS and schemas.PREFIX_KINDS entries (mapping.TYPED_REF also lists prefixes, for references to awards)", "in_place_cypher_statements": 5},
    "add_field": {"rebuild": 0, "detail": "none: top-level scalars map generically", "in_place_cypher_statements": 2},
    "rename_relation": {"rebuild": 0, "detail": "none for loading; any query naming PRESENTS (paraverse queries.py has 2) must change", "in_place_cypher_statements": 2},
    "string_to_object": {"rebuild": 0, "detail": "loads unchanged, but any filter on the field silently matches nothing until mapping.py promotes the nested value (about 4 lines)", "in_place_cypher_statements": 2},
}

NEEDS = {
    "new_kind": (
        "Code change and full rebuild. paraverse's mapping.LABELS is a fixed table, so an "
        "unknown kind fails the load with MappingError; schemas.PREFIX_KINDS and "
        "mapping.TYPED_REF also list prefixes, so references to the new kind would not be "
        "recognized as typed refs. In place, FalkorDB itself accepts new labels with no DDL."
    ),
    "add_field": (
        "Full rebuild only (no code change): top-level scalars become properties "
        "generically. In place: rewrite the changed nodes' properties and doc, and the "
        "kind's Schema node so the browser shows the column."
    ),
    "rename_relation": (
        "Full rebuild only. In place: FalkorDB cannot rename a relationship type, so each "
        "edge is re-created under the new type and the old one deleted, then GraphMeta's "
        "relationship statistics recomputed."
    ),
    "string_to_object": (
        "Full rebuild, plus a code change for any query that filtered on the field: an "
        "object is not a FalkorDB property, so the property disappears and only `doc` "
        "keeps the value. In place: rewrite the changed nodes and the Schema node."
    ),
}


def _patch_award(enable: bool) -> None:
    """The code change new_kind needs: a label and a typed-ID prefix for `award`."""
    if enable:
        mapping.LABELS["award"] = "Award"
        schemas.PREFIX_KINDS["award"] = "award"
    else:
        mapping.LABELS.pop("award", None)
        schemas.PREFIX_KINDS.pop("award", None)


def _changed_nodes(variant: Path, base: Path, case: str) -> list[dict[str, Any]]:
    """Node rows whose record file differs from the base (new or rewritten)."""
    out = []
    with (variant / "_graph" / "nodes.jsonl").open(encoding="utf-8") as fh:
        for line in fh:
            row = json.loads(line)
            if case == "new_kind" and row["kind"] != "award":
                continue
            if case in ("add_field", "string_to_object"):
                vp, bp = variant / row["path"], base / row["path"]
                if vp.stat().st_ino == bp.stat().st_ino:
                    continue
            if case == "rename_relation":
                continue
            out.append(row)
    return out


def _props_for(variant: Path, rows: list[dict[str, Any]], names: dict[str, str]) -> list[tuple[tuple[str, ...], dict[str, Any]]]:
    result = []
    for row in rows:
        node = KbNode(id=row["id"], kind=row["kind"], name=row["name"], path=row["path"])
        payload = read_artifact(variant / row["path"], row["path"], envelope_hint=row["kind"]).payload
        props = node_properties(node, payload, display_name=readable_name(node, payload, names))
        result.append((labels_for(node, payload), props))
    return result


def _write_schema_node(graph: Any, variant: Path, kind: str) -> None:
    s = load_kind_schemas(variant)[kind]
    row = {
        "kind": s.kind,
        "label": mapping.LABELS[s.kind],
        "title": s.title,
        "description": s.description,
        "contract": s.contract,
        "fields_json": json.dumps(s.fields),
        "defs_json": json.dumps(s.defs),
        "schema_json": json.dumps(s.schema),
    }
    graph.query("MERGE (s:Schema {kind: $kind}) SET s += $row", {"kind": kind, "row": row})


def migrate(server: Server, variant: Path, base: Path, case: str) -> dict[str, Any]:
    graph = server.graph
    steps: dict[str, float] = {}
    t0 = time.perf_counter()
    if case == "rename_relation":
        n = graph.query(
            "MATCH (a)-[r:PRESENTS]->(b) CREATE (a)-[r2:SPEAKS_AT]->(b) SET r2 = properties(r) DELETE r"
        ).relationships_deleted
        steps["retype_edges_s"] = time.perf_counter() - t0
        t1 = time.perf_counter()
        graph.query("MATCH (m:GraphMeta) SET m.rel_stats_json = $s", {"s": json.dumps(_relationship_stats(graph))})
        steps["rel_stats_s"] = time.perf_counter() - t1
        changed = n
    else:
        t1 = time.perf_counter()
        rows = _changed_nodes(variant, base, case)
        names = {r["id"]: r["name"] for r in rows}
        prepared = _props_for(variant, rows, names)
        steps["parse_and_map_s"] = time.perf_counter() - t1
        t1 = time.perf_counter()
        groups: dict[tuple[str, ...], list[dict[str, Any]]] = {}
        for labels, props in prepared:
            groups.setdefault(labels, []).append({"id": props["id"], "props": props})
        for labels, batch_rows in sorted(groups.items()):
            for i in range(0, len(batch_rows), 500):
                batch = batch_rows[i : i + 500]
                if case == "new_kind":
                    graph.query(
                        f"UNWIND $rows AS row CREATE (n:{':'.join(labels)}) SET n = row.props", {"rows": batch}
                    )
                else:
                    graph.query("UNWIND $rows AS row MATCH (n:Entity {id: row.id}) SET n = row.props", {"rows": batch})
        steps["write_nodes_s"] = time.perf_counter() - t1
        if case == "new_kind":
            t1 = time.perf_counter()
            graph.query("CREATE INDEX FOR (n:Award) ON (n.id)")
            edges = []
            with (variant / "_graph" / "edges.jsonl").open(encoding="utf-8") as fh:
                for line in fh:
                    if '"award:' in line:
                        e = json.loads(line)
                        edges.append({"s": e["source"], "t": e["target"], "r": e["relation"].upper()})
            for rel in sorted({e["r"] for e in edges}):
                batch = [e for e in edges if e["r"] == rel]
                graph.query(
                    f"UNWIND $rows AS row MATCH (a:Entity {{id: row.s}}) MATCH (b:Entity {{id: row.t}}) CREATE (a)-[:{rel}]->(b)",
                    {"rows": batch},
                )
            graph.query("MATCH (m:GraphMeta) SET m.rel_stats_json = $s", {"s": json.dumps(_relationship_stats(graph))})
            steps["write_edges_and_stats_s"] = time.perf_counter() - t1
        t1 = time.perf_counter()
        kind = {"new_kind": "award", "add_field": "session", "string_to_object": "repository"}[case]
        _write_schema_node(graph, variant, kind)
        steps["schema_node_s"] = time.perf_counter() - t1
        changed = len(rows)
    publish_change(server)
    return {
        "changed": changed,
        "steps_s": {k: round(v, 3) for k, v in steps.items()},
        "total_s": round(time.perf_counter() - t0, 3),
    }


def _python_repos(graph: Any) -> int:
    """What the repos_by_stars table filters on: repositories whose primary_language is Python."""
    return graph.ro_query("MATCH (n:Repository) WHERE n.primary_language = 'Python' RETURN count(n)").result_set[0][0]


def _sample_props(graph: Any, ids: list[str]) -> dict[str, Any]:
    rows = graph.ro_query(
        "MATCH (n:Entity) WHERE n.id IN $ids RETURN n.id, labels(n), properties(n)", {"ids": ids}
    ).result_set
    return {i: [sorted(labels), props] for i, labels, props in rows}


def run_case(scale: str, corpus: Path, base_rdb: Path, work: Path, case: str) -> dict[str, Any]:
    base, variant = corpus / "kb", corpus / "evolve" / case / "kb"
    result: dict[str, Any] = {"case": case, "needs": NEEDS[case]}

    # 1. Unmodified paraverse. Only new_kind needs a code change, so for the other cases
    # the full rebuild below is itself the unmodified run.
    if case == "new_kind":
        server = fresh_server(base_rdb, work / "asis")
        try:
            load_graph(server.db, load_kb(variant), GRAPH)
            result["unmodified_paraverse"] = {"loads": True}
        except Exception as e:  # noqa: BLE001
            result["unmodified_paraverse"] = {"loads": False, "error": f"{type(e).__name__}: {e}"[:300]}
        server.shutdown(save=False)
    else:
        result["unmodified_paraverse"] = {"loads": True, "note": "the full rebuild below runs unmodified paraverse"}
    result["code_changed_lines"] = CODE_LINES[case]

    # 2. Full rebuild with the needed code change.
    _patch_award(case == "new_kind")
    server = fresh_server(base_rdb, work / "rebuild")
    t0 = time.perf_counter()
    kb = load_kb(variant)
    t1 = time.perf_counter()
    load_graph(server.db, kb, GRAPH)
    t2 = time.perf_counter()
    del kb
    result["full_rebuild"] = {
        "code_change": case == "new_kind",
        "read_kb_s": round(t1 - t0, 3),
        "load_graph_s": round(t2 - t1, 3),
        "total_s": round(t2 - t0, 3),
    }
    rebuilt_counts = graph_counts(server.graph)
    rebuilt_w3 = _norm(w3_results(server.graph, scale))
    sample_ids = [r["id"] for r in _changed_nodes(variant, base, case)]
    sample_ids = random.Random(case).sample(sample_ids, min(200, len(sample_ids)))
    rebuilt_props = _sample_props(server.graph, sample_ids)
    repo_table = _python_repos(server.graph)
    server.shutdown(save=False)

    # 3. In-place migration.
    server = fresh_server(base_rdb, work / "migrate")
    base_repo_table = _python_repos(server.graph)
    result["in_place"] = migrate(server, variant, base, case)
    inc_counts = graph_counts(server.graph)
    inc_w3 = _norm(w3_results(server.graph, scale))
    inc_props = _sample_props(server.graph, sample_ids)
    props_equal = all(
        inc_props.get(i, [None, {}])[0] == rebuilt_props.get(i, [None, {}])[0]
        and {k: v for k, v in inc_props.get(i, [None, {}])[1].items()}
        == {k: v for k, v in rebuilt_props.get(i, [None, {}])[1].items()}
        for i in sample_ids
    )
    result["in_place"].update(
        {
            "counts_match_rebuild": inc_counts == rebuilt_counts,
            "w3_match_rebuild": inc_w3 == rebuilt_w3,
            "w3_differences": sorted(k for k in inc_w3 if inc_w3[k] != rebuilt_w3.get(k)),
            "sampled_nodes": len(sample_ids),
            "sampled_props_match_rebuild": props_equal,
        }
    )
    result["query_impact"] = {"python_repositories_before": base_repo_table, "python_repositories_after": repo_table}
    server.shutdown(save=False)
    _patch_award(False)
    return result


def run(scale: str, corpus: Path, data: Path, cases: list[str]) -> dict[str, Any]:
    base_rdb = data / "paraverse-graph.rdb"
    work = data.parent / f"{data.name}-w4"
    results = []
    for case in cases:
        print(f"case {case}", flush=True)
        try:
            results.append(run_case(scale, corpus, base_rdb, work, case))
        except Exception as e:  # noqa: BLE001  record and continue with the next case
            results.append({"case": case, "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-1500:]})
        print(json.dumps({k: v for k, v in results[-1].items() if k != "needs"})[:800], flush=True)
    shutil.rmtree(work, ignore_errors=True)
    return {
        "workflow": "W4",
        "backend": "falkordb",
        "scale": scale,
        "machine": machine([corpus, data]),
        "software": package_versions(PACKAGES),
        "corpus": corpus_info(corpus / "kb"),
        "cases": results,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--scale", required=True)
    ap.add_argument("--corpus", type=Path, required=True)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--cases", nargs="+", default=list(CASES), choices=CASES)
    args = ap.parse_args()
    write_json(args.out, run(args.scale, args.corpus, args.data, args.cases))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
