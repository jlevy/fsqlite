# Harness: Shared W3 Queries and Result Comparison

Every backend runs the same W3 query instances and writes the same canonical results,
so `compare.py` can check any two runs against each other.

| File | Contents |
| --- | --- |
| `queries.json` | The W3 catalog: 24 query instances, the conventions that define their results, and concrete parameters for S0 to S3 |
| `build_queries.py` | Writes `queries.json`; the S0 parameters and the semantics text live here |
| `oracle.py` | A pure-Python reference implementation that computes every canonical result from the KB files |
| `expected/<scale>/w3.json` | The oracle's results per scale, the answer key for every backend |
| `compare.py` | Compares two `w3.json` files and exits 1 on any difference |
| `machine.py` | Shared measurement helpers: machine description, percentiles, cold and warm timing, RSS sampling |

## Using the Catalog

Each entry in `queries.json` has a `name`, a `category` (table, record, search, path,
facet, neighborhood), a `semantics` string, and `params` keyed by scale.
The `conventions` block defines the shared terms: payload, `display_name`,
`start_epoch`, ordering, case folding, and hubs.
When a sentence there is ambiguous, `oracle.py` is the definition.

The S0 parameters come from the real KB.
For a synthetic scale, each entity ID is the copy in that scale's `selection_replica`,
the middle replica, through `corpus/idmap.py: scale_id`.
The generator always writes that copy, so the parameters always exist; search terms
and filter values are the same at every scale.

A backend writes `results/<backend>/<scale>/w3.json` with one entry per query instance:
`name`, `category`, `params`, `result` and `timings` (`cold_ms`, 50 `warm_ms`, `p50_ms`,
`p95_ms`). Percentiles interpolate linearly between ranks, as NumPy does by default.

## Commands

Run these with paraverse's synced environment (see `../falkordb/README.md`):

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
  paraverse's own RediSearch query is measured separately by the FalkorDB backend and is
  not compared.
- The oracle checks that ASCII-only and Unicode lower-casing give the same matches for
  every term.
  S0 contains three U+0130 characters, so new terms should be checked the same way.
- People sort by `display_name` in code point order, not case-insensitively as
  paraverse's browser does, because SQLite and FalkorDB lower-case non-ASCII letters
  differently.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
