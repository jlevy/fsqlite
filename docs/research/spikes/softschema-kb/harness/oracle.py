"""
Reference implementation of the W3 queries, computed directly from a KB directory.

This is the executable form of the semantics in `queries.json`: every backend's
canonical results must equal what this module computes from the same KB. It reads
`_graph/nodes.jsonl`, `_graph/edges.jsonl` and the artifacts the nodes point at, using
paraverse's own reader (`paraverse_graph.kb.read_artifact`) and its derived-value rules
(`readable_name` for display names, `_session_fields` for session start times), so the
definitions match what the FalkorDB loader stores.

Memory stays bounded: payloads are parsed one file at a time and only the fields the
queries need are kept, plus the full payloads of the record-view entities.

Usage:
    python oracle.py --kb DIR --scale S1 [--out expected/S1/w3.json]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
QUERIES_PATH = HERE / "queries.json"

# paraverse is the reference integration; import its reader and mapping rules.
PARAVERSE_SRC = HERE.parents[4] / "attic" / "paraverse" / "db" / "src"
if str(PARAVERSE_SRC) not in sys.path:
    sys.path.insert(0, str(PARAVERSE_SRC))

from paraverse_graph.kb import KbNode, _find_by_id, read_artifact  # noqa: E402
from paraverse_graph.mapping import (  # noqa: E402
    TYPED_REF,
    _session_fields,
    readable_name,
)

HUB_KINDS = frozenset({"event", "day", "facet"})
PARENT_ENVELOPE = {"day": "event", "term": "facet"}


def load_queries() -> dict[str, Any]:
    return json.loads(QUERIES_PATH.read_text(encoding="utf-8"))


def _scalar_str(value: Any) -> str | None:
    """A payload string as FalkorDB stores it: typed references are not properties."""
    if isinstance(value, str) and not TYPED_REF.match(value):
        return value
    return None


class KbIndex:
    """The graph plus the per-node fields the W3 queries read."""

    def __init__(self, root: Path, keep_payloads: set[str]):
        self.root = root
        self.kind: dict[str, str] = {}
        self.export_name: dict[str, str] = {}
        self.path: dict[str, str] = {}
        nodes_by_path: dict[str, list[str]] = defaultdict(list)
        with (root / "_graph" / "nodes.jsonl").open(encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                row = json.loads(line)
                nid = row["id"]
                self.kind[nid] = row["kind"]
                self.export_name[nid] = row.get("name") or nid
                self.path[nid] = row["path"]
                nodes_by_path[row["path"]].append(nid)

        self.out: dict[str, list[tuple[str, str, dict[str, Any]]]] = defaultdict(list)
        self.inc: dict[str, list[tuple[str, str, dict[str, Any]]]] = defaultdict(list)
        self.adj: dict[str, set[str]] = defaultdict(set)
        with (root / "_graph" / "edges.jsonl").open(encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                row = json.loads(line)
                s, rel, t = row.pop("source"), row.pop("relation"), row.pop("target")
                attrs = {k: v for k, v in row.items() if v is not None}
                self.out[s].append((rel, t, attrs))
                self.inc[t].append((rel, s, attrs))
                self.adj[s].add(t)
                self.adj[t].add(s)

        self.display: dict[str, str] = {}
        self.title: dict[str, str] = {}
        self.bio: dict[str, str] = {}
        self.sponsored: dict[str, Any] = {}
        self.start_epoch: dict[str, int | None] = {}
        self.stars: dict[str, Any] = {}
        self.language: dict[str, Any] = {}
        self.payload: dict[str, dict[str, Any]] = {}
        for rel_path, ids in nodes_by_path.items():
            kinds = {PARENT_ENVELOPE.get(self.kind[i], self.kind[i]) for i in ids}
            artifact = read_artifact(root / rel_path, rel_path, envelope_hint=next(iter(kinds)))
            for nid in ids:
                payload = artifact.payload
                own = payload.get("id")
                kind = self.kind[nid]
                if not (isinstance(own, str) and (own == nid or f"{kind}:{own}" == nid)):
                    payload = _find_by_id(artifact.payload, nid) or {}
                node = KbNode(id=nid, kind=kind, name=self.export_name[nid], path=rel_path)
                self.display[nid] = readable_name(node, payload, self.export_name)
                if (t := _scalar_str(payload.get("title"))) is not None:
                    self.title[nid] = t
                if (b := _scalar_str(payload.get("bio"))) is not None:
                    self.bio[nid] = b
                if kind == "session":
                    self.sponsored[nid] = payload.get("sponsored")
                    self.start_epoch[nid] = _session_fields(payload)["start_epoch"]
                elif kind == "repository":
                    self.stars[nid] = payload.get("stars")
                    self.language[nid] = payload.get("primary_language")
                if nid in keep_payloads:
                    self.payload[nid] = payload


## Query implementations


def q_table(ix: KbIndex, p: dict[str, Any]) -> dict[str, Any]:
    table = p["table"]
    if table == "sessions_by_start":
        ids = [i for i, k in ix.kind.items() if k == "session" and ix.sponsored.get(i) is False]
        value = ix.start_epoch
        ids.sort(key=lambda i: (value.get(i) is None, value.get(i) or 0, i))
        rows = [{"id": i, "name": ix.display[i], "value": value.get(i)} for i in ids]
    elif table == "people_by_org":
        org = p["org"]
        ids = sorted(
            {
                s
                for rel, s, _ in ix.inc.get(org, [])
                if rel == "affiliated_with" and ix.kind[s] == "person"
            },
            key=lambda i: (ix.display[i], i),
        )
        rows = [{"id": i, "name": ix.display[i], "value": ix.display[i]} for i in ids]
    elif table in ("repos_by_stars", "repos_all_by_stars"):
        lang = p.get("language")
        ids = [
            i
            for i, k in ix.kind.items()
            if k == "repository" and (table == "repos_all_by_stars" or ix.language.get(i) == lang)
        ]
        stars = ix.stars
        ids.sort(key=lambda i: (stars.get(i) is None, -(stars.get(i) or 0), i))
        rows = [{"id": i, "name": ix.display[i], "value": stars.get(i)} for i in ids]
    else:
        raise ValueError(f"unknown table {table}")
    off, lim = p["offset"], p["limit"]
    if off == "last":
        off = max(0, (len(rows) - 1) // lim * lim)
        return {"total": len(rows), "offset": off, "rows": rows[off : off + lim]}
    return {"total": len(rows), "rows": rows[off : off + lim]}


def _edge_key(item: dict[str, Any]) -> tuple[str, str]:
    return (item["id"], json.dumps(item["attrs"], sort_keys=True, ensure_ascii=False))


def q_record(ix: KbIndex, p: dict[str, Any]) -> dict[str, Any]:
    nid = p["id"]
    out: dict[str, list[dict[str, Any]]] = defaultdict(list)
    inc: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for rel, t, attrs in ix.out.get(nid, []):
        out[rel].append({"id": t, "kind": ix.kind[t], "attrs": attrs})
    for rel, s, attrs in ix.inc.get(nid, []):
        inc[rel].append({"id": s, "kind": ix.kind[s], "attrs": attrs})
    return {
        "id": nid,
        "kind": ix.kind[nid],
        "name": ix.display[nid],
        "kb_path": ix.path[nid],
        "payload": ix.payload[nid],
        "out": {rel: sorted(items, key=_edge_key) for rel, items in sorted(out.items())},
        "in": {rel: sorted(items, key=_edge_key) for rel, items in sorted(inc.items())},
    }


def _ascii_lower(text: str) -> str:
    return text.translate(_ASCII_LOWER)


_ASCII_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")


def search_rank(ix: KbIndex, nid: str, term: str, lower=str.lower) -> int | None:
    if term in lower(ix.display[nid]):
        return 0
    if nid in ix.title and term in lower(ix.title[nid]):
        return 1
    if nid in ix.bio and term in lower(ix.bio[nid]):
        return 2
    return None


def q_search(ix: KbIndex, p: dict[str, Any]) -> dict[str, Any]:
    term = p["term"]
    hits = []
    for nid in ix.kind:
        rank = search_rank(ix, nid, term)
        # Fold invariance: ASCII-only lowering must give the same answer, so a backend
        # with ASCII-only lower() (SQLite) or Unicode lower() (FalkorDB) matches too.
        if rank != search_rank(ix, nid, term, _ascii_lower):
            raise ValueError(f"search term {term!r} is not fold-invariant at {nid}")
        if rank is not None:
            hits.append((rank, nid))
    hits.sort()
    return {
        "total": len(hits),
        "hits": [
            {"id": i, "kind": ix.kind[i], "name": ix.display[i], "rank": r}
            for r, i in hits[: p["limit"]]
        ],
    }


def q_path(ix: KbIndex, p: dict[str, Any]) -> dict[str, Any]:
    """Breadth-first search; hubs may be endpoints but never intermediate nodes."""
    a, b, max_hops = p["a"], p["b"], p["max_hops"]
    if a == b:
        return {"hops": 0, "path": [a]}
    parent: dict[str, str | None] = {a: None}
    frontier = [a]
    for depth in range(1, max_hops + 1):
        nxt = []
        for u in frontier:
            if u != a and ix.kind[u] in HUB_KINDS:
                continue
            for v in sorted(ix.adj.get(u, ())):
                if v in parent:
                    continue
                parent[v] = u
                if v == b:
                    path = [v]
                    while parent[path[-1]] is not None:
                        path.append(parent[path[-1]])  # type: ignore[arg-type]
                    return {"hops": depth, "path": path[::-1]}
                nxt.append(v)
        frontier = nxt
    return {"hops": None, "path": []}


def q_facet(ix: KbIndex, p: dict[str, Any]) -> dict[str, Any]:
    rel, src_kind, limit = p["relation"], p["source_kind"], p["limit"]
    groups: dict[str, set[str]] = defaultdict(set)
    for s, edges in ix.out.items():
        if ix.kind[s] != src_kind:
            continue
        for r, t, _ in edges:
            if r == rel:
                groups[t].add(s)
    ordered = sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    return {
        "groups": len(groups),
        "top": [{"id": g, "name": ix.display[g], "count": len(m)} for g, m in ordered[:limit]],
    }


def q_neighborhood(ix: KbIndex, p: dict[str, Any]) -> dict[str, Any]:
    nid, cap = p["id"], p["limit"]
    hop1 = set(ix.adj.get(nid, ())) - {nid}
    hop2: set[str] = set()
    for m in hop1:
        if ix.kind[m] in HUB_KINDS:
            continue
        hop2 |= ix.adj.get(m, set())
    hop2 -= hop1 | {nid}
    ordered = [(1, i) for i in sorted(hop1)] + [(2, i) for i in sorted(hop2)]
    return {
        "total": len(hop1) + len(hop2),
        "hop1": len(hop1),
        "nodes": [{"id": i, "kind": ix.kind[i], "hop": h} for h, i in ordered[:cap]],
    }


RUNNERS = {
    "table": q_table,
    "record": q_record,
    "search": q_search,
    "path": q_path,
    "facet": q_facet,
    "neighborhood": q_neighborhood,
}


def instances(scale: str, catalog: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """
    The query instances for a scale: name, category and concrete parameters. Round-2
    scales (`S1-r2`, and after-delta states such as `S1-r2-p05`) use `queries_v2`.
    """
    catalog = catalog or load_queries()
    v2 = "-r2" in scale
    key = "queries_v2" if v2 else "queries"
    params_scale = scale.split("-r2")[0] + "-r2" if v2 else scale
    return [
        {"name": q["name"], "category": q["category"], "params": q["params"][params_scale]}
        for q in catalog[key]
    ]


def run_all(kb_root: Path, scale: str) -> dict[str, Any]:
    insts = instances(scale)
    keep = {i["params"]["id"] for i in insts if i["category"] == "record"}
    started = time.monotonic()
    ix = KbIndex(kb_root, keep)
    index_s = time.monotonic() - started
    results = []
    for inst in insts:
        result = RUNNERS[inst["category"]](ix, inst["params"])
        results.append({**inst, "result": result})
    return {
        "workflow": "W3",
        "backend": "oracle",
        "scale": scale,
        "kb_root": str(kb_root),
        "index_seconds": round(index_s, 3),
        "nodes": len(ix.kind),
        "queries": results,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--kb", type=Path, required=True)
    ap.add_argument("--scale", required=True)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()
    doc = run_all(args.kb, args.scale)
    text = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main()
