"""
W5, export round trip: rebuild the KB layout from the FalkorDB graph alone, compare it
with the source KB, then reload the export and check its W3 results.

What the graph holds, and so what an export can recover:
- each node's payload, as JSON in `doc` (keys sorted), its `kb_path` and `entity_kind`;
- each kind's contract and compiled schema, in the `(:Schema)` nodes;
- every edge, with its attributes (nested ones as `*_json`).
What it does not hold: Markdown bodies, the frontmatter `title`, the softschema block's
`status` and schema path (reconstructed by convention), payload key order, the export
name of nodes named by their ID (profiles), coverage.json, _search and the schemas of
kinds with no nodes (faq, media).

    python w5_export.py --scale S1 --corpus $CORPORA/S1 --data $DATA/S1 --out w5.json
"""

from __future__ import annotations

import argparse
import json
import posixpath
import shutil
import time
from collections import Counter
from pathlib import Path
from typing import Any

from fdb import GRAPH, PACKAGES, Server, corpus_info, edge_attrs, write_json  # sets sys.path first

from compare import compare  # noqa: E402
from machine import machine, package_versions  # noqa: E402
from paraverse_graph.kb import load_kb, read_artifact_document  # noqa: E402
from paraverse_graph.loader import load_graph  # noqa: E402
from w3_queries import run as run_w3  # noqa: E402
from yamlio import dump_yaml  # noqa: E402

NESTED = {"day", "term"}
PAGE = 5000


def _schema_file(kind: str) -> str:
    return f"{kind.replace('_', '-')}.schema.yaml"


def export(graph: Any, out: Path) -> dict[str, Any]:
    started = time.perf_counter()
    if out.exists():
        shutil.rmtree(out)
    (out / "_graph").mkdir(parents=True)
    (out / "_schemas").mkdir()
    schemas = {
        kind: (contract, json.loads(schema))
        for kind, contract, schema in graph.ro_query(
            "MATCH (s:Schema) RETURN s.kind, s.contract, s.schema_json"
        ).result_set
    }
    for kind, (_, schema) in schemas.items():
        if kind not in NESTED:
            (out / "_schemas" / _schema_file(kind)).write_text(dump_yaml(schema), encoding="utf-8")

    node_counts: Counter[str] = Counter()
    edge_counts: Counter[str] = Counter()
    records = 0
    last = ""
    with (
        (out / "_graph" / "nodes.jsonl").open("w", encoding="utf-8") as nodes_fh,
        (out / "_graph" / "edges.jsonl").open("w", encoding="utf-8") as edges_fh,
    ):
        while True:
            page = graph.ro_query(
                "MATCH (n:Entity) WHERE n.id > $last "
                "RETURN n.id, n.entity_kind, n.display_name, n.kb_path, n.doc ORDER BY n.id LIMIT $limit",
                {"last": last, "limit": PAGE},
            ).result_set
            if not page:
                break
            last = page[-1][0]
            ids = []
            for nid, kind, name, path, doc in page:
                ids.append(nid)
                node_counts[kind] += 1
                nodes_fh.write(json.dumps({"id": nid, "kind": kind, "name": name, "path": path}, ensure_ascii=False) + "\n")
                if kind in NESTED:
                    continue
                contract = schemas.get(kind, ("", None))[0]
                depth = posixpath.dirname(path).count("/") + 1
                block = {
                    "contract": contract,
                    "schema": "../" * depth + "_schemas/" + _schema_file(kind),
                    "envelope": kind,
                    "status": "enforced",
                }
                payload = json.loads(doc)
                dest = out / path
                dest.parent.mkdir(parents=True, exist_ok=True)
                if path.endswith(".md"):
                    text = "---\n" + dump_yaml({"title": name, "softschema": block, kind: payload}) + "---\n"
                else:
                    text = dump_yaml({"softschema": block, kind: payload})
                dest.write_text(text, encoding="utf-8")
                records += 1
            for s, rel, t, props in graph.ro_query(
                "MATCH (a:Entity)-[r]->(b:Entity) WHERE a.id IN $ids RETURN a.id, type(r), b.id, properties(r)",
                {"ids": ids},
            ).result_set:
                relation = rel.lower()
                edge_counts[relation] += 1
                edges_fh.write(json.dumps({"source": s, "relation": relation, "target": t, **edge_attrs(props)}, ensure_ascii=False) + "\n")
    stats = {
        "nodes": dict(sorted(node_counts.items())),
        "edges": dict(sorted(edge_counts.items())),
        "node_total": sum(node_counts.values()),
        "edge_total": sum(edge_counts.values()),
    }
    (out / "_graph" / "stats.json").write_text(json.dumps(stats, indent=2) + "\n")
    return {"records": records, "nodes": stats["node_total"], "edges": stats["edge_total"], "seconds": round(time.perf_counter() - started, 3)}


def _jsonl(path: Path):
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                yield json.loads(line)


def compare_kb(src: Path, exp: Path) -> dict[str, Any]:
    started = time.perf_counter()
    src_nodes = {n["id"]: n for n in _jsonl(src / "_graph" / "nodes.jsonl")}
    exp_nodes = {n["id"]: n for n in _jsonl(exp / "_graph" / "nodes.jsonl")}
    name_diffs = Counter(n["kind"] for i, n in src_nodes.items() if i in exp_nodes and exp_nodes[i]["name"] != n["name"])
    node_rows_equal = {
        i: (n["kind"], n["path"]) for i, n in src_nodes.items()
    } == {i: (n["kind"], n["path"]) for i, n in exp_nodes.items()}

    def edge_key(e: dict[str, Any]) -> str:
        return json.dumps({k: v for k, v in e.items() if v is not None}, sort_keys=True, ensure_ascii=False)

    src_edges = Counter(edge_key(e) for e in _jsonl(src / "_graph" / "edges.jsonl"))
    exp_edges = Counter(edge_key(e) for e in _jsonl(exp / "_graph" / "edges.jsonl"))

    paths = sorted({n["path"] for n in src_nodes.values() if n["kind"] not in NESTED})
    payload_equal = block_equal = title_equal = byte_equal = 0
    body_lost = 0
    payload_diffs: list[str] = []
    src_bytes = exp_bytes = 0
    for rel in paths:
        sp, ep = src / rel, exp / rel
        sb, eb = sp.read_bytes(), ep.read_bytes() if ep.exists() else b""
        src_bytes += len(sb)
        exp_bytes += len(eb)
        byte_equal += sb == eb
        sdoc, _ = read_artifact_document(sp, rel)
        edoc, _ = read_artifact_document(ep, rel) if eb else ({}, False)
        envelope = sdoc.get("softschema", {}).get("envelope")
        if sdoc.get(envelope) == edoc.get(envelope):
            payload_equal += 1
        elif len(payload_diffs) < 5:
            payload_diffs.append(rel)
        block_equal += sdoc.get("softschema") == edoc.get("softschema")
        title_equal += sdoc.get("title") == edoc.get("title")
        text = sb.decode("utf-8")
        if text.startswith("---\n"):
            body = text.split("\n---\n", 1)[1] if "\n---\n" in text else ""
            body_lost += bool(body.strip())

    src_schemas = {p.name: p for p in (src / "_schemas").glob("*.schema.yaml")}
    exp_schemas = {p.name: p for p in (exp / "_schemas").glob("*.schema.yaml")}
    import yaml

    schema_equal = sum(
        1 for name in src_schemas if name in exp_schemas
        and yaml.safe_load(src_schemas[name].read_text()) == yaml.safe_load(exp_schemas[name].read_text())
    )
    return {
        "records": len(paths),
        "payload_equal": payload_equal,
        "payload_diff_samples": payload_diffs,
        "softschema_block_equal": block_equal,
        "frontmatter_title_equal": title_equal,
        "byte_identical_files": byte_equal,
        "record_bytes_source": src_bytes,
        "record_bytes_export": exp_bytes,
        "markdown_bodies_lost": body_lost,
        "nodes_equal_by_id_kind_path": node_rows_equal,
        "node_name_differences_by_kind": dict(name_diffs),
        "edges_equal_as_multiset": src_edges == exp_edges,
        "edges_source": sum(src_edges.values()),
        "edges_export": sum(exp_edges.values()),
        "schemas_source": len(src_schemas),
        "schemas_exported": len(exp_schemas),
        "schemas_equal": schema_equal,
        "not_exported": sorted(
            {"coverage.json", "_search/documents.jsonl", "README.md", "faq.yaml", "media.yaml"}
            | {f"_schemas/{n}" for n in src_schemas if n not in exp_schemas}
        ),
        "seconds": round(time.perf_counter() - started, 3),
    }


def run(scale: str, corpus: Path, data: Path, results_dir: Path) -> dict[str, Any]:
    kb = corpus / "kb"
    work = data.parent / f"{data.name}-w5"
    shutil.rmtree(work, ignore_errors=True)
    exp = work / "export" / "kb"
    server = Server(data)
    exported = export(server.graph, exp)
    server.shutdown(save=False)
    comparison = compare_kb(kb, exp)

    # Reload the export with paraverse and run W3 on it.
    reload_dir = work / "reload"
    reload_dir.mkdir(parents=True)
    server = Server(reload_dir)
    t0 = time.perf_counter()
    load_graph(server.db, load_kb(exp), GRAPH)
    reload_s = time.perf_counter() - t0
    server.save()
    server.shutdown(save=False)
    w3 = run_w3(reload_dir, exp, scale, warm=0)
    w3_path = work / "w3-reloaded.json"
    write_json(w3_path, w3)
    ok, lines = compare(results_dir / "w3.json", w3_path, None, 3)
    shutil.rmtree(work, ignore_errors=True)
    return {
        "workflow": "W5",
        "backend": "falkordb",
        "scale": scale,
        "machine": machine([corpus, data]),
        "software": package_versions(PACKAGES),
        "corpus": corpus_info(kb),
        "export": exported,
        "comparison": comparison,
        "reload_s": round(reload_s, 3),
        "reloaded_w3_matches_source_w3": ok,
        "reloaded_w3_differences": [line for line in lines if not line.startswith("OK")][:10],
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--scale", required=True)
    ap.add_argument("--corpus", type=Path, required=True)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    write_json(args.out, run(args.scale, args.corpus, args.data, args.out.parent))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
