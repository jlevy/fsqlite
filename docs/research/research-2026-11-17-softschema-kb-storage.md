# Research: Storage for Accumulating Softschema Knowledge Bases (fsqlite vs FalkorDB)

**Date:** 2026-11-17 (last updated 2026-11-17)

**Author:** Joshua Levy, with Claude Code research agents

**Status:** In Progress

## Overview

[Paraverse](https://github.com/jlevy/paraverse) builds a conference knowledge base (KB)
from public sources.
Each entity is a structured softschema record, stored as YAML or as Markdown
frontmatter, and the records are versioned in git.
Paraverse then imports the whole KB into FalkorDB, a graph database, and serves a
generic browser driven by the KB’s compiled schemas.

The goal is to productionize that pattern for large tabular and graph data that stays
portable and usable.
Crawlers and agents accumulate thousands, then hundreds of thousands, then millions of
YAML documents over time.
A repeatable import consolidates them into a database that supports a clean, fast UI.
The schema keeps changing: new entity kinds, adjusted relationships, changed fields.
A clean export back to the same file formats may also be needed.

This brief compares the approach paraverse takes, with FalkorDB and FalkorDBLite,
against fsqlite for that lifecycle.
Both are measured with spiked implementations on the same workloads.
The document is structured so that other databases can be added to the same comparison
later.

## Questions to Answer

1. How does paraverse load softschema YAML into FalkorDB generically, and what does that
   design assume?
2. What are the realistic workflows for accumulating, consolidating, and serving
   thousands to millions of softschema documents?
3. How do FalkorDB and fsqlite compare on import, incremental updates, UI query latency,
   memory, and artifact size, at 5k, 50k, 250k, and 1M records?
4. How does each handle schema evolution: new kinds, changed relationships, changed
   fields?
5. Can each export cleanly back to the same YAML and Markdown formats, and is the round
   trip lossless?
6. What are the pros and cons of each format and storage layer for this use case, and
   what should a production design use?

## Scope

Included:
- paraverse’s KB layout, softschema usage, FalkorDB loader, schema-driven browser, and
  dataset composition;
- fsqlite’s `SnapshotStore` and `DirectStore`;
- spiked implementations and benchmarks of both, on the workload in
  [the spike’s workload specification](spikes/softschema-kb/WORKLOAD.md).

Excluded for now, but planned as later comparisons on the same harness: plain SQLite,
DuckDB and Parquet, embedded graph databases, Dolt, and server databases.

## Findings

*In progress.*

## Recommendations

*In progress.*

## Methodology

*In progress.* The spike lives in [spikes/softschema-kb/](spikes/softschema-kb/).

## References

- [jlevy/paraverse](https://github.com/jlevy/paraverse)
- [jlevy/universe2026-md](https://github.com/jlevy/universe2026-md), the S0 dataset

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
