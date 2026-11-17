# Softschema KB Storage Spike: Workload Specification

This spike measures how well candidate databases serve a softschema knowledge base (KB)
through its whole lifecycle.
Every backend implements the same workflows on the same corpora, and the harness checks
that their query results match, so the numbers compare like with like.
The first two backends are FalkorDBLite, as used by
[paraverse](https://github.com/jlevy/paraverse), and fsqlite.
Others can be added later by implementing the same workflows.

The spike is temporary research code: it supports the research brief
`docs/research/research-2026-11-17-softschema-kb-storage.md` and is not part of the
published package.

## The KB Shape

A KB directory follows the universe2026-md layout:

```
kb/
  <kind dirs>/   softschema records: Markdown with YAML frontmatter, or YAML
  _schemas/      the compiled softschema schema for each kind (*.schema.yaml)
  _graph/        nodes.jsonl, edges.jsonl, stats.json, coverage.json
  _search/       search documents
```

Each record declares its contract, schema, and envelope in a `softschema:` block, and
holds its payload under the envelope key (for example `person:`). References such as
`org:avanade` are typed IDs; the `_graph` export lists every node and edge.

## Corpora

| Scale | Source | Target size |
| --- | --- | --- |
| S0 | The real GitHub Universe KB (`vendor/universe2026-md/kb`) | 5,407 nodes, 25,313 edges, 5,001 record files, 39 MB |
| S1 | Synthetic, generated from S0’s distributions | about 50,000 nodes |
| S2 | Synthetic | about 250,000 nodes |
| S3 | Synthetic, if disk and memory allow | about 1,000,000 nodes |

Synthetic corpora keep S0’s kind mix, per-kind field distributions, degree distribution,
and record sizes.
They must validate against the S0 schemas and must include a consistent
`_graph` export and `stats.json`, so unmodified loaders can read them.
Generation is deterministic from a seed.

## Workflows

- **W1, full rebuild import.** Load a complete KB directory into an empty database and
  make it servable. Record wall time, peak resident memory, and the database’s on-disk
  and in-memory size.
- **W2, incremental accumulation.** Starting from a loaded S-scale database, apply a
  batch of new and changed records, as a crawler or agent would produce them: 1%, 5%,
  and 20% of the corpus, with 80% new and 20% updated.
  Measure the time until the UI sees the change, without a full rebuild where the
  backend allows one. Also run 4 concurrent writer processes while a reader runs the W3
  queries; record reader latency and any errors.
- **W3, UI queries.** Each query runs warm 50 times after one cold run; record cold time
  and warm p50 and p95.
  1. Table: one kind, sorted by a field, filtered, paginated 50 rows at a time (sessions
     by start time; people filtered by organization; repositories by stars).
  2. Record: one entity’s full payload plus its one-hop neighbors grouped by relation.
  3. Search: case-insensitive text search over names, titles, and bios, top 20.
  4. Path: shortest path between two entities, at most 4 hops.
  5. Facets: counts grouped by a related entity (sessions per topic; people per
     organization).
  6. Neighborhood: two-hop neighbors of an entity, capped at 200 nodes.
- **W4, schema evolution.** Record what each backend requires (rebuild, migration, or
  nothing) and how long it takes:
  1. Add a new kind with its records and relationships.
  2. Add an optional field to an existing kind.
  3. Rename a relationship type.
  4. Change a field’s type (string to structured object).
- **W5, export round trip.** Export the database back to the KB layout: records as YAML
  or Markdown frontmatter in their original paths, plus the `_graph` export.
  Compare against the source: parsed payloads must be equal, and report byte-level
  differences separately.
  Record export time.
- **W6, operations.** Report artifact count and size, whether standard tools can open
  the data directly, serving start-up time from a loaded database, crash safety during
  import (kill the loader mid-import, then restart), and resident memory at rest.

## Correctness

Each W3 query has a canonical result: JSON, sorted where order is not part of the query.
For every scale, the harness compares each backend’s result with the others’ and fails
on any difference. A W5 export must reload into the same W3 results.

## Results

Each run writes `results/<backend>/<scale>/<workflow>.json` with:
- the machine (CPU count, memory, filesystem, OS) and software versions;
- the corpus seed and counts;
- the raw timings.

The research brief reports medians with the machine caveat.
Numbers come from one cloud VM, so they show relative sizing, not portable rates.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
