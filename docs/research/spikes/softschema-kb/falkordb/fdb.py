"""
FalkorDB backend core: the embedded server as paraverse runs it, and the W3 queries in
Cypher against paraverse's graph model.

The server is FalkorDBLite (`redislite` with the FalkorDB module), opened through
paraverse's own `connection.open_db`, so its configuration (including redislite's
default `save` rules) is the one paraverse ships. Graphs are loaded only by paraverse's
`loader.load_graph`.

Every W3 query is modeled on paraverse's Cypher (browser.py `rows`, `entity`, `_related`;
queries.py `connecting_paths`, `taxonomy`) and returns the canonical result that
`harness/queries.json` defines, so `harness/compare.py` can check it against the oracle
and the other backends.
"""

from __future__ import annotations

import json
import os
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
SPIKE = HERE.parent
REPO = HERE.parents[4]
PARAVERSE_SRC = REPO / "attic" / "paraverse" / "db" / "src"
for p in (PARAVERSE_SRC, SPIKE / "harness", SPIKE / "corpus"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

from paraverse_graph.connection import engine_version, open_db  # noqa: E402
from paraverse_graph.mapping import LABELS  # noqa: E402
from paraverse_graph.queries import fulltext_query  # noqa: E402

GRAPH = "kb"
DB_FILE = "paraverse-graph.rdb"
HUB_FILTER = "x:Event OR x:Day OR x:Facet"
PACKAGES = ["falkordb", "falkordblite", "redis", "softschema", "pyyaml", "psutil"]


class Server:
    """An embedded FalkorDBLite server on one RDB file, opened the way paraverse does."""

    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.rdb = data_dir / DB_FILE
        started = time.perf_counter()
        self.db = open_db(self.rdb)
        self.open_seconds = time.perf_counter() - started
        conn = self.db.connection
        self.pid = int(Path(conn.pidfile).read_text().strip())
        self.socket = conn.socket_file

    @property
    def graph(self) -> Any:
        return self.db.select_graph(GRAPH)

    def info(self) -> dict[str, Any]:
        mem = self.db.connection.info("memory")
        server = self.db.connection.info("server")
        return {
            "redis_version": server.get("redis_version"),
            "falkordb_version": engine_version(self.db),
            "used_memory": mem.get("used_memory"),
            "used_memory_peak": mem.get("used_memory_peak"),
            "used_memory_rss": mem.get("used_memory_rss"),
        }

    def save(self) -> float:
        started = time.perf_counter()
        self.db.connection.execute_command("SAVE")
        return time.perf_counter() - started

    def rdb_bytes(self) -> int:
        return self.rdb.stat().st_size if self.rdb.exists() else 0

    def shutdown(self, save: bool = False) -> None:
        """Stop the server; redislite's own cleanup saves unless NOSAVE went first."""
        conn = self.db.connection
        if not save:
            try:
                conn.execute_command("SHUTDOWN", "NOSAVE")
            except Exception:  # noqa: BLE001  the server drops the socket as it exits
                pass
            for _ in range(400):
                if not Path(f"/proc/{self.pid}").exists():
                    break
                time.sleep(0.05)
        conn._cleanup()


## Canonical attrs


def edge_attrs(props: dict[str, Any]) -> dict[str, Any]:
    """Undo paraverse's mapping.edge_properties: decode `*_json`, drop `start_epoch`."""
    out: dict[str, Any] = {}
    for key, value in props.items():
        if key.endswith("_json") and isinstance(value, str):
            out[key[: -len("_json")]] = json.loads(value)
        elif key == "start_epoch" and isinstance(props.get("start"), str):
            continue
        else:
            out[key] = value
    return {k: v for k, v in out.items() if v is not None}


def _rows(graph: Any, cypher: str, params: dict[str, Any] | None = None) -> list[list[Any]]:
    return graph.ro_query(cypher, params or {}).result_set


## W3 queries


def q_table(graph: Any, p: dict[str, Any]) -> dict[str, Any]:
    table = p["table"]
    if table == "sessions_by_start":
        match, where, args = "MATCH (n:Session)", " WHERE n.sponsored = $f0", {"f0": False}
        order, value = "n.start_epoch IS NULL, n.start_epoch ASC, n.id", "n.start_epoch"
    elif table == "people_by_org":
        match = "MATCH (n:Person)-[:AFFILIATED_WITH]->(:Entity {id: $rel_id})"
        where, args = "", {"rel_id": p["org"]}
        order, value = "n.display_name IS NULL, n.display_name ASC, n.id", "n.display_name"
    elif table == "repos_by_stars":
        match, where = "MATCH (n:Repository)", " WHERE n.primary_language = $f0"
        args = {"f0": p["language"]}
        order, value = "n.stars IS NULL, n.stars DESC, n.id", "n.stars"
    else:
        raise ValueError(table)
    total = _rows(graph, f"{match}{where} RETURN count(DISTINCT n)", args)[0][0]
    page = _rows(
        graph,
        f"""
        {match}{where}
        WITH DISTINCT n
        ORDER BY {order}
        SKIP $offset LIMIT $limit
        RETURN n.id AS id, n.display_name AS name, {value} AS value
        """,
        {**args, "offset": p["offset"], "limit": p["limit"]},
    )
    return {"total": total, "rows": [{"id": i, "name": n, "value": v} for i, n, v in page]}


def _edge_key(item: dict[str, Any]) -> tuple[str, str]:
    return (item["id"], json.dumps(item["attrs"], sort_keys=True, ensure_ascii=False))


def q_record(graph: Any, p: dict[str, Any]) -> dict[str, Any]:
    args = {"id": p["id"]}
    kind, name, path, doc = _rows(
        graph,
        "MATCH (n:Entity {id: $id}) RETURN n.entity_kind, n.display_name, n.kb_path, n.doc",
        args,
    )[0]
    groups: dict[str, dict[str, list[dict[str, Any]]]] = {"out": defaultdict(list), "in": defaultdict(list)}
    for direction, arrow in (("out", "-[r]->"), ("in", "<-[r]-")):
        for rel, other, other_kind, props in _rows(
            graph,
            f"MATCH (n:Entity {{id: $id}}){arrow}(m:Entity) "
            "RETURN type(r), m.id, m.entity_kind, properties(r)",
            args,
        ):
            groups[direction][rel.lower()].append(
                {"id": other, "kind": other_kind, "attrs": edge_attrs(props)}
            )
    return {
        "id": p["id"],
        "kind": kind,
        "name": name,
        "kb_path": path,
        "payload": json.loads(doc),
        **{
            d: {rel: sorted(items, key=_edge_key) for rel, items in sorted(g.items())}
            for d, g in groups.items()
        },
    }


def q_search(graph: Any, p: dict[str, Any]) -> dict[str, Any]:
    total, hits = _rows(
        graph,
        """
        MATCH (n:Entity)
        WITH n, CASE
            WHEN toLower(n.display_name) CONTAINS $q THEN 0
            WHEN toLower(n.title) CONTAINS $q THEN 1
            WHEN toLower(n.bio) CONTAINS $q THEN 2
        END AS rank
        WHERE rank IS NOT NULL
        WITH n, rank ORDER BY rank, n.id
        WITH collect([n.id, n.entity_kind, n.display_name, rank]) AS hits
        RETURN size(hits), hits[0..$limit]
        """,
        {"q": p["term"], "limit": p["limit"]},
    )[0]
    return {
        "total": total,
        "hits": [{"id": i, "kind": k, "name": n, "rank": r} for i, k, n, r in hits],
    }


def q_search_fulltext(graph: Any, p: dict[str, Any]) -> dict[str, Any]:
    """paraverse's own /api/search: the RediSearch index, by score (not compared)."""
    rows = _rows(
        graph,
        """
        CALL db.idx.fulltext.queryNodes('Entity', $q) YIELD node, score
        RETURN node.id, node.entity_kind, node.display_name, score
        ORDER BY score DESC LIMIT $limit
        """,
        {"q": fulltext_query(p["term"]), "limit": 25},
    )
    return {"hits": len(rows), "top": [r[0] for r in rows[:5]]}


def q_path(graph: Any, p: dict[str, Any]) -> dict[str, Any]:
    """
    Iterative deepening over paraverse's connecting_paths pattern: the first length with
    any hub-free path is the shortest. FalkorDB has no undirected shortestPath(), and it
    cannot filter hubs inside one. Anchoring both endpoints with WITH gives an
    "Expand Into" plan, about 2x faster than paraverse's comma form.
    """
    for hops in range(1, p["max_hops"] + 1):
        rows = _rows(
            graph,
            f"""
            MATCH (a:Entity {{id: $a}}) WITH a
            MATCH (b:Entity {{id: $b}}) WITH a, b
            MATCH path = (a)-[*{hops}..{hops}]-(b)
            WHERE none(x IN nodes(path) WHERE {HUB_FILTER})
            RETURN [x IN nodes(path) | x.id]
            LIMIT 1
            """,
            {"a": p["a"], "b": p["b"]},
        )
        if rows:
            return {"hops": hops, "path": rows[0][0]}
    return {"hops": None, "path": []}


def q_facet(graph: Any, p: dict[str, Any]) -> dict[str, Any]:
    label = LABELS[p["source_kind"]]
    rel = p["relation"].upper()
    groups, top = _rows(
        graph,
        f"""
        MATCH (s:{label})-[:{rel}]->(t:Entity)
        WITH t, count(DISTINCT s) AS c
        ORDER BY c DESC, t.id
        WITH collect([t.id, t.display_name, c]) AS g
        RETURN size(g), g[0..$limit]
        """,
        {"limit": p["limit"]},
    )[0]
    return {"groups": groups, "top": [{"id": i, "name": n, "count": c} for i, n, c in top]}


def q_neighborhood(graph: Any, p: dict[str, Any]) -> dict[str, Any]:
    # Anchoring n with WITH matters: unanchored, FalkorDB's planner starts the two-hop
    # pattern from a label scan of every Entity (174 ms instead of 1.7 ms at S1).
    args = {"id": p["id"]}
    hop1 = dict(
        _rows(
            graph,
            "MATCH (n:Entity {id: $id}) WITH n "
            "MATCH (n)-[]-(m:Entity) RETURN DISTINCT m.id, m.entity_kind",
            args,
        )
    )
    hop1.pop(p["id"], None)
    hop2 = dict(
        _rows(
            graph,
            """
            MATCH (n:Entity {id: $id}) WITH n
            MATCH (n)-[]-(m:Entity) WHERE NOT (m:Event OR m:Day OR m:Facet)
            WITH DISTINCT n, m
            MATCH (m)-[]-(o:Entity) WHERE o <> n
            RETURN DISTINCT o.id, o.entity_kind
            """,
            args,
        )
    )
    for key in hop1:
        hop2.pop(key, None)
    hop2.pop(p["id"], None)
    ordered = [(1, i, hop1[i]) for i in sorted(hop1)] + [(2, i, hop2[i]) for i in sorted(hop2)]
    return {
        "total": len(hop1) + len(hop2),
        "hop1": len(hop1),
        "nodes": [{"id": i, "kind": k, "hop": h} for h, i, k in ordered[: p["limit"]]],
    }


RUNNERS = {
    "table": q_table,
    "record": q_record,
    "search": q_search,
    "path": q_path,
    "facet": q_facet,
    "neighborhood": q_neighborhood,
}


def corpus_info(kb: Path) -> dict[str, Any]:
    stats = json.loads((kb / "_graph" / "stats.json").read_text())
    manifest = kb.parent / "manifest.json"
    meta = json.loads(manifest.read_text()) if manifest.is_file() else {}
    return {
        "kb": str(kb),
        "seed": meta.get("seed"),
        "replicas": meta.get("replicas", 1),
        "nodes": stats["node_total"],
        "edges": stats["edge_total"],
        "record_files": meta.get("record_files"),
        "bytes": meta.get("bytes"),
    }


def write_json(path: Path, doc: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)
