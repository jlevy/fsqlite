# Harness: Shared W3 Queries and Result Comparison

Every backend runs the same W3 query instances and writes the same canonical results, so
`compare.py` can check any two runs against each other.

| File | Contents |
| --- | --- |
| `queries.json` | The W3 catalog: 24 query instances, the conventions that define their results, and concrete parameters for S0 to S3 |
| `build_queries.py` | Writes the v1 part of `queries.json`; the S0 parameters and the semantics text live here |
| `build_queries_v2.py` | Adds the round-2 query set (`v2`, `queries_v2`) |
| `oracle.py` | A pure-Python reference implementation that computes every canonical result from the KB files |
| `expected/<scale>/w3.json` | The oracle’s results per scale (S0 to S2, S1-r2, S2-r2, and after batch p05), the answer key for every backend |
| `compare.py` | Compares two `w3.json` files and exits 1 on any difference |
| `machine.py` | Shared measurement helpers: machine description, percentiles, cold and warm timing, RSS sampling |

## Using the Catalog

Each entry in `queries.json` has a `name`, a `category` (table, record, search, path,
facet, neighborhood), a `semantics` string, and `params` keyed by scale.
The `conventions` block defines the shared terms: payload, `display_name`,
`start_epoch`, ordering, case folding, and hubs.
When a sentence there is ambiguous, `oracle.py` is the definition.

The S0 parameters come from the real KB. For a synthetic scale, each entity ID is the
copy in that scale’s `selection_replica`, the middle replica, through
`corpus/idmap.py: scale_id`. The generator always writes that copy, so the parameters
always exist; search terms and filter values are the same at every scale.

A backend writes `results/<backend>/<scale>/w3.json` with one entry per query instance:
`name`, `category`, `params`, `result` and `timings` (`cold_ms`, 50 `warm_ms`, `p50_ms`,
`p95_ms`). Percentiles interpolate linearly between ranks, as NumPy does by default.

## Round 2: the v2 Query Set

`build_queries_v2.py` adds `v2` and `queries_v2` to `queries.json` and leaves the 24
round-1 instances in `queries` unchanged.
`queries_v2` holds 124 instances with parameters for `S1-r2` and `S2-r2`: 20 or 21 per
category (table, record, search, path, facet, neighborhood), seeded and stratified by
kind size and S0 degree, path distance or term frequency; a deep page
(`v2.table.deep_largest_kind`, the last page of all repositories); and one query per
graph category on a growing shared hub (`hub: true`). `v2.conventions` adds the
`repos_all_by_stars` table and `offset: "last"`; every v1 convention still applies.
Each v2 instance runs once cold and 20 times warm.

The oracle reads `queries_v2` for any scale containing `-r2`, so expected results exist
for the base corpora and for the state after batch p05:

```bash
python oracle.py --kb $KB_CORPORA/S1-r2/kb --scale S1-r2 --out expected/S1-r2/w3.json
python ../corpus/delta2.py --apply --base $KB_CORPORA/S1-r2/kb \
  --batch $KB_CORPORA/S1-r2/deltas/p05 --out $POST
python oracle.py --kb $POST --scale S1-r2-p05 --out expected/S1-r2-p05/w3.json
```

`compare.py` needs no change: it matches instances by name.

## Commands

Run these with paraverse’s synced environment (see `../falkordb/README.md`):

```bash
python build_queries.py && (cd ../../../../.. && pnpm exec prettier --write docs/research/spikes/softschema-kb/harness/queries.json)
python oracle.py --kb $KB_CORPORA/S1/kb --scale S1 --out expected/S1/w3.json
python compare.py expected/S1/w3.json ../results/falkordb/S1/w3.json --kb $KB_CORPORA/S1/kb
python compare.py ../results/falkordb/S1/w3.json ../results/fsqlite/S1/w3.json
```

`compare.py` compares numbers by value and never treats a boolean as a number.
Path results compare on `hops` only, because several shortest paths can exist; with
`--kb` it also checks that every returned path is a real, hub-free path of that length.

## Caveats

- Search is a case-insensitive substring match with a deterministic rank, not a
  relevance score, so SQL and Cypher can match it exactly.
  paraverse’s own RediSearch query is measured separately by the FalkorDB backend and is
  not compared.
- The oracle checks that ASCII-only and Unicode lower-casing give the same matches for
  every term. S0 contains three U+0130 characters, so new terms should be checked the
  same way.
- People sort by `display_name` in code point order, not case-insensitively as
  paraverse’s browser does, because SQLite and FalkorDB lower-case non-ASCII letters
  differently.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
