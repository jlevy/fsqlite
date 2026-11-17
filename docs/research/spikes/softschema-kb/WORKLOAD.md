# Softschema KB Storage Spike: Workload Specification

This spike measures how well candidate databases serve a softschema knowledge base (KB)
through its whole lifecycle.
Every backend implements the same workflows on the same corpora, and the harness checks
that their query results match, so the numbers compare like with like.
The first backends are FalkorDBLite, as used by
[paraverse](https://github.com/jlevy/paraverse), fsqlite, and plain SQLite as a control.
Others can be added later by implementing the same workflows.

The spike is temporary research code: it supports the research brief
`docs/research/research-2026-11-17-softschema-kb-storage.md` and is not part of the
published package. Later backends should be built from this document, not from the first
implementations.

## The KB Shape

A KB directory follows the universe2026-md layout:

```
kb/
  <kind dirs>/   softschema records: Markdown with YAML frontmatter, or YAML
  _schemas/      the compiled softschema schema for each kind (*.schema.yaml)
  _graph/        nodes.jsonl, edges.jsonl, stats.json, coverage.json
  _search/       search documents
  README.md
```

Each record declares its contract, schema, and envelope in a `softschema:` block, and
holds its payload under the envelope key (for example `person:`). References such as
`org:avanade` are typed IDs.
The `_graph` export lists every node and edge.

Records and nodes are not one to one, and every backend’s keys and export depend on
these shapes (measured at S0):
- 4,975 records carry nodes and 2 carry none (`faq.yaml`, `media.yaml`).
- 432 nodes are nested inside another record: 14 days inside 4 event records and 418
  terms inside 34 facet records.
- 136 nodes have no edge.
- 323 `(source, relation, target)` triples occur more than once, so edges are a
  multiset. Edge rows have no ID and do not name the record they were derived from.

## Corpora

| Scale | Source | Nodes | Edges | Record files | Record bytes |
| --- | --- | --- | --- | --- | --- |
| S0 | The real GitHub Universe KB, `universe2026-md` at `a823679` | 5,407 | 25,313 | 4,977 | 15.7 MB |
| S1 | Synthetic, 9 replicas of S0 | 48,663 | 227,817 | 44,775 | 139 MB |
| S2 | Synthetic, 46 replicas | 248,722 | 1,164,398 | 228,850 | 712 MB |
| S3 | Synthetic, 185 replicas | 1,000,295 | 4,682,905 | 920,375 | 2.87 GB |

S0 has 5,001 files in total, with 24.8 MB of content and 39 MB of allocated blocks.
Each synthetic corpus has a `manifest.json` with its seed and all four units, and must
include a consistent `_graph` export and `stats.json`. Generation is deterministic from
the seed, and a sample must validate against the S0 schemas.

The first-round corpora replicate S0 with typed IDs renamed and 20% of the links among
people, organizations, and sessions rewired across replicas.
That has two known limits, and the brief must state them beside any result they affect:
- **Hubs do not grow.** Each copy keeps its S0 degree, so the largest degree is 533 at
  every scale. Record, neighborhood, path, and facet queries then do the same work at
  every scale.
- **Text and values repeat.** Records match their templates except for IDs and links, so
  the vocabulary is constant and every sort key has one tie per replica.

The second-round corpora fix both: a defined set of entities (software, the largest
organizations, one taxonomy) is shared across replicas so their degrees grow, and sort
values and a share of the text are perturbed per replica from the seed.
Each result reports the maximum and 99th percentile degree per scale.

## Arms and Stored Content

Each backend reports named arms, and every number says which arm produced it:
- **FalkorDB, paraverse as built:** paraverse’s own loader and queries, with full
  rebuild only.
- **FalkorDB, incremental prototype:** a MERGE-based update path where it differs from
  paraverse.
- **fsqlite DirectStore** and **fsqlite SnapshotStore.**
- **Plain SQLite control:** the same schema and queries through `node:sqlite` without a
  store, which separates what SQLite contributes from what the fsqlite protocol costs.

Loader changes are allowed when the paraverse code cannot run a workflow (it accepts
only its 18 kinds and holds the whole corpus in memory), and each run states them.

Every backend stores the same content: the payload, the document head, the Markdown
body, and node-free artifacts, so export can rebuild the KB. A backend that stores less
reports it, and its sizes and W5 results are marked as not comparable.

## Measurement Rules

- **Phases.** W1 and W2 report these phases separately: discover, parse, validate,
  transform, ingest, index, verify, publish, and durable on disk.
  Backends are compared on ingest through durable.
  Parsing is reported once, naming the parser and job count, and each run states whether
  softschema validation is included.
- **Servable and durable.** Servable is when a new reader sees the change; durable is
  when it survives a crash.
  An fsqlite publish is both when it returns.
  A FalkorDB load is durable only after a snapshot, so the FalkorDB arm reports a run
  with default save rules and a run with saves disabled during the load and an explicit
  `SAVE` at the end.
- **Memory.** For a server backend, record the client’s peak, the server’s peak
  including forked children (FalkorDBLite daemonizes `redis-server`), and the engine’s
  own counters. For a file backend, record the process peak, and note that file pages
  live in the OS page cache.
- **Configuration.** Record FalkorDB `THREAD_COUNT`, timeouts, and save rules; SQLite
  page size, cache size, and journal mode; fsqlite lock timeouts and `gc` retention; and
  exact versions of the FalkorDB module, Redis, falkordblite, SQLite, Node, and
  softschema.
- **Capacity.** A run checks free memory and disk before it starts and guards against
  exhausting them. An out-of-memory or out-of-disk failure is a result to report, with
  the measured growth that predicts it.
- **Timeouts.** Every query has a timeout, and a timeout is a result.

## Workflows

- **W1, full rebuild import.** Load a complete KB directory into an empty database and
  make it servable, then durable.
  Record per-phase wall time, peak memory per the rules above, and on-disk size.

- **W2, incremental accumulation.** Starting from a loaded database, apply batches of
  new and changed records, as a crawler or agent would produce them, and measure the
  time until the UI sees the change, without a full rebuild where the backend allows
  one.
  - Bulk batches: 1%, 5%, and 20% of the corpus, 80% new and 20% updated.
  - Trickle batches: 1, 10, and 100 records, and a sustained rate in records per second
    with its visibility delay.
  - Concurrency: 4 writer processes while a reader runs the W3 queries, recording reader
    latency and errors. In one case the writers touch disjoint records and the final
    state is deterministic.
    In the other two writers update the same record with different values, and the run
    reports the outcome and whether both values remain recoverable.
  - Second round: a share of updates adds and drops references, and batches include
    about 2% deletes and 1% merges, where a merge retargets every edge of the absorbed
    node. For each changed record, a batch carries the complete edge set derived from it,
    tagged with its origin record, and lists deleted records explicitly.
    One batch holds an invalid record, and the run reports whether the pipeline rejects
    the batch, quarantines the record, or loads it.

- **W3, UI queries.** The definitions are normative in the `conventions` block of
  `harness/queries.json`, and `harness/oracle.py` is their executable form.
  In summary: search is a lower-cased substring match; strings order by code point with
  an ID tie-break; hub kinds (event, day, facet) are excluded from paths and
  neighborhood expansion; paths compare on hop count; facets count distinct sources;
  record views list parallel edges.
  1. Table: one kind, sorted by a field, filtered, paginated 50 rows at a time (sessions
     by start time; people filtered by organization; repositories by stars), including a
     deep page.
  2. Record: one entity’s full payload plus its one-hop neighbors grouped by relation.
  3. Search: case-insensitive substring search over names, titles, and bios, top 20.
     Each backend also reports its native or sidecar text index as a separate figure,
     with the index’s build time and bytes counted in W1 and after every W2 publish.
     FalkorDB’s stemmed full-text query is reported without comparison.
  4. Path: shortest hub-free path between two entities, at most 4 hops.
     The compared figure runs the same application-side bidirectional breadth-first
     search on every backend, and each engine’s in-engine form is reported separately.
  5. Facets: counts grouped by a related entity (sessions per topic; people per
     organization).
  6. Neighborhood: two-hop neighbors of an entity, capped at 200 nodes in the stated
     order.

  A cold run is the first query after process start.
  Each query then runs warm 50 times; record cold time and warm p50 and p95. Store each
  query’s plan (`GRAPH.EXPLAIN` or `EXPLAIN QUERY PLAN`) in the results.
  In the second round each query draws at least 20 parameter sets from the seed,
  stratified by degree and kind size, and targets a growing hub for each graph category.

- **W4, schema evolution.** Record what each backend requires (rebuild, migration, or
  nothing), how long it takes, and the lines of code and configuration changed, and say
  whether existing records are rewritten or left under their old contract:
  1. Add a new kind with its records and relationships.
  2. Add an optional field to an existing kind.
  3. Rename a relationship type.
  4. Change a field’s type (string to structured object).
  5. Make a field sortable or filterable, which changes the index set.
  6. Let two contract versions of one kind coexist, with two schema files.

- **W5, export round trip.** Export the database back to the KB layout: records in their
  original paths, node-free artifacts, `_schemas`, `_graph`, `_search`, and `README.md`.
  Report three fidelity levels separately: parsed payloads equal, documents equal after
  canonical serialization, and bytes equal.
  Exported records must pass softschema validation at their declared status.
  A W5 export must reload into the same W3 results.
  Record export time.

- **W6, operations.** Report artifact count and size, whether standard tools can open
  the data directly, serving start-up time from a loaded database, and resident memory
  at rest. Crash tests:
  - FalkorDB: kill the client mid-load; kill the server mid-load; kill the server within
    a minute after a completed load.
    Record orphan staging graphs and what the restarted server serves.
  - fsqlite: kill during capture, during reconcile, and during publication.
    Record the recovery steps and time, including any manual lock recovery.

- **W7, reload and composition (optional).** Report the time from a published change on
  disk to a visible change in the API, split into detection and apply.
  Serve two KBs with overlapping IDs as one view.

## Correctness

Each W3 query has a canonical result: JSON with sorted keys, with lists in the stated
order. For every scale, the harness compares each backend’s result with the oracle’s
`harness/expected/<scale>/w3.json` and fails on any difference.

## Results

Each run writes `results/<backend>/<scale>/<workflow>.json` with:
- the machine (CPU count, memory, filesystem, OS) and the configuration and versions
  above;
- the corpus seed and counts in all four units;
- per-phase timings, the number of repetitions and their spread, and every failure and
  timeout;
- the query plans.

The research brief reports medians with the machine caveat.
Numbers come from one cloud VM with 4 CPUs and 15 GB of RAM, so they show relative
sizing, not portable rates.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
