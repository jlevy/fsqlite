"""
Write `queries.json`: the W3 query catalog with concrete parameters for every scale.

The S0 parameters below were chosen from the real KB (see the README). For synthetic
scales each entity ID is mapped to its copy in the scale's selection replica
(`corpus/idmap.py: scale_id`), which the generator guarantees to exist. Search terms and
filter values are unchanged across scales.

    python build_queries.py && pnpm exec prettier --write queries.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "corpus"))

from idmap import DEFAULT_SEED, SCALES, scale_id, selection_replica  # noqa: E402

PAGE = 50

CONVENTIONS: dict[str, str] = {
    "graph": (
        "Nodes are the rows of _graph/nodes.jsonl and edges the rows of _graph/edges.jsonl. "
        "Edge attributes are every key of an edge row except source, relation and target, "
        "with null values dropped. Relation names are compared in lower case, as in "
        "edges.jsonl (FalkorDB stores them upper case)."
    ),
    "payload": (
        "A node's payload is the envelope mapping of its artifact, parsed with paraverse's "
        "portable YAML loader (date and timestamp scalars stay strings). Day and term nodes "
        "are the mapping with the matching id inside their event or facet artifact "
        "(paraverse kb.payload_for)."
    ),
    "display_name": (
        "The nodes.jsonl name; when that equals the node id (profiles), the nodes.jsonl "
        "name of the first top-level payload string, in document order, that is a typed "
        "reference to a node whose name differs from its id (paraverse "
        "mapping.readable_name)."
    ),
    "start_epoch": (
        "For sessions: the earliest payload.slots[*].start as Unix seconds (ISO 8601; a "
        "value with no UTC offset is UTC); null when no slot has a parsable start "
        "(paraverse mapping._session_fields)."
    ),
    "scalar_strings": (
        "payload.title and payload.bio count only when they are strings that are not "
        "typed references (paraverse stores typed references as edges, not properties)."
    ),
    "ordering": (
        "Strings order by Unicode code point (SQLite BINARY collation, FalkorDB ORDER BY). "
        "Every ordering ends with a tie-break on id ascending, so results are total orders."
    ),
    "case_folding": (
        "Search terms are lower-case ASCII. A text matches when the term is a substring of "
        "the lower-cased text. The oracle checks that ASCII-only and Unicode lower-casing "
        "give identical results for every term at every scale, so either is correct."
    ),
    "hubs": (
        "Hub kinds are event, day and facet (paraverse queries.HUB_LABELS). Paths may not "
        "pass through a hub, and neighborhoods do not expand through one; a hub can still "
        "be an endpoint or a listed neighbor."
    ),
    "comparison": (
        "Results compare as canonical JSON (sorted keys). Lists are ordered as stated. "
        "Path results compare on hops only, since several shortest paths can exist; the "
        "returned path must still be a valid hub-free path of that length."
    ),
    "oracle": (
        "harness/oracle.py computes every result from the KB files and is the executable "
        "form of these definitions; harness/expected/<scale>/w3.json holds its output."
    ),
}

QUERIES: list[dict[str, Any]] = [
    {
        "name": "table.sessions_by_start.p1",
        "category": "table",
        "semantics": (
            "Sessions whose payload.sponsored is exactly false, ordered by start_epoch "
            "ascending with nulls last, then id. Return the total row count and one page: "
            "rows {id, name: display_name, value: start_epoch}."
        ),
        "s0": {"table": "sessions_by_start", "offset": 0, "limit": PAGE},
    },
    {
        "name": "table.sessions_by_start.p3",
        "category": "table",
        "semantics": "As table.sessions_by_start.p1, third page.",
        "s0": {"table": "sessions_by_start", "offset": 2 * PAGE, "limit": PAGE},
    },
    {
        "name": "table.people_by_org.p1",
        "category": "table",
        "semantics": (
            "Distinct person nodes with at least one affiliated_with edge to `org` "
            "(paraverse's rel=out:AFFILIATED_WITH:<org> table filter), ordered by "
            "display_name (code point, no case folding), then id. Rows {id, name, value: "
            "display_name}."
        ),
        "s0": {"table": "people_by_org", "org": "org:github", "offset": 0, "limit": PAGE},
        "ids": ["org"],
    },
    {
        "name": "table.people_by_org.p3",
        "category": "table",
        "semantics": "As table.people_by_org.p1, third page.",
        "s0": {"table": "people_by_org", "org": "org:github", "offset": 2 * PAGE, "limit": PAGE},
        "ids": ["org"],
    },
    {
        "name": "table.repos_by_stars.p1",
        "category": "table",
        "semantics": (
            "Repository nodes whose payload.primary_language equals `language`, ordered by "
            "payload.stars descending with nulls last, then id ascending. Rows {id, name, "
            "value: stars}."
        ),
        "s0": {"table": "repos_by_stars", "language": "Python", "offset": 0, "limit": PAGE},
    },
    {
        "name": "table.repos_by_stars.p3",
        "category": "table",
        "semantics": "As table.repos_by_stars.p1, third page.",
        "s0": {
            "table": "repos_by_stars",
            "language": "Python",
            "offset": 2 * PAGE,
            "limit": PAGE,
        },
    },
    *[
        {
            "name": f"record.{label}",
            "category": "record",
            "semantics": (
                "One entity: {id, kind, name: display_name, kb_path: nodes.jsonl path, "
                "payload, out, in}. out maps each relation to the edges leaving the entity, "
                "in to the edges arriving, each item {id: other endpoint, kind, attrs}, "
                "ordered by (id, canonical JSON of attrs). Relations are keys in sorted "
                "order; parallel edges are all listed."
            ),
            "s0": {"id": entity},
            "ids": ["id"],
        }
        for label, entity in (
            ("person", "person:dylan-ratcliffe"),
            ("session", "session:2024/dev1826d"),
            ("organization", "org:netlify"),
            ("repository", "repo:github/docs"),
        )
    ],
    *[
        {
            "name": f"search.{term.replace(' ', '_')}",
            "category": "search",
            "semantics": (
                "Every node matching `term` in display_name (rank 0), else payload.title "
                "(rank 1), else payload.bio (rank 2), across all kinds. Return the total "
                "match count and the first `limit` hits by (rank, id): {id, kind, name, rank}."
            ),
            "s0": {"term": term, "limit": 20},
        }
        for term in ("copilot", "kubernetes", "supply chain", "accessibility")
    ],
    *[
        {
            "name": f"path.{label}",
            "category": "path",
            "semantics": (
                "Shortest undirected path from `a` to `b` over every relation, at most "
                "`max_hops` edges, with no hub as an intermediate node. Return {hops, "
                "path: [a, ..., b]}; hops is null and path empty when no such path exists."
            ),
            "s0": {"a": a, "b": b, "max_hops": 4},
            "ids": ["a", "b"],
        }
        for label, a, b in (
            ("person_person_2", "person:dylan-ratcliffe", "person:pamela-fox"),
            ("person_org_3", "person:pamela-fox", "org:netlify"),
            ("person_repo_3", "person:aaron-reich", "repo:github/docs"),
            ("person_person_4", "person:francis-storr", "person:dylan-ratcliffe"),
            ("unreachable", "person:francis-storr", "repo:github/docs"),
        )
    ],
    {
        "name": "facet.sessions_per_topic",
        "category": "facet",
        "semantics": (
            "Group the about_topic edges whose source is a session by target, counting "
            "distinct sources. Return the number of groups and the top `limit` groups by "
            "(count descending, id): {id, name: display_name, count}."
        ),
        "s0": {"relation": "about_topic", "source_kind": "session", "limit": PAGE},
    },
    {
        "name": "facet.people_per_org",
        "category": "facet",
        "semantics": (
            "As facet.sessions_per_topic, for affiliated_with edges whose source is a "
            "person (people per organization)."
        ),
        "s0": {"relation": "affiliated_with", "source_kind": "person", "limit": PAGE},
    },
    *[
        {
            "name": f"neighborhood.{label}",
            "category": "neighborhood",
            "semantics": (
                "hop1: nodes adjacent to `id` in either direction. hop2: nodes adjacent to "
                "a non-hub hop1 node, minus hop1 and `id`. Return {total: |hop1| + |hop2|, "
                "hop1: |hop1|, nodes}, where nodes is the first `limit` of hop1 then hop2, "
                "each in id order: {id, kind, hop}."
            ),
            "s0": {"id": entity, "limit": 200},
            "ids": ["id"],
        }
        for label, entity in (
            ("person", "person:francis-storr"),
            ("session", "session:2024/dev1826d"),
            ("organization", "org:netlify"),
        )
    ],
]


def build() -> dict[str, Any]:
    queries = []
    for q in QUERIES:
        params = {}
        for scale in SCALES:
            p = dict(q["s0"])
            for key in q.get("ids", []):
                p[key] = scale_id(p[key], scale)
            params[scale] = p
        queries.append(
            {
                "name": q["name"],
                "category": q["category"],
                "semantics": q["semantics"],
                "params": params,
            }
        )
    return {
        "version": 1,
        "description": (
            "W3 UI queries for the softschema KB storage spike. Each entry is one measured "
            "query instance: run it once cold, then 50 times warm, and record the canonical "
            "result described by its semantics and the conventions."
        ),
        "conventions": CONVENTIONS,
        "scales": {
            scale: {
                "replicas": replicas,
                "selection_replica": selection_replica(scale),
                "seed": None if scale == "S0" else DEFAULT_SEED,
            }
            for scale, replicas in SCALES.items()
        },
        "id_mapping": (
            "Synthetic scales are replicas of S0 (corpus/idmap.py). Replica 0 keeps S0 IDs; "
            "replica r appends -r<r> to the ID (person:pamela-fox-r23). Synthetic "
            "parameters use the copies in selection_replica, which always exist."
        ),
        "result_file": {
            "path": "results/<backend>/<scale>/w3.json",
            "shape": (
                "{workflow: 'W3', backend, scale, machine, software, corpus, queries: [{name, "
                "category, params, result, timings: {cold_ms, warm_ms: [50 values], p50_ms, "
                "p95_ms}}]}. compare.py reads name, result and params."
            ),
        },
        "queries": queries,
    }


if __name__ == "__main__":
    from build_queries_v2 import build_v2  # the round-2 set is rebuilt alongside

    out = HERE / "queries.json"
    out.write_text(json.dumps(build_v2(build()), indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out}")
