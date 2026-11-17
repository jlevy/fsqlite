"""
Add the round-2 query set to `queries.json` (`v2` and `queries_v2`), leaving the 24
round-1 instances in `queries` unchanged.

    python build_queries_v2.py && (cd ../../../../.. && pnpm exec prettier --write \
        docs/research/spikes/softschema-kb/harness/queries.json)

Selection is seeded and uses only S0 (degrees, hub-free distances, term frequencies)
and the generator's ID mapping, so every parameter exists in every round-2 corpus:
- record and neighborhood: 10 kinds by size, a low-degree (bottom half) and a
  high-degree (top tenth) entity of each;
- path: pairs at S0 hub-free distance 2, 3, 4 and beyond 4, five each, half with both
  endpoints in one replica and half across replicas;
- search: 7 rare, 7 medium and 6 common S0 vocabulary words, each checked for
  fold invariance on S0;
- facet: the 20 most frequent (relation, source kind) pairs;
- table: session pages (first, middle, last), people of 4 shared and 4 unshared
  organizations, the last page of org:github's people, 5 languages, and all
  repositories (first and last page: the deep page of the largest kind);
- one query per graph category on a growing (shared) hub.

Each scale draws its own replica for each unshared entity, from the seed.
"""

from __future__ import annotations

import json
import random
import sys
from collections import Counter
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "corpus"))
sys.path.insert(0, str(HERE))

import oracle  # noqa: E402
from generate2 import shared_entities  # noqa: E402
from idmap import DEFAULT_SEED, SCALES, own_id  # noqa: E402
from templates import load_s0  # noqa: E402

S0_ROOT = HERE.parents[4] / "attic" / "paraverse" / "vendor" / "universe2026-md" / "kb"
V2_SCALES = {"S1-r2": "S1", "S2-r2": "S2"}
PAGE = 50
WARM = 20
KINDS = (
    "repository", "social_account", "person", "profile", "session",
    "organization", "github_account", "website", "package", "room",
)

V2_CONVENTIONS = {
    "inherits": "Every v1 convention applies unchanged.",
    "corpora": (
        "Round-2 corpora from corpus/generate2.py (seed namespace r2): shared entities keep "
        "their S0 IDs; every other entity uses the replica suffix rule of idmap.py. Every "
        "edge row carries an origin attribute, which is part of the canonical edge attrs."
    ),
    "table_repos_all_by_stars": (
        "Every repository node, ordered by payload.stars descending with nulls last, then "
        "id ascending. Rows {id, name: display_name, value: stars}."
    ),
    "last_page": (
        "offset 'last' means max(0, floor((total - 1) / limit) * limit) for that query's "
        "total; the result then also carries the computed offset as `offset`."
    ),
    "repetitions": f"One cold run, then {WARM} warm runs per instance (C6: many parameter sets, fewer repetitions).",
    "hub": "Entries with hub: true target a shared entity whose degree grows with the scale.",
}


def _replica(name: str, scale: str, key: str) -> int:
    return random.Random(f"{DEFAULT_SEED}:r2:q:{name}:{scale}:{key}").randrange(SCALES[V2_SCALES[scale]])


def _map(s0_id: str, name: str, scale: str, key: str, shared: frozenset[str], replica: int | None = None) -> str:
    if s0_id in shared:
        return s0_id
    return own_id(s0_id, _replica(name, scale, key) if replica is None else replica)


def _semantics(v1: list[dict[str, Any]], category: str, table: str | None = None) -> str:
    if table == "repos_all_by_stars":
        return "See v2.conventions.table_repos_all_by_stars and last_page."
    for q in v1:
        if q["category"] == category and (table is None or q["params"]["S0"].get("table") == table):
            if not q["semantics"].startswith("As "):
                return q["semantics"]
    raise KeyError(category)


def build_v2(doc: dict[str, Any]) -> dict[str, Any]:
    v1 = doc["queries"]
    s0 = load_s0(S0_ROOT, 1, DEFAULT_SEED)
    s0.templates_by_owner = {t.owner: t for t in s0.templates.values()}  # type: ignore[attr-defined]
    shared = shared_entities(s0)
    ix = oracle.KbIndex(S0_ROOT, set())
    degree = {n: len(ix.adj.get(n, ())) for n in ix.kind}
    rng = random.Random(f"{DEFAULT_SEED}:r2:queries")
    entries: list[dict[str, Any]] = []

    def add(name: str, category: str, s0_params: dict[str, Any], ids: tuple[str, ...] = (), hub: bool = False, table: str | None = None, cross: bool = False) -> None:
        params = {}
        for scale in V2_SCALES:
            p = dict(s0_params)
            for key in ids:
                replica = None
                if key == "b":
                    ra = _replica(name, scale, "a")
                    replica = _replica(name, scale, "b") if cross else ra
                    if cross and replica == ra:
                        replica = (ra + 1) % SCALES[V2_SCALES[scale]]
                p[key] = _map(p[key], name, scale, key, shared, replica)
            params[scale] = p
        entries.append({"name": name, "category": category, "hub": hub, "semantics": _semantics(v1, category, table), "params": params})

    # Entities for record and neighborhood, stratified by kind size and degree.
    def strata(salt: str) -> list[str]:
        picks = []
        r = random.Random(f"{DEFAULT_SEED}:r2:{salt}")
        for kind in KINDS:
            ids = sorted((degree[i], i) for i, k in ix.kind.items() if k == kind and i not in shared)
            low, high = ids[: len(ids) // 2], ids[int(len(ids) * 0.9) :]
            picks += [r.choice(low)[1], r.choice(high)[1]]
        return picks

    for n, entity in enumerate(strata("record")):
        add(f"v2.record.{n:02d}", "record", {"id": entity}, ("id",))
    for n, entity in enumerate(strata("neighborhood")):
        add(f"v2.neighborhood.{n:02d}", "neighborhood", {"id": entity, "limit": 200}, ("id",))

    # Paths by S0 hub-free distance.
    pool = sorted(i for i, k in ix.kind.items() if k in ("person", "organization", "session", "repository") and i not in shared)
    buckets: dict[Any, list[tuple[str, str]]] = {2: [], 3: [], 4: [], None: []}
    while any(len(v) < 5 for v in buckets.values()):
        a, b = rng.sample(pool, 2)
        hops = oracle.q_path(ix, {"a": a, "b": b, "max_hops": 4})["hops"]
        if hops in buckets and len(buckets[hops]) < 5:
            buckets[hops].append((a, b))
    n = 0
    for hops in (2, 3, 4, None):
        for a, b in buckets[hops]:
            add(f"v2.path.{n:02d}", "path", {"a": a, "b": b, "max_hops": 4}, ("a", "b"), cross=n % 2 == 1)
            n += 1

    # Search terms by S0 frequency, fold-invariant on S0.
    words = sorted({w.lower() for t in ix.display.values() for w in t.split() if w.isascii() and w.isalpha() and 4 <= len(w) <= 12})
    rng.shuffle(words)
    tiers = {"rare": (1, 5, 7), "medium": (10, 50, 7), "common": (100, 10**9, 6)}
    chosen: dict[str, list[str]] = {t: [] for t in tiers}
    for w in words:
        try:
            total = oracle.q_search(ix, {"term": w, "limit": 20})["total"]
        except ValueError:
            continue
        for tier, (lo, hi, want) in tiers.items():
            if lo <= total <= hi and len(chosen[tier]) < want:
                chosen[tier].append(w)
        if all(len(chosen[t]) >= tiers[t][2] for t in tiers):
            break
    n = 0
    for tier in tiers:
        for w in chosen[tier]:
            add(f"v2.search.{n:02d}", "search", {"term": w, "limit": 20})
            n += 1

    # Facets: the 20 most frequent (relation, source kind) pairs.
    combos: Counter[tuple[str, str]] = Counter()
    for s, edges in ix.out.items():
        if ix.kind[s] in oracle.HUB_KINDS:
            continue
        for rel, _, _ in edges:
            combos[(rel, ix.kind[s])] += 1
    for n, ((rel, kind), _) in enumerate(sorted(combos.items(), key=lambda kv: (-kv[1], kv[0]))[:20]):
        add(f"v2.facet.{n:02d}", "facet", {"relation": rel, "source_kind": kind, "limit": PAGE})

    # Tables.
    n = 0

    def table(params: dict[str, Any], ids: tuple[str, ...] = (), name: str | None = None) -> None:
        nonlocal n
        add(name or f"v2.table.{n:02d}", "table", params, ids, table=params["table"])
        if name is None:
            n += 1

    for offset in (0, 2 * PAGE, 10 * PAGE, "last"):
        table({"table": "sessions_by_start", "offset": offset, "limit": PAGE})
    people = Counter(t for s, edges in ix.out.items() for rel, t, _ in edges if rel == "affiliated_with" and ix.kind[s] == "person")
    shared_orgs = ["org:github", "org:microsoft", "org:google", "org:octopus-deploy"]
    unshared = sorted(o for o in people if o not in shared)
    for want in (1, 2, 3, 5):
        options = [o for o in unshared if people[o] == want] or unshared
        shared_orgs.append(rng.choice(options))
    for org in shared_orgs:
        table({"table": "people_by_org", "org": org, "offset": 0, "limit": PAGE}, ("org",))
    table({"table": "people_by_org", "org": "org:github", "offset": "last", "limit": PAGE}, ("org",))
    for lang in ("Python", "TypeScript", "Go", "Rust", "Ruby"):
        table({"table": "repos_by_stars", "language": lang, "offset": 0, "limit": PAGE})
    table({"table": "repos_all_by_stars", "offset": 0, "limit": PAGE})
    table({"table": "repos_all_by_stars", "offset": "last", "limit": PAGE}, name="v2.table.deep_largest_kind")

    # One query per graph category on a growing hub.
    add("v2.record.hub", "record", {"id": "org:openai"}, ("id",), hub=True)
    add("v2.neighborhood.hub", "neighborhood", {"id": "software:vs-code", "limit": 200}, ("id",), hub=True)
    add("v2.path.hub", "path", {"a": "person:dylan-ratcliffe", "b": "person:pamela-fox", "max_hops": 4}, ("a", "b"), hub=True, cross=True)
    add("v2.facet.hub", "facet", {"relation": "mentions", "source_kind": "session", "limit": PAGE}, hub=True)

    doc["v2"] = {
        "description": "Round-2 query set: many seeded parameter sets per category, a deep page, and growing-hub queries.",
        "scales": {s: {"base_scale": b, "replicas": SCALES[b], "seed": DEFAULT_SEED, "seed_namespace": "r2"} for s, b in V2_SCALES.items()},
        "warm_iterations": WARM,
        "conventions": V2_CONVENTIONS,
        "counts": dict(sorted(Counter(e["category"] for e in entries).items())),
    }
    doc["queries_v2"] = entries
    return doc


def main() -> None:
    path = HERE / "queries.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    v1_before = json.dumps(doc["queries"], sort_keys=True)
    doc = build_v2(doc)
    assert json.dumps(doc["queries"], sort_keys=True) == v1_before, "v1 queries must not change"
    path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path}: {len(doc['queries_v2'])} v2 instances {doc['v2']['counts']}")


if __name__ == "__main__":
    main()
