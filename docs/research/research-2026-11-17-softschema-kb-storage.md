# Research: Storage for Accumulating Softschema Knowledge Bases (FalkorDB, SQLite, and fsqlite)

**Date:** 2026-11-17 (last updated 2026-11-17)

**Author:** Joshua Levy, with Claude Code research agents

**Status:** In Progress.
Timings marked “(provisional)” await a quiet re-measurement pass.

## Overview

[Paraverse](https://github.com/jlevy/paraverse) builds a conference knowledge base (KB)
from public sources.
Each entity is a softschema record, stored as YAML or as Markdown with YAML frontmatter
and versioned in git.
Paraverse imports the whole KB into FalkorDB, an in-memory graph database, and serves a
browser driven by the KB’s compiled schemas.

The goal is to productionize that pattern for KBs that crawlers and agents grow from
thousands to millions of documents, while entity kinds, relationships, and fields keep
changing and a clean export back to the same files stays possible.
Two decisions depend on this research: which store should hold and serve the
consolidated data, and what fsqlite should become for that job.
fsqlite is new and has no compatibility constraints, so its format and API may change.

The research read paraverse, softschema, and fsqlite at the source level.
It then ran FalkorDB as paraverse uses it, fsqlite, and plain SQLite through the same
workflows, on the real KB and on synthetic corpora up to 249,000 nodes, and prototyped
an fsqlite redesign in three spikes and one combined prototype.
Query answers were checked against one oracle.
The state that a batch leaves was also compared with a reference applier’s output, for
the runs that recorded their rows.

The conclusions:

1. **Treat every database as a rebuildable projection, and cache the parse.** Parsing
   and validation dominate consolidation, not the database.
   At 249,000 nodes the YAML parse takes 43 to 79 s and the SQLite build 17 to 18 s
   (both provisional), and softschema validation would take about 34 minutes on one core
   (inferred from 8.9 ms per record).
   Cache the parse and the validation by content hash.
2. **Keep one file per entity in git as the system of record to about 100,000 documents,
   and append-only record batches above that.** Both halves are inferred: no workflow
   measured git, and batches were not run as the record.
   Above the limit the batches hold full softschema records with their upsert, delete,
   and merge operations, and per-entity files remain for the records that people review
   and as an export.
3. **Serve from a SQLite file with a generic, schema-driven mapping.** On equal corpora,
   with every result checked against one oracle, SQLite answered 123 of 124 round-2
   queries faster than FalkorDB, at a median ratio of 8 (provisional), hub queries
   included. It imported 4 to 5 times faster (provisional), opened in milliseconds
   against 12 to 20 s (provisional), and exported 228,873 of 228,876 files byte for
   byte, where the paraverse graph keeps payloads only.
   Its serving process held 0.17 GB against a 1.3 GB server, a figure that leaves out
   the file pages the OS caches for SQLite, which were not measured.
   Four asymmetries listed under [threats to validity](#methodology) favor SQLite and
   change the size of these gaps.
4. **Plain SQLite is enough for one consolidating process on one host.** fsqlite reads
   at plain SQLite speed and adds 7 to 11% to an import at the largest scales
   (provisional). It earns that cost when writers are independent processes, when the
   path is shared, or when each published state must be an immutable file.
5. **fsqlite as built (`f1.0`) can publish rebuilds at these sizes and cannot accumulate
   into them.** Every publish copies the whole file.
   At 1.8 to 1.9 GB one record takes 2.6 to 4.0 s to publish and four concurrent writers
   take 46 to 92 s (both provisional).
   Their merged result is wrong for edge changes, deletes, and merges until two repair
   publishes run, and it is state-verified against the reference applier after them.
6. **The v2 prototypes fix most of that and keep one immutable SQLite file per
   generation.** Capture stops depending on file size (0.47 ms, provisional), four
   writers publish once with a state-verified result, search and statistics live in the
   file, an index change stays in the same store, gc stops refusing, and a crashed
   publisher needs no operator.
   The per-publish copy remains on filesystems without reflinks.
   A combined prototype of the three spikes passes the package tests and the S1-r2
   correctness runs, and it was not timed.
7. **Take FalkorDB out of the serving path.** The spike found no graph-query advantage
   at this graph shape, and FalkorDB’s small-write advantage holds only while durability
   is deferred.

[Recommendations](#recommendations) gives each component’s role and a phased plan.

## Questions to Answer

1. How does paraverse load softschema YAML into FalkorDB generically, and what does that
   design assume? It copies a graph export that the dataset build derives, stores each
   payload as a JSON string, and renders from compiled schemas.
   It assumes regenerated records, a cheap full rebuild, and a corpus that fits in
   memory several times ([findings](#how-paraverse-loads-softschema-into-falkordb)).
2. What are the realistic workflows for accumulating, consolidating, and serving
   thousands to millions of softschema documents?
   The same six stages run at every scale, and parsing and validation dominate
   consolidation ([findings](#the-workflow-model-from-1k-to-1m-documents)).
3. From the ground up, how do FalkorDB, plain SQLite, and fsqlite compare on import,
   incremental updates, concurrent writers, UI query latency, memory, disk, and
   operations? SQLite leads on import, queries, memory, start-up, export, and recovery.
   FalkorDB leads on the time until a small change is first visible
   ([matrix](#comparison-matrix)).
4. How does each handle new kinds, changed relationships, and changed fields?
   With payloads stored as documents these are data changes in SQLite; only a new index
   changes the physical schema ([findings](#schema-evolution-w4)).
5. Can each export cleanly back to the same YAML and Markdown files?
   Fidelity follows what the store keeps: the fsqlite arm is byte-exact for all but 3
   files, and the paraverse graph loses bodies and byte fidelity
   ([findings](#export-fidelity-w5)).
6. Which format fits which role, and what should a production design use?
   Per-entity files as the system of record to about 100,000 documents and record
   batches above that (both inferred), JSONL as interchange, and SQLite as the serving
   store ([formats](#formats-by-role), [recommendations](#recommendations)).
7. Which fsqlite changes fit this workload, and which did prototypes confirm?
   Eleven of 13 hypotheses held, and a combined prototype passes its correctness runs at
   S1-r2, with state-verified four-writer results
   ([findings](#what-the-fsqlite-v2-prototypes-confirmed-and-refuted)).
8. How do other databases join the comparison later?
   By implementing the workload specification against the same corpora and oracle
   ([later comparisons](#later-comparisons-on-the-same-harness)).

## Scope

Included:

- paraverse’s KB layout, softschema usage, FalkorDB loader, schema-driven browser,
  dataset composition, and validation;
- softschema 0.8.1 and what it gives an importer;
- the workflow from accumulation to export, and the formats at each stage;
- five measured arms on one workload: FalkorDB as paraverse built it, a FalkorDB
  incremental prototype, fsqlite `DirectStore`, fsqlite `SnapshotStore`, and a plain
  SQLite control;
- an fsqlite v2 design, three prototypes of it, and a combined prototype checked for
  correctness at S1-r2.

Not covered:

- **The 1M scale end to end.** The S3 corpus was generated and validated, and neither
  database arm loaded it on the VM. The brief reports the measured failure and the
  projections.
- **Two workflow cases.** W4 case 6, two coexisting contract versions of one kind, and
  the optional W7, reload detection and composition, were specified and not run.
- **Plain SQLite beyond import and queries.** The control ran W1 and W3. Its small-write
  figures come from a probe.
- **Other filesystems and hosts.** Every run used ext4 on one VM. No reflink filesystem,
  network filesystem, or macOS run exists.
- **git itself.** No workflow measured git operations or repository size, so the scale
  limit of per-entity files in one repository is inferred.
- **Row-level state after every batch.** The state check compares stored edges with the
  reference applier’s output at three states: S1-r2 after p05 and p20, and S2-r2 after
  p05. No reference state was built for p01 or for S2-r2 after p20. Entity rows are
  compared by count only, and the FalkorDB runs recorded counts and no rows.
- **Other backends.** DuckDB with Parquet, embedded graph stores, Dolt, and Postgres are
  left for [the same harness](#later-comparisons-on-the-same-harness).

The [workload specification](spikes/softschema-kb/WORKLOAD.md) defines six workflows: W1
full rebuild import, W2 incremental accumulation, W3 UI queries, W4 schema evolution, W5
export round trip, and W6 operations.
It defines these corpora:

| Scale | Source | Nodes | Edges | Record files | Record bytes | Largest degree |
| --- | --- | --- | --- | --- | --- | --- |
| S0 | The real GitHub Universe KB | 5,407 | 25,313 | 4,977 | 15.7 MB | 533 |
| S1 | 9 replicas of S0 | 48,663 | 227,817 | 44,777 | 139 MB | 533 |
| S2 | 46 replicas | 248,722 | 1,164,398 | 228,852 | 712 MB | 533 |
| S1-r2 | 9 replicas with shared hubs | 46,927 | 226,281 | 44,057 | 135 MB | 4,781 |
| S2-r2 | 46 replicas with shared hubs | 238,957 | 1,155,758 | 224,802 | 692 MB | 24,428 |
| S3 | 185 replicas, generated and not loaded | 1,000,295 | 4,682,905 | 920,377 | 2.87 GB | 533 |

Record files count every record artifact, including `faq.yaml` and `media.yaml`, which
carry no node. The S1, S2, and S3 manifests leave those two out and report 44,775,
228,850, and 920,375.

A **generation** is one published, complete SQLite file, and the **head** is the newest
one. A **hub** is a node whose degree grows with the corpus.

## Findings

Three evidence levels apply throughout:

- **Measured:** recorded in a result file under
  [the spike’s results](spikes/softschema-kb/results/), which each subsection links.
  A W3 file that matched the oracle keeps its timings, plans, and path answers, and
  holds a digest of every other answer.
  It records the verdict, the hash of its expected file, and the KB that its paths were
  checked against.
- **Probe:** a single scratch run recorded in an appendix of the notes.
  Its raw output is not in the repository.
- **Inferred:** derived from measurements or from the design, and not run.

Correctness claims come in four strengths:

- **W3-checked:** the answers to the 124 round-2 queries, or the 24 of round 1, equal
  the oracle’s. Every W3 run on a freshly loaded corpus is W3-checked.
- **State-verified:** after a batch, the run’s recorded edge digest equals that of the
  reference applier’s output, and its entity count equals the reference’s node count.
  The digest covers the edge multiset with its properties.
  Entity rows are compared with the reference by count only, because their digest covers
  payloads and derived columns that the reference does not hold.
- **Row-equal:** table digests equal those of one writer that applies the same batch in
  line order.
- **Count-equal:** per-kind and per-relation counts equal those of a full rebuild.

For a state reached by applying a batch, a W3 match is necessary and not sufficient.
The batches never delete or merge an entity that a query names, and every W3 statement
joins edges to entities, so a wrong edge shows only when it touches a queried entity or
moves an aggregate. The harness’s
[state check](spikes/softschema-kb/harness/README.md#state-check) therefore compares the
rows that each after-batch run recorded with the reference applier’s output.
It has reference states for S1-r2 after p05 and p20 and for S2-r2 after p05, and its
[result file](spikes/softschema-kb/results/state-check.json) gives each after-batch
claim in this brief one of three marks:

| Mark | Meaning | After-batch W3 files (22, all after p05) |
| --- | --- | --- |
| State-verified | As defined above | 12 |
| Known different | A recorded digest or count differs from the reference’s | 6, of which 4 still match the oracle on all 124 queries |
| W3-checked only | The run recorded totals or counts and no rows, which the state check calls unverified | 4: the FalkorDB incremental state and the fsqlite arm’s own one-writer run, at both scales |

The reference applier’s edge digest equals the one-writer digest in every fsqlite run
that recorded one, at all three states.
A row-equal state is therefore state-verified wherever a reference state exists.
After p01, and after p20 at S2-r2, none exists, and row-equal is the strongest claim.
[The W2 findings](#incremental-accumulation-and-concurrent-writers-w2) mark each claim,
and [Methodology](#methodology) names the six known-different files.

Every timing here comes from runs that shared the VM with other benchmark jobs.
The headline timings carry the marker **(provisional)**, and a quiet re-measurement pass
will replace them. Supporting timings carry no marker and have the same caveat.
Sizes, counts, and correctness results are not provisional.
GB and MB are decimal, and GiB and MiB are binary.

### How Paraverse Loads Softschema Into FalkorDB

Paraverse’s import is generic because the dataset build does the kind-specific work
first.

- **The build derives the graph.** Per-kind code derives every node and edge and writes
  `_graph/nodes.jsonl` and `edges.jsonl` beside the records and the compiled schemas.
- **The importer copies that export.** It writes a staging graph in batches of 500 rows,
  stores each payload as a JSON string property because FalkorDB properties cannot hold
  maps, checks counts against `stats.json`, and swaps the staging graph in with a Redis
  `RENAME`.
- **The browser renders from schemas.** `Schema` nodes built from the compiled JSON
  Schemas drive tables and record views, so a new optional scalar field or a new
  relation appears with no code change.
- **About a dozen code tables remain.** They name kinds, promoted fields, indexes,
  search fields, and queries.
  An unknown kind fails the load with `MappingError`.
- **Composition is materialized.** Serving several datasets as one view merges them in
  Python by typed ID and loads the result as another full graph, because FalkorDB cannot
  query across graphs.
  SQLite can attach several files in one connection, and that route was not measured.

The design rests on assumptions that the target use case changes:

| Paraverse assumes | In the target use case |
| --- | --- |
| Records are a build output, regenerated as a whole | Crawlers and agents write records directly, so normalization, backlinks, and edge derivation need another home |
| A full rebuild is cheap: 3.6 s at S0 (provisional) | 184 s at S2 (provisional), and it grows with the corpus, not with the change |
| The corpus fits in memory several times | The loader held 5.07 GB at S2 and was stopped at 1M |
| One schema per kind and one contract version at a time | Accumulated records carry mixed contract versions for long periods |
| One writer publishes atomically, and every reference resolves | Many producers commit single records, and a reference to an entity not yet written is normal |
| The graph is a disposable projection | This assumption carries over, and the recommendations keep it |

softschema gives an importer a self-describing record (contract, schema pointer,
envelope key, status), a compiled JSON Schema per contract, and a content hash per
schema. It does not give entity identity, reference targets, relation names and
directions, field order, index hints, a canonical record serialization, or any link
between contract versions.
Paraverse recovers references by parsing regular expressions and keeps the rest in code.
Compiled schemas preserve unknown extension keys, so declared annotations can replace
most of those code tables on any backend.

Source: [paraverse analysis](spikes/softschema-kb/notes/paraverse-analysis.md), sections
1 and 2, with a source line for each claim.

### The Workflow Model From 1k to 1M Documents

The same stages run at every scale: accumulate, validate, consolidate, serve, evolve,
and export. What changes is which stage breaks first.
Parsing and validation dominate consolidation at every scale, so the first design
decision is to cache them, not which database to load.

| Step | Cost per record | At S2, 229,000 files | At S3, 920,000 files | Basis |
| --- | --- | --- | --- | --- |
| Parse YAML with libyaml | 0.27 to 0.35 ms on one core | 43 to 71 s with 4 workers, 79 s in one process (provisional) | 4 to 5 minutes on one core | Measured at S2; S3 inferred |
| softschema validation | 8.9 ms | 34 minutes on one core | 2.3 hours on one core | Measured at S0; S2 and S3 inferred |
| Structural check, stdlib subset checker | 0.19 ms | 42 CPU-seconds | About 3 CPU-minutes | Measured at S2-r2; S3 inferred |
| Decode cached JSON rows | 0.01 ms | 2.4 s (provisional) | About 10 s | Measured at S2; S3 inferred |
| Build the SQLite file | 0.07 to 0.08 ms | 17 to 18 s (provisional) | About 70 to 80 s | Measured at S2; S3 inferred |
| Load FalkorDB | 0.35 to 0.39 ms | 80 to 88 s (provisional) | Did not fit | Measured |
| Write YAML at export | 0.5 ms with 4 workers | 124 s (provisional) | About 8 minutes | Measured at S2; S3 inferred |

Three accumulation patterns are realistic: one file per entity edited in place,
append-only observations that a later step folds into entities, and one batch shard per
producer run.
The first gives review and history, and the others remove conflicts between
producers. The storage and format choices that fit each stage:

| Stage | About 5,000 documents (S0) | 50,000 to 250,000 (S1 and S2) | 1M and more (S3, projected) |
| --- | --- | --- | --- |
| System of record | One git repository, one YAML or Markdown file per entity | The same to about 100,000 documents (inferred), with sharded directories and no committed single-file exports: `edges.jsonl` passes GitHub’s 100 MiB file limit between S1 and S2. Past that, machine-written records start to move into batches | Append-only record batches over a consolidated base (inferred): 920,000 files and 2.9 GB of records strain git and hosting guidance. Per-entity files remain for reviewed records and as an export |
| Accumulation | Direct commits | Whole records in per-run batches, no shared derived files, and unresolved references allowed | Appended operation batches from many writers, identity lookups against the serving store, and merges recorded as redirect facts |
| Validation | Validate everything each run: 44 s | Cache by content hash and schema hash, and quarantine per record | The same. Uncached validation takes hours |
| Consolidation | Full rebuild: under 1 s of database time | Full rebuild from a row cache: 3 to 21 s of SQLite time | Full rebuild from a row cache, about 1.5 minutes inferred, or incremental batches through fsqlite v2 |
| Serving | Any store, FalkorDB included | A SQLite file with view indexes, in-file FTS5, and server-side pages | The same, plus facet summaries and a degree cap or an adjacency cache for hubs |
| Schema evolution | Rewrite the records and rebuild | Data-only changes, and a rebuild when an index changes | Mixed contract versions. Never rewrite every record |
| Export | Rewrite the tree: 3 s | Rewrite changed files only | Incremental and byte-stable, or git history becomes unusable |

The consolidation default is **incremental parse, full publish**: read only changed
files, keep parsed and validated rows in a cache keyed by content hash, regenerate the
whole database from the cache, and publish it atomically.
It keeps the correctness of a full rebuild, because the database stays a function of the
files, and it removes the two dominant costs.

Sources: [paraverse analysis](spikes/softschema-kb/notes/paraverse-analysis.md), section
3; FalkorDB [S0](spikes/softschema-kb/results/falkordb/S0/w1.json) and
[S2](spikes/softschema-kb/results/falkordb/S2/w1.json) imports; fsqlite
[S2](spikes/softschema-kb/results/fsqlite/S2/w1.json) and
[S2-r2](spikes/softschema-kb/results/fsqlite/S2-r2/w1.json) imports and
[S2 export](spikes/softschema-kb/results/fsqlite/S2/w5.json);
[GitHub’s file limits](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github).

### Formats by Role

Use each format for one role: YAML and Markdown records as the system of record to about
100,000 documents, JSONL as interchange, as cache, and as the record batches above that
scale, and SQLite as the serving store and portable artifact.
A graph store fits only the serving role, and only while the corpus fits in memory.

| Format | System of record | Interchange | Serving store |
| --- | --- | --- | --- |
| YAML files | Yes, to roughly 100,000 documents in one git repository (inferred; git was not measured): readable, diffable, and one history per entity. It is the slowest format to parse and has no transaction across files | Small sets only | No |
| Markdown with YAML frontmatter | Yes, for records that people read. The payload is the data. A generated body adds diff noise, and a hand-written body must be stored for export | For people and agents | No |
| JSONL | Yes above about 100,000 documents (inferred), as append-only record batches. Poor for review | Yes. It parses 14 times faster than YAML (probe) and suits the row cache and operation batches. Lines need an identity and an origin record | No |
| Graph store (FalkorDB) | No: data lives in memory, persistence is tied to the engine version, and no contract is enforced | No: the RDB is not a version-independent format | Yes, for a corpus that fits in memory. No measured advantage here |
| SQLite (plain or fsqlite) | Possible for machine-written facts at large scale, at the price of git review | Yes: one stable file that any tool opens | Yes |

- **One reader everywhere.** softschema’s portable YAML rules reject anchors, duplicate
  keys, and non-finite numbers, so producers, the consolidator, and the exporter should
  share its reader.
- **Derived JSONL exports do not scale as committed files.** Any change rewrites
  `_graph` and `_search` in full, and the S0 edge lines carry no identity and no origin
  record. Round 2 adds the origin, which incremental import needs.

Source: section 4 of the
[paraverse analysis](spikes/softschema-kb/notes/paraverse-analysis.md).

### The Four Systems From the Ground Up

The four differ most in where the data lives and in what one durable write costs.

| Aspect | FalkorDB, as paraverse uses it | Plain SQLite | fsqlite today (`f1.0`) | fsqlite v2, as prototyped |
| --- | --- | --- | --- | --- |
| What it is | A property-graph engine queried with Cypher: a Redis module (FalkorDB 4.18.3 on Redis 8.6.2) that FalkorDBLite 0.10.0 starts as a daemonized `redis-server` | An embedded SQL engine that reads and writes one database file inside the client process | SQLite files plus a directory protocol: each publish is a complete, immutable SQLite file, and an atomic `current` pointer names the head | The same immutable generations, with derived objects built inside each one and envelopes that can carry operations |
| Where data lives | In server memory, persisted as an RDB snapshot | In file pages, read on demand through the OS page cache | The same as SQLite, one file per published version | The same |
| Smallest durable change | One query is atomic. It is durable after the next snapshot or `SAVE`, which rewrites the whole dataset | One transaction. In WAL mode a commit writes the changed pages | One generation, which copies, checks, and fsyncs the whole file | One generation per publish cycle, shared by every envelope in the cycle |
| Concurrent writers | One at a time per graph, in arrival order, with no conflict detection | One at a time on one host. WAL is unsafe on network filesystems | `SnapshotStore` writers capture SQLite changesets on private copies without a lock, and a reconcile merges them by primary key under a policy. `DirectStore` serializes copy, mutate, publish | Writers append operation envelopes, each a file write, or sparse changesets. One serial reducer applies them in order |
| Schema | Open: labels, relationship types, and properties appear on write | Ordinary DDL at any time | Fixed for the life of a store. No virtual tables, so no FTS5 | Fixed base tables. Indexes, FTS5, statistics, and summaries are declared as derived objects and rebuilt by version |
| Text search | A built-in stemmed full-text index | FTS5 in the file | A scan, or an FTS5 sidecar file rebuilt for every version | FTS5 inside each generation |
| Artifact | One RDB file that only a `redis-server` with the module can load | One file that any SQLite tool opens | A directory. Any SQLite tool opens a generation | The same |
| Maturity and license | The engine is SSPLv1. FalkorDBLite is documented for development and CI | Public domain. The file format has been stable since 2004 | 0.1.0 alpha, MIT, draft format | Three spike patches and one combined patch, all unmerged |

Sources: [paraverse analysis](spikes/softschema-kb/notes/paraverse-analysis.md), section
5.1; [fsqlite design](../fsqlite-design.md);
[v2 design](spikes/softschema-kb/notes/fsqlite-v2-design.md), section 3.

### Import (W1)

SQLite builds the serving file 4 to 5 times faster than paraverse loads FalkorDB, with a
tenth of the memory, and the fsqlite protocol adds 7 to 11% to a plain SQLite load at
the largest scales.

| Arm | Ingest through durable, S1 (provisional) | S2 (provisional) | S2-r2 (provisional) | Peak memory at S2 | Artifact at S2 |
| --- | --- | --- | --- | --- | --- |
| FalkorDB, paraverse as built | 14.2 s | 88 s; 80 s with saves disabled | 86 s; 82 s | 5.07 GB loader and 1.70 GB server; 2.81 GB server with a snapshot fork | 0.28 GB RDB, payloads only |
| Plain SQLite control | 3.0 s | 16.6 s; 14.0 s with indexes built after the rows | 19.0 s; 14.9 s | 0.61 GB | 1.80 GB |
| fsqlite `DirectStore` | 3.6 s | 17.9 s | 21.1 s | 0.52 GB | 1.80 GB |
| fsqlite `SnapshotStore` | 7.7 s | 43.1 s | 56.1 s | 0.90 GB | 1.84 GB head in a 3.04 GB store |
| fsqlite v2 prototype, `DirectStore` with derived objects in the file | 4.7 s | 35.8 s, one run with a cold check | 28.6 s | 0.62 GB | 2.03 GB with FTS5 and facets |

- **Parsing costs more than the SQLite build and is the same work for every backend.**
  At S2 it took 71 s with 4 workers in the reported fsqlite run, 43 s in another, and 79
  s in one process in the FalkorDB arm (all provisional).
- **No W1 run includes softschema validation.** Paraverse’s default load skips it too.
  It took 44 s at S0, or 8.9 ms per record, which is 12 times the whole default load.
  A stdlib checker for the JSON Schema subset that the compiled schemas use took 0.19 ms
  of CPU per record in round 2.
- **Less than half of FalkorDB’s 88 s is ingest.** The load spends 42 s in batched
  `CREATE`, 17 s mapping in Python, 25 s on count checks, the unique constraint, and
  metadata, and 2.8 s in `SAVE`.
- **The v2 prototype is slower end to end as measured.** Building indexes after the rows
  halves row ingest (14.2 to 7.3 s at S2-r2). The derived build then spends 12 s on
  indexes, FTS5, the facet summary, and statistics, where the baseline leaves search to
  a 3.5 to 3.9 s sidecar and builds no statistics.
- **These are in-process times.** The fsqlite README’s table adds process start and a
  measurement-only check: 19.1 s for `DirectStore` at S2.
- **`SnapshotStore` is the wrong bulk route.** Applying changesets is slower than
  inserting, and its store keeps every applied envelope.

Sources: FalkorDB [S1](spikes/softschema-kb/results/falkordb/S1/w1.json),
[S2](spikes/softschema-kb/results/falkordb/S2/w1.json),
[S2 with saves disabled](spikes/softschema-kb/results/falkordb/S2/w1-save-disabled.json),
[S2-r2](spikes/softschema-kb/results/falkordb/S2-r2/w1.json), and
[S0](spikes/softschema-kb/results/falkordb/S0/w1.json) for validation; fsqlite
[S2](spikes/softschema-kb/results/fsqlite/S2/w1.json) and
[S2-r2](spikes/softschema-kb/results/fsqlite/S2-r2/w1.json); control
[S2](spikes/softschema-kb/results/fsqlite/S2/w1-plain-sqlite.json) and
[S2-r2](spikes/softschema-kb/results/fsqlite/S2-r2/w1-plain-sqlite.json); prototype
[S2](spikes/softschema-kb/results/fsqlite-v2/spike1/S2/w1.json) and
[S2-r2](spikes/softschema-kb/results/fsqlite-v2/spike1/S2-r2/w1.json).

### Incremental Accumulation and Concurrent Writers (W2)

For a small change, FalkorDB shows it first and fsqlite pays a fixed whole-file cost.
Once the change must be durable, the FalkorDB prototype costs as much as fsqlite’s
one-writer lane, or more.
Four concurrent writers were slower than one in both engines.
Of the arrangements that interleaved deletes and merges, only the v2 operation envelopes
were state-verified after one publish at every reference state, and they need stored
facts or a closure in the build for it.
fsqlite today reached a state-verified result after its repair publishes.
The FalkorDB run applied its deletes and merges serially after the writers, and its
states are W3-checked only.

Apply time at S2-r2, excluding the parse of the batch (all provisional):

| Change | FalkorDB as built: full rebuild, parse included | FalkorDB incremental prototype: visible, then durable | fsqlite today, one writer (`DirectStore`): visible and durable | fsqlite today, four writers (`SnapshotStore`) | fsqlite v2 prototype, four writers (operation envelopes) |
| --- | --- | --- | --- | --- | --- |
| 1 record | 226 s | 0.75 s, then 4.1 s | 2.9 s | Not run | Capture 0.47 ms, visible after a 2.4 to 2.6 s publish (S2) |
| 1% (2,390 operations) | 198 s | 1.9 s, then 4.5 s | 4.6 s | 46 s | 6.2 s |
| 5% (11,948) | 217 s | 5.6 s, then 8.9 s | 9.3 s | 77 s | 10.4 s |
| 20% (47,791) | 313 s | 31 s, then 35 s | 19.4 s | 92 s | 30 s |

- **Parsing the batch is extra and costs about as much as applying it.** It took 0.95,
  6.5, and 31 s in the FalkorDB arm and 1.8, 7.8, and 31 s in the fsqlite arm for the
  three bulk batches (provisional).
  The arm READMEs differ here: FalkorDB’s headline times include the parse, and
  fsqlite’s exclude it.
- **FalkorDB’s durable cost has a whole-corpus floor too.** Its `SAVE` rewrites the
  graph in 2.5 to 3.5 s at S2-r2 (provisional).
  An append-only file was not tested.
- **FalkorDB’s one-record figure is a workaround cost.** At S2-r2 the spike’s
  back-to-back write phases left nodes that later scans rejected.
  This is a suspected engine defect in FalkorDB 4.18.3, not yet isolated, and reading
  every label between write phases avoids it.
  At S1-r2, before the workaround, the same write took 7 ms (provisional).
- **The v2 prototype sustains an offered 200 one-record writes per second at S2, where
  fsqlite today saturates at 0.6 (provisional).** The figures come from different load
  models. fsqlite today ran a closed loop, one writer capturing as fast as it could, and
  published 0.6 records per second with a 16.5 s median delay.
  The v2 prototype was offered 200 per second and published all of them, 172 per second
  counting the final drain, with a 13.0 s p95 delay.
  That is a floor, not a capacity, and gc’s integrity check was 65% of each cycle.
  The FalkorDB prototype ran closed loops of 100 single operations with no save: 376 per
  second at S1-r2, and 1.0 at S2-r2 with the workaround.
- **Four writers are slower than one (provisional).** For the 5% batch, FalkorDB took 38
  s against 12 s, both including the parse.
  fsqlite today took 77 s against 9.3 s, because each of 20 captures copies the 1.95 GB
  head.
- **The v2 column ran under heavier load (provisional).** In the same session one
  `DirectStore` writer took 4.4, 15.0, and 36.9 s for the three batches, so four v2
  writers took 0.69 to 1.42 times one writer, against 4.3 to 10.2 times today.
- **Plain SQLite was not run through W2.** Probe: a durable one-record commit on a file
  of S2-r2 size takes 0.7 to 1.8 ms in WAL mode, and 100 records take 16 to 18 ms.

Correctness under concurrency:

| Property | FalkorDB incremental prototype | fsqlite today | fsqlite v2 prototype |
| --- | --- | --- | --- |
| Readers see a batch atomically | No. Each query is atomic, and a batch is several | Yes | Yes |
| Durable when visible | No | Yes | Yes |
| How the final state was checked | W3 answers after p05, and per-kind and per-relation counts against a full rebuild of the batch-applied KB. The run recorded no rows | Table digests against one writer in line order, W3 answers after p05, and the state check against the reference applier | The same, with the tombstone and redirect tables in the digests |
| Four writers with edge changes, deletes, and merges | W3-checked only, and count-equal. The run gave its writers upserts only and applied every delete and merge in one process afterward, so it did not interleave them | 1 to 3 of 20 envelopes quarantined as `NOTFOUND`. At S2-r2, 12 and 138 dangling edges remained and changed 6 of 124 answers. State-verified after a retry publish and a closure publish | Operation envelopes with stored tombstone and redirect facts: 0 quarantined, one publish, and state-verified, in spike 2 and in the combined prototype at S1-r2. Changeset envelopes with idempotent deletes: no quarantine, and known different. With a closure they are still known different after p20, by one edge |
| Two writers set one field | The last write wins, and the other value is gone | A per-table policy decides (`lww`, `union`, `strict`), and the losing value stays recoverable from its envelope | The same, with retention that keeps conflict evidence |
| One invalid record in a batch | The default load loads it, `load --validate` rejects the whole load, and the prototype quarantines it | Quarantined by the parse-stage schema check, and loaded without it | The same |
| Readers during writes | No errors. p95 rises: record 3.4 to 23 ms and table 61 to 310 ms at S2-r2 (provisional) | No errors. p95 unchanged at 17 to 111 ms (provisional) | No errors |

The [state check](spikes/softschema-kb/results/state-check.json) gives each after-batch
state its mark. Its reference states are S1-r2 after p05 and p20, and S2-r2 after p05.

| After-batch state | Mark | Basis |
| --- | --- | --- |
| FalkorDB incremental prototype, one process | W3-checked only | Counts and all 124 answers equal a full rebuild’s after p01, p05, and p20, and the oracle’s after p05. The run recorded no rows |
| FalkorDB incremental prototype, four writers | W3-checked only | Counts and answers equal those of its one-process state after p05. Deletes and merges were not interleaved |
| fsqlite loader, one writer in line order | State-verified | All 32 states that the four-writer runs built for comparison, and the 6 states of spike 2’s one-writer runs through `DirectStore` and through append capture |
| The fsqlite arm’s own one-writer run, which the timing table uses | W3-checked only | Its `SnapshotStore` lane recorded entity and edge totals, which equal the reference’s, and its `DirectStore` lane recorded timings only |
| fsqlite today, four writers, before the closure publish | Known different, by the run’s own count | 5 and 66 dangling edges at S1-r2 and 12 and 138 at S2-r2, after p05 and p20. These states are not in the state-check file |
| fsqlite today, four writers, after the retry and closure publishes | State-verified | 3 of 3 reference states, and row-equal in all 6 runs |
| v2 operation envelopes with stored facts | State-verified | Spike 2: 8 of 8 runs at reference states, and row-equal in all 15 runs. Combined prototype: after p05 and p20 |
| v2 operation envelopes, no facts, closure in the build | State-verified | Spike 2: 3 of 3 reference states, and row-equal in all 6 runs. Combined prototype: after p05 and p20 |
| v2 operation envelopes, no facts, no closure | Known different | 3 of 3 reference states. W3 after p05: 123 of 124 at S1-r2 and 124 of 124 at S2-r2 |
| v2 operation envelopes, no facts, cascade relations only | State-verified after p05, known different after p20 | Combined prototype: 264,194 edges against 264,200 |
| Changeset envelopes with idempotent deletes, no closure | Known different | 3 of 3 reference states. W3 after p05: 124 of 124 at S1-r2 and 118 of 124 at S2-r2 |
| Changeset envelopes with idempotent deletes and a closure | State-verified after p05, known different after p20 | S1-r2 only: 264,201 edges against 264,200 |
| Spike 1: changeset envelopes with closure by deletion in the build | Known different | S1-r2 only: 235,469 edges against 235,470 after p05, with 124 of 124 answers, and 264,191 against 264,200 after p20 |

- **One writer in line order reproduces the reference edges.** The reference applier’s
  edge digest equals the one-writer digest in every run that recorded one, so a
  row-equal state is state-verified at the three reference states.
- **After p01, and after p20 at S2-r2, row-equal is the strongest claim.** No reference
  state was built there.
  Seven of spike 2’s 15 operation-envelope runs are in that group.
- **Entity rows are checked more weakly than edges.** They are compared with the
  reference by count, and with the one-writer state by digest.

Sources: FalkorDB [S1-r2](spikes/softschema-kb/results/falkordb/S1-r2/w2.json) and
[S2-r2](spikes/softschema-kb/results/falkordb/S2-r2/w2.json); fsqlite
[one writer](spikes/softschema-kb/results/fsqlite/S2-r2/w2-v2.json), four writers at
[S1-r2](spikes/softschema-kb/results/fsqlite/S1-r2/w2.json) and
[S2-r2](spikes/softschema-kb/results/fsqlite/S2-r2/w2.json),
[trickle](spikes/softschema-kb/results/fsqlite/S2/w2-trickle.json), and
[conflicts](spikes/softschema-kb/results/fsqlite/S2/w2-conflict.json); prototype
[four writers](spikes/softschema-kb/results/fsqlite-v2/spike2/S2-r2/w2-ops.json),
[capture](spikes/softschema-kb/results/fsqlite-v2/spike2/S2/w2-trickle-capture.json),
and
[sustained](spikes/softschema-kb/results/fsqlite-v2/spike2/S2/w2-trickle-sustained-ops.json);
[v2 design](spikes/softschema-kb/notes/fsqlite-v2-design.md), appendix A.10, for the
probe.

### UI Query Latency and Hub Growth (W3)

SQLite was faster than FalkorDB in every category at every scale, growing hubs included,
and fsqlite adds nothing measurable to a plain SQLite read.

Warm p50 at S2-r2 in milliseconds: the median across each category’s 20 or 21 parameter
sets, with the slowest set in parentheses (all provisional):

| Category | FalkorDB | fsqlite today | Plain SQLite |
| --- | --- | --- | --- |
| Table page: sorted, filtered, 50 rows | 17.5 (131) | 0.30 (13.3) | 0.24 (12.0) |
| Record with one-hop neighbors | 0.66 (19.8) | 0.036 (2.4) | 0.039 (3.3) |
| Substring search by scan | 378 (438) | 46.6 (51.6) | 43.5 (49.7) |
| Path, by the shared application-side search | 1.14 (398) | 0.13 (154) | 0.13 (150) |
| Facet counts | 36.8 (203) | 17.9 (50) | 17.8 (49) |
| Two-hop neighborhood, capped at 200 | 0.72 (329) | 0.21 (256) | 0.21 (272) |

Hubs grow in both engines, and SQLite stays ahead.
From S1-r2 to S2-r2 the largest degree grows from 4,781 to 24,428 (timings provisional):

| Query | FalkorDB, S1-r2 to S2-r2 | fsqlite today, S1-r2 to S2-r2 |
| --- | --- | --- |
| Hub record, `org:openai` | 3.9 to 19.8 ms | 0.45 to 2.4 ms |
| Hub neighborhood, `software:vs-code` | 56 to 329 ms | 43 to 256 ms |
| Slowest path | 68 to 398 ms | 19 to 154 ms |
| Last page of all repositories | 13.6 to 131 ms | 0.49 to 2.0 ms |

- **fsqlite’s p50 was lower on nearly every query (provisional).** It was lower on 24 of
  24 round-1 queries at S0, S1, and S2, and on 123 of 124 round-2 queries at S1-r2 and
  at S2-r2. The median ratio of FalkorDB to fsqlite is 6.0, 6.3, and 8.0 at the three
  round-1 scales and 7.7 and 8.0 at the two round-2 scales.
  The median ratio of fsqlite to the plain SQLite control is 0.99 to 1.03.
- **Part of the gap is architecture and client runtime.** Each FalkorDB query crosses a
  socket to the server from a Python client, and each SQLite query runs in process in
  Node. The shared path search, result shaping, and JSON decoding run in those two
  runtimes.
- **The two search scans are not the same work.** SQLite scans `search_text`, a table
  that the load fills with the three fields already lower-cased, 63 MB at S2. FalkorDB
  lower-cases three properties of every entity node at query time.
  The search row compares a prepared structure with an unprepared one.
- **The engines’ own path forms did worse than the shared search.** FalkorDB has no
  undirected `shortestPath` and cannot exclude hub kinds inside one.
  At S2-r2, under a 30 s statement timeout, its in-engine iterative deepening timed out
  on 2 of 21 paths and `algo.SPpaths` on 1 of 5. SQLite’s recursive query took 66 to 412
  ms at S2 (provisional) and was run in round 1 only.
- **Native text indexes are close in speed and differ in meaning (provisional).**
  FalkorDB’s stemmed index answers in 1.6 ms at the median and matches different rows,
  so it is not compared.
  The FTS5 trigram sidecar answers in 2.05 ms and returns the oracle’s rows.
  In the v2 prototype the in-file FTS5 index answers in 0.35 to 3.6 ms across four
  scales, and a facet summary table in 0.07 to 0.28 ms against 3.5 to 30 ms.
- **Both planners need help (provisional).** FalkorDB sorts a whole label for each page
  although a range index exists, and starts an unanchored two-hop pattern from a label
  scan: 174 ms against 1.7 ms.
  SQLite needed `INDEXED BY` for one view, 99.8 ms against 0.03 ms, and statistics for a
  hub join: 5.4 s unhinted against 8.6 ms with statistics in the v2 prototype.
- **Round 1 could not show the hub results.** Its corpora keep the largest degree at 533
  at every scale, so record, path, and neighborhood times were flat for both backends.
- **First queries differ in kind (provisional).** An fsqlite cold query reads from disk:
  up to 1.05 s for the hub neighborhood at S2-r2 after the page cache is evicted.
  FalkorDB pays at start-up: 12 to 20 s to load the RDB at S2.

Sources: FalkorDB [S1-r2](spikes/softschema-kb/results/falkordb/S1-r2/w3.json) and
[S2-r2](spikes/softschema-kb/results/falkordb/S2-r2/w3.json), with the uncompared forms
under `extras`; fsqlite [scan](spikes/softschema-kb/results/fsqlite/S2-r2/w3.json),
[sidecar](spikes/softschema-kb/results/fsqlite/S2-r2/w3-fts.json),
[plans](spikes/softschema-kb/results/fsqlite/S2-r2/w3-plans.json), and
[recursive paths](spikes/softschema-kb/results/fsqlite/S2/w3-path-cte.json);
[control](spikes/softschema-kb/results/fsqlite/S2-r2/w3-plain-sqlite.json);
[spike 1](spikes/softschema-kb/fsqlite-v2/spike1/README.md).

### Memory, Disk, and the 1M Scale

Neither arm loaded 1M nodes on the 16 GB VM. A 6 GB memory guard stopped paraverse’s
loader before it parsed a record.
The fsqlite run was not started, because its projected disk use with concurrent writers
exceeds the free space.

| Measure | FalkorDB | Plain SQLite and fsqlite today | fsqlite v2 prototype |
| --- | --- | --- | --- |
| Serving memory at S2 | 1.33 GB in the server; 1.47 GB resident at S2-r2 | 0.17 GB process with a 64 MiB page cache. File pages live in the OS page cache, and their resident size was not measured | The same |
| Start-up to first query at S2 (provisional) | 12 to 20 s | 6 to 9 ms to open, 1 ms for the first query | The same |
| Memory during a rebuild at S2 | 5.1 to 6.0 GB loader; 3.1 to 3.3 GB server while the staging and live graphs coexist | 0.5 to 0.9 GB | 0.62 GB |
| Disk per version at S2 | 0.28 GB RDB, payloads only | 1.80 GB: payloads, documents, bodies, search text, opaque files, indexes | 2.03 GB, including 0.17 GB of FTS5 and facets |
| Extra disk while writing | One RDB rewrite per save | fsqlite: one head copy per capture in flight, 7.2 GB for 4 writers, and a `SnapshotStore` import store of 1.65 times the head | A 2 KB envelope per one-record capture; the store is 1.00 times the head after maintenance at S0 and S1 |
| 1M nodes (S3) on this VM | Stopped by the 6 GB memory guard before the first record was parsed; about 20 GB projected for the loader | Not run. Projected: 6.7 GiB per version, 11.8 GiB for a `DirectStore` import against 13.9 GiB free, and 33.7 GiB for four concurrent writers | Inferred: 13.4 GiB with coalesced publishes, or 6.7 GiB plus changes with reflinks |

The sizes are not at equal content: 23% of the SQLite file is export-only line storage,
and the paraverse graph stores no bodies, document heads, or search documents.

Sources: FalkorDB [S2 load](spikes/softschema-kb/results/falkordb/S2/w1.json),
[S2 rebuilds](spikes/softschema-kb/results/falkordb/S2/w2.json),
[S2-r2 operations](spikes/softschema-kb/results/falkordb/S2-r2/w6.json), and the
[S3 abort](spikes/softschema-kb/results/falkordb/S3/w1.json); fsqlite
[S2 operations](spikes/softschema-kb/results/fsqlite/S2/w6.json) and
[S3 feasibility](spikes/softschema-kb/results/fsqlite/S3/feasibility.json);
[spike 3 import store](spikes/softschema-kb/results/fsqlite-v2/spike3/S1/w1.json).

### Schema Evolution (W4)

With payloads stored as JSON documents, a new kind, field, or relation is a data change
in SQLite and needs no DDL. Only a new index changes the physical schema: it costs a new
store in fsqlite today and one publish in the v2 prototype.
FalkorDB’s engine needs no migration either, but paraverse’s code tables do.

The generic mapping keeps one `entity` table with each payload as JSON, one `edge`
table, and document tables for export.
Its DDL depends only on the UI’s table views: each view (kind, filter, sort) is one
partial expression index.

| Case (timings provisional) | FalkorDB, paraverse as built (S2-r2) | FalkorDB, in-place Cypher (S2-r2) | fsqlite today, generic mapping (S2) | fsqlite v2 prototype |
| --- | --- | --- | --- | --- |
| New kind | Fails unmodified with `MappingError`. Two changed lines, then a 228 s rebuild | 7.5 s | Data only: 24 s, of which 19 s is the diff of two KB trees | The same route |
| Optional field | Rebuild only: 232 s | 11.5 s | Data only: 26 s | The same route |
| Renamed relation | Rebuild only: 252 s. Queries that name it must change | 6.9 s | Data only: 24 s | The same route |
| String becomes an object | Rebuild: 174 s. Every filter on the field then matches nothing, 7,590 rows to 0, because a map is not a property | 20.7 s | Data only: 35 s | The same route |
| A field becomes sortable (new index) | Not run. The engine creates an index on request, and paraverse lists indexes in code | Not run | A new store and a reader cutover: 16.8 s. `CREATE INDEX` in a write is refused | A derived version bump in the same store: 2.5 to 4.5 s at S2-r2 |
| Two contract versions of one kind | Not run | Not run | Not run | Not run |

- **Plain SQLite uses ordinary DDL.** The control builds every index in 2.9 s at S2
  (provisional).
- **Typed per-kind tables were measured for size and migration time only.** They are 24%
  smaller for records and edges.
  On fsqlite today an added column is a new store, 8.8 s at S2 (provisional), and on
  plain SQLite it is ordinary DDL. No W3 run used the typed mapping, and the generic
  tables are still needed for export.
- **No case exercised mixed contract versions.** The variants rewrite the affected
  record files and re-hash the schema under the same contract name.
  The files can carry mixed versions, because each record names its own contract, and
  softschema lets a new kind start `soft` and tighten later.

Sources: FalkorDB [S2-r2](spikes/softschema-kb/results/falkordb/S2-r2/w4.json); fsqlite
[S2](spikes/softschema-kb/results/fsqlite/S2/w4.json); prototype
[S2-r2](spikes/softschema-kb/results/fsqlite-v2/spike1/S2-r2/w4-case5-repeat.json).

### Export Fidelity (W5)

Export fidelity follows what the store keeps, not which engine it is.
The fsqlite arm stores document heads, bodies, and opaque files and exports the KB
almost byte for byte.
The paraverse graph stores payloads only.

| Measure | FalkorDB, paraverse graph (S2-r2) | fsqlite today (S2) |
| --- | --- | --- |
| Parsed payloads equal | 224,800 of 224,800 | All |
| Byte-identical files | 0 | 228,873 of 228,876 |
| What differs or is lost | Key order and YAML style in every file; 64,195 Markdown bodies; the export names of 26,542 profiles. `_search`, `coverage.json`, `faq.yaml`, `media.yaml`, `README.md`, and 2 schemas are not in the graph | Two `_graph` files hold the same rows in key order, and one schema file differs by one quoting choice |
| Export time (provisional) | 447 s in one process | 129 s with 4 workers, 4.5 s of it for the graph and opaque files |
| The reloaded export gives the same W3 results | Yes | Yes |
| Reader | Cypher against a running server | Python’s standard `sqlite3`, with no fsqlite code |

- **Writing YAML dominates export, as parsing dominates import.**
- **Byte fidelity needs the producer’s serializer settings.** softschema defines no
  canonical record serialization, so the exporter copies the dataset’s dumper settings.
- **Neither exporter is incremental.** An export after a small change rewrites every
  file.

Sources: FalkorDB [S2-r2](spikes/softschema-kb/results/falkordb/S2-r2/w5.json); fsqlite
[S2](spikes/softschema-kb/results/fsqlite/S2/w5.json).

### Operations and Crash Recovery (W6)

SQLite files are simpler to run: no resident process, a millisecond start, and standard
tools. The weak points of fsqlite `f1.0` are manual lock recovery and a gc that refuses
under contention, and the v2 prototype removes both.

| Measure | FalkorDB | fsqlite today | fsqlite v2 prototype |
| --- | --- | --- | --- |
| Artifacts | An RDB file, a settings file, and a running `redis-server` with the module | `fsqlite.json`, `current`, and one SQLite file per retained version | The same, plus verification records and a floor |
| Standard tools | The system’s Redis 7.0.15 cannot open the file (RDB format version 13) | Python’s `sqlite3` opens a snapshot directly, and `quick_check` is `ok` | The same |
| Kill the loader or a writer | The live graph is intact. An orphan staging graph, a full copy in memory, stays until someone deletes it | The head is never damaged, and no envelope is applied twice | The same |
| Kill the server or the lock holder | The restarted server serves the previous load: a load completed 5 s earlier is lost. At S1 it would not restart until a stale settings file was deleted | 2 of 4 kill points hold the lock, and an operator must remove `publish.lock` before repair runs | 8 of 8 recoveries with no operator step, in 4 to 308 ms, at S0 and S1. The combined prototype repeated the publication kill at S1-r2 |
| Maintenance | None measured | `gc` gave up on 6 to 10 of 20 attempts under contending `DirectStore` writers. `validate()` takes 3.4 s at S2 (provisional) | 0 of 20 refusals. Reader reopen p95 is 9 to 39 ms against 0.8 to 3.0 s (provisional) |
| Client defaults | redis-py’s 5 s socket timeout fails paraverse’s own load check at S2, so every run disabled it | None found | None found |

Sources: FalkorDB [S1](spikes/softschema-kb/results/falkordb/S1/w6.json) and
[S2-r2](spikes/softschema-kb/results/falkordb/S2-r2/w6.json); fsqlite
[S1](spikes/softschema-kb/results/fsqlite/S1/w6.json) and
[S2](spikes/softschema-kb/results/fsqlite/S2/w6.json); prototype
[kill points](spikes/softschema-kb/results/fsqlite-v2/spike3/S1/w6.json) and
[gc under writers](spikes/softschema-kb/results/fsqlite-v2/spike3/S1/w2-direct.json).

### What the fsqlite v2 Prototypes Confirmed and Refuted

Three prototypes, each a patch against scratch copies of the package and the harness,
confirmed 11 of 13 hypotheses, refuted 2, and changed four design details.
A combined prototype then put the three patches in one copy, and it passes the package
tests and the S1-r2 correctness runs.
Letters refer to the changes in the
[v2 design](spikes/softschema-kb/notes/fsqlite-v2-design.md).
All timings are provisional, and the after-batch marks come from the
[state check](spikes/softschema-kb/results/state-check.json).

| Change | Spike | Outcome | Evidence |
| --- | --- | --- | --- |
| (e) Derived objects, statistics, and plan assertions built in each generation | 1 | Confirmed | Indexed search is visible with the data. The hook takes at most 16 ms for up to 100 records. The unhinted hub join falls from 5,405 to 8.6 ms. A build that asserts a plan it cannot get is refused and publishes nothing. An index change publishes in the same store in 2.5 to 4.5 s against 16.8 s for a new store |
| (e) A 256 MiB build cache | 1 | Refuted at S2-r2 | No consistent effect at 2 GB. The 24 to 26% gain comes from building derived objects after the rows |
| (e) Sampled statistics | 1 | Changed | `analysis_limit = 1000` moved a count off its index, 0.14 to 15.7 ms. The build runs a full `ANALYZE`, 1.0 to 1.7 s at S2, and asserts the plan |
| (e) Closure by deletion in the build | 1 | Changed | It removes dangling edges in milliseconds. It cannot retarget an edge to a merge survivor, so its four-writer states are known different: 235,469 edges against 235,470 after p05, and 264,191 against 264,200 after p20. Merges need stored tombstone and redirect facts |
| (k) Operation envelopes applied by a serial reducer | 2 | Confirmed | Capture takes 0.47 ms at S2 against 1.1 to 1.3 s. Four writers need one publish, with no quarantine, and are row-equal to one writer in 15 of 15 runs. The 8 runs at reference states are state-verified. Without stored facts or closure, 1 to 70 dangling edges remain, and the states are known different |
| (l) Sparse-seed changeset capture | 2 | Confirmed, with a hazard | 3.2 ms for one record and 7.8 ms for 100, with digests equal to a full copy. A row that the hydration plan misses changes the result without an error, and the detecting helper is not built |
| (n) Missing-row policy and changeset admission | 2 | Confirmed, and not sufficient | No `NOTFOUND` quarantine. The dangling edges stay until a closure runs, 17 and 470 at S2-r2, and those states are known different. Changesets with closure are state-verified after p05 and known different after p20 at S1-r2, by one edge, so cross-record structures need operation envelopes |
| (d) Coalescing publisher | 2 | Confirmed | 172 records per second published at S2, with a p95 delay of 1.39 cycles, against 0.6 per second |
| (i) gc against a pinned, verified generation | 3 | Confirmed, and changed | 0 of 20 refusals against 6 to 10, measured with the link commit (h) in the same patch. Collecting only against a full verification kept every generation between scrubs, 147 in 20 s at S0, so the prototype also collects against the publish check |
| (g) Envelope retention and a ledger floor | 3 | Confirmed at S0 and S1 | The import store is 1.00 times the head against 1.61 to 1.63 times, also with (h) in the patch |
| (h) Commit by no-replace link, with an expirable lease | 3 | Confirmed at S0 and S1, and changed | 8 of 8 kill-point recoveries with no operator. Probing forward from the `current` hint is unsound after gc, so the head is read from a directory listing |
| (i) and (g) Halving the sustained trickle round | 3 | Refuted, narrowly | The round falls 47% at S2, from 8.7 to 4.6 s. What remains is the unlink of the old head |

The [combined prototype](spikes/softschema-kb/fsqlite-v2/combined/README.md) applies the
patches in the order 3, 1, 2 and merges the hunks that conflict.
It checks answers and states at S1-r2 and reports no timing:

| Check | Outcome |
| --- | --- |
| Package tests | 279 run: 278 pass and 1 is skipped, as in the unmodified package |
| W3 on a fresh load, by scan and by the in-file FTS5 index | 124 of 124 each |
| Four writers with operation envelopes, batch p05 | One publish, 0 quarantined, W3-checked, and state-verified |
| Four writers, batch p20 | 0 dangling edges, and state-verified. No W3 run followed p20 |
| Merges at p20 with a reducer that keeps no facts | One closure at build moved 13 edges to their merge survivors and removed 15 edges of deleted nodes, so the survivors carry their 557 one-writer edges, and the state is state-verified. Cascade relations alone delete those edges and leave 551, a known-different state of 264,194 edges against 264,200 |
| Kill during publication, holding the lease | Recovered with no operator step and no lost generation, and 360 envelopes applied exactly once |

- **The combination leaves gaps.** The schema-agnostic CLI cannot roll a corrupt head
  forward, because repair now needs the application’s schema, derived specification, and
  reducers. Changed keys are approximate, so derived hooks must be idempotent per key.
  The knowledge-base closure trusts tombstones, so a writer that leaves a tombstone on a
  live node would lose that node’s edges.
  The format marker is still `f1.0`.
- **The combined run is narrow.** It did not carry spike 2’s trickle and sustained runs,
  and it did not run three of the four kill points, changeset envelopes with the
  missing-row policy, any timing, or any S2 scale.
- **Four changes were not prototyped.** Clone copies (a) need a reflink filesystem,
  which the VM lacks. Migration steps (f), generation manifests (m), and a WAL live head
  (j) were left for later spikes.
- **A probe rejected two changes.** Shards (b) and attached overlays (c) made reads 2.5
  to 133 times slower.
- **Two confirmations need the quiet pass.** Four v2 writers took 0.69 to 1.42 times one
  writer in the same session and 1.1 to 2.0 times round 2’s quieter one-writer times, so
  the bound of 1.5 holds against the first only.
  The index change met its 5 s bound at S2-r2, and the one S2 run took 39 s with a cold
  check.
- **The combined effect on timings is still inferred.** The spikes timed their patches
  one at a time, and the combined prototype reports no timing.
  Spike 1 alone made the sustained trickle worse, 0.23 records per second, because the
  `f1.0` gc then also checks the FTS5 index.
- **Each patched copy passes the package’s test suite.** Spikes 1 and 2 changed no
  existing test. Spike 3 rewrote the publication, fencing, gc, repair, crash, and kill
  suites where a rule changed, and the combined copy adjusts two more tests.

Sources: [spike 1](spikes/softschema-kb/fsqlite-v2/spike1/README.md),
[spike 2](spikes/softschema-kb/fsqlite-v2/spike2/README.md),
[spike 3](spikes/softschema-kb/fsqlite-v2/spike3/README.md), and the
[combined prototype](spikes/softschema-kb/fsqlite-v2/combined/README.md), with their
patches and [results](spikes/softschema-kb/results/fsqlite-v2/).

## Key Insights

- **The database is not the bottleneck.** Once parsing and validation are cached, a full
  rebuild of the SQLite file is the cheapest stage, so the store should be chosen for
  its guarantees and its operations, not for import speed.
- **A rebuildable projection makes plain SQLite and fsqlite equal for serving.** The
  fixed schema of fsqlite costs little when every schema change is a rebuild into a new
  store, and the rebuild uses none of what separates fsqlite from a plain file.
  fsqlite’s value lies in accumulation and publication.
- **No graph-engine advantage appeared at this graph shape.** Indexed joins and one
  application-side bidirectional search beat the engine’s traversals, hubs included.
  How a query treats hubs matters more than which engine runs it.
- **Latency alone does not decide at 250,000 nodes.** Both stores answer every compared
  query in under half a second at the median (provisional).
  Memory, start-up, rebuild time, export, and the artifact separate them more.
- **FalkorDB’s fast small writes are deferred durability.** Its `SAVE` rewrites the
  corpus, as an fsqlite publish does.
  At equal guarantees the two cost the same at 1% and 5%, and fsqlite is faster at 20%
  (provisional).
- **Concurrent capture bought nothing in either engine.** One serial applier fed by
  cheap appends was faster, and of the arrangements that interleaved deletes and merges
  it was the only one that was state-verified after one publish at every reference
  state. A row changeset replays the consequences one writer saw and none of the rule
  that produced them, so envelopes should carry facts and builds should derive.
- **A query oracle is not a state oracle.** Four after-batch states with wrong edges
  gave all 124 oracle answers, because the batches leave queried entities alone and the
  queries join through entities.
  The state check against the reference applier marks all four as known different, and
  an incremental backend should record its rows for that check.
- **Export fidelity is a storage-content decision.** Documents, bodies, and export lines
  take a third of the SQLite file at S2 and buy a byte-exact export.
- **The remaining v2 cost is structural.** Without reflinks, a store can have only two
  of three properties: one complete file per generation, immutable published files, and
  a publish cost proportional to the change.
  v2 keeps the first two and pays the third once per cycle.
- **Planner behavior belongs in the artifact.** Statistics and plan assertions built
  into each generation caught regressions that query hints had hidden.

## Comparison Matrix

Measured values are at S2 or S2-r2 unless a cell says otherwise.
Rows marked (provisional) hold contended timings.

| Criterion | FalkorDB, as paraverse uses it | Plain SQLite | fsqlite today (`f1.0`) | fsqlite v2, as prototyped |
| --- | --- | --- | --- | --- |
| Import, ingest through durable (provisional) | 88 s | 16.6 s | 17.9 s through `DirectStore` | 29 to 36 s, with search and statistics built in |
| Peak memory during import | 5.07 GB loader and 1.70 GB server | 0.61 GB | 0.52 GB | 0.62 GB |
| One record, visible then durable (provisional) | 0.75 s, then 4.1 s (prototype); 226 s as built | Probe: 0.7 to 1.8 ms in WAL mode | 2.9 s, both at once | Capture 0.47 ms; both after the next publish, 2.4 to 2.6 s |
| 5% batch, visible then durable (provisional) | 5.6 s, then 8.9 s (prototype); 217 s as built | Not run | 9.3 s with one writer; 77 s with four | 10.4 s with four writers |
| Sustained one-record writes, by load model (provisional) | Closed loop, not durable: 376 per second at S1-r2, and 1.0 at S2-r2 with the workaround for the suspected defect | Not run | Closed loop, saturated: 0.6 per second | Offered 200 per second, all published: 172 per second with the final drain |
| Batch atomic and durable when visible | No | Yes, per transaction | Yes, per generation | Yes |
| Four writers with deletes and merges | W3-checked only, with equal counts; deletes and merges were applied serially afterward, not interleaved | Writers queue on one file; not run | Known different until two repair publishes, then state-verified | State-verified in one publish |
| Conflicting writes | Last write wins; the loser is lost | Last commit wins | Per-table policy; the loser is recoverable | The same |
| Table page, record, substring search (provisional) | 17.5, 0.66, 378 ms | 0.24, 0.039, 43.5 ms | 0.30, 0.036, 46.6 ms | The same reads |
| Hub neighborhood, slowest path (provisional) | 329, 398 ms | 272, 150 ms | 256, 154 ms | The same reads |
| Indexed text search (provisional) | Built in, stemmed, 1.6 ms | FTS5 in the file | Sidecar rebuilt per version: 3.5 to 4.4 s and 148 MB | In the generation, 0.35 to 3.6 ms, maintained in 1 to 12 ms per publish |
| Serving memory | 1.33 GB in the server | The same as fsqlite | 0.17 GB process, plus file pages in the OS page cache, which were not measured | The same |
| Start-up to first query (provisional) | 12 to 20 s | A file open | 6 to 9 ms to open, 1 ms to query | The same |
| Disk | 0.28 GB RDB, payloads only | 1.80 GB | 1.80 GB per version, plus one copy per capture in flight | 2.03 GB per version; envelopes of a few KB |
| 1M nodes on a 16 GB VM | The load was stopped at 6 GB of loader memory | Not run; 6.7 GiB projected | Not run; fits for import, not for four writers | Inferred: 13.4 GiB, less with reflinks |
| New kind or field (provisional) | Code change for a new kind; 174 to 252 s rebuild or 7 to 21 s in place | Data only | Data only: 24 to 35 s | The same |
| New index (provisional) | On request; not run | `CREATE INDEX`; all indexes build in 2.9 s | A new store: 16.8 s | The same store: 2.5 to 4.5 s |
| Export fidelity | Payloads only; 0 files byte-identical | As stored; not run | 228,873 of 228,876 files byte-identical | The same |
| Crash recovery | Orphan staging graphs; a finished load can be lost | Automatic | Head safe; manual lock removal at 2 of 4 kill points | No operator step in 8 of 8 recoveries, and in the combined prototype’s one |
| Artifact | An RDB tied to the module and its version | Any SQLite tool | Any SQLite tool | Any SQLite tool |
| Maturity | Engine SSPLv1; FalkorDBLite for development and CI | Stable since 2004 | Alpha | Three spike patches and one combined patch, unmerged |

## Options Considered

### Option A: FalkorDB Projection, as Paraverse Builds It

**Description:** Load the whole KB into a staging graph and rename it over the live one,
as paraverse does today, with an optional incremental upsert path.

**Pros:**

- An open schema: a new relation or optional scalar field loads and renders with no code
  change
- Cypher expresses neighborhoods and paths directly, and a stemmed full-text index is
  built in
- A small change costs what it changes in the incremental prototype: 7 ms for one record
  at S1-r2 (provisional)
- The staging graph and `RENAME` give an atomic swap, and a rebuild barely moves reader
  latency
- It works well at paraverse’s size: S0 loads in 3.6 s into a 0.12 GB server
  (provisional)

**Cons:**

- The whole corpus lives in memory, and paraverse’s loader holds it again: 5.07 GB and
  1.70 GB at S2, and no load at 1M
- It was slower in every W3 category, and sorted pages and facets scan a label
- One query is the atomic unit, and a load is durable only after a snapshot
- Properties cannot hold maps, so nested payloads are opaque strings and a
  string-to-object change silently empties filters
- The persisted file is tied to the engine version, the engine is SSPLv1, and
  FalkorDBLite is documented for development
- A suspected engine defect, not yet isolated, left unreadable nodes after back-to-back
  incremental writes at S2-r2
- A new kind needs code changes in paraverse’s tables

### Option B: Plain SQLite Projection

**Description:** One consolidating process builds a SQLite file with the generic mapping
at a temporary path and renames it into place, or updates it in WAL mode on one host.

**Pros:**

- The fastest import, and reads equal to the best measured
- One portable file, ordinary DDL, FTS5, and `ANALYZE` with no restrictions
- Small durable commits near 1 ms in WAL mode (probe)
- The simplest operations, with automatic crash recovery

**Cons:**

- One writer at a time on one host, and WAL is unsafe on shared and cloud paths
- No versioned generations: a point-in-time copy is a whole-file backup
- Writers in several processes or languages must queue behind one owner
- Only import and queries were measured in this arm

### Option C: fsqlite Today (`f1.0`)

**Description:** Publish each consolidated state as an immutable generation through
`DirectStore`, or merge writers’ changesets through `SnapshotStore`.

**Pros:**

- Reads at plain SQLite speed, from files any tool opens
- Each batch is atomic and durable when the call returns
- A conflict policy with a recoverable loser, and an exactly-once ledger
- A byte-exact export and data-only schema changes with the generic mapping
- Import through `DirectStore` costs 7 to 11% over plain SQLite at the largest scales
  (provisional)

**Cons:**

- Every publish copies the whole file: 2.6 s for one record at S2 and 0.6 records per
  second sustained (provisional)
- Four writers take 46 to 92 s at S2-r2 (provisional), and their merged state is known
  different for edge changes, deletes, and merges until repair passes make it
  state-verified
- No virtual tables, so indexed search is a sidecar rebuilt for every version
- An index change is a new store, and statistics cannot travel in an envelope
- gc refuses under contention, the envelope archive is never pruned, and a lock-holding
  crash needs an operator
- Disk use is one head per capture in flight and per retained generation

### Option D: fsqlite v2 With a KB Layer (Recommended for Accumulation and Publication)

**Description:** Keep one immutable SQLite file per generation.
Add derived objects built in each generation, operation envelopes applied by a serial
reducer, verified retention, and a link commit with an expirable lease.
Put the entity, edge, and softschema logic in a separate package.

**Pros:**

- Capture cost stops depending on the head, and producers in any language can append
- Four writers publish once with a state-verified result
- Search, statistics, and summaries travel inside the standard file
- An index change stays in the same store
- gc no longer refuses, the store stays near one head in size, and crashes recover
  without an operator

**Cons:**

- It is not built: three spike patches timed one at a time under contention, and a
  combined patch checked for correctness at S1-r2 and not timed
- Roll-forward repair needs the application’s schema, derived specification, and
  reducers, so the schema-agnostic CLI cannot repair a corrupt head
- The prototypes’ lease takeover, hook isolation, and changeset admission have security
  gaps that the specification must close
- A publish still copies the head on ext4, 2.4 to 3.9 s at S2 (probe), until reflinks or
  manifests are measured
- Reducers and derive hooks must be deterministic, and they put application code in the
  publisher
- The link commit changes a core guarantee and needs a written interleaving model and a
  shared-filesystem run
- In-file derived objects add 6 to 13% to the file, and the prototype’s import was
  slower as measured

### Option E: SQLite Artifact With an In-Memory Graph Cache

**Description:** Serve from SQLite, and build a compressed adjacency in the server
process from each generation for multi-hop queries through hubs.

**Pros:**

- Probe at S2-r2: the two-hop neighborhood of the largest hub takes 41 to 45 ms against
  942 to 968 ms for the recursive SQL
- It builds in 2.1 to 2.3 s from 1.16 M edges, and the arrays take 10.4 MB
- It is keyed by generation and discarded freely, so it adds no second system of record

**Cons:**

- It is a probe, not a W3 run, and its unoptimized id maps took about 270 MiB
- It is worth building only if hub expansions become a product requirement

### Eliminated Options

- **FalkorDB as the system of record or the interchange artifact:** data lives in
  memory, persistence is tied to the engine’s version, no contract is enforced, and the
  last conflicting write silently wins.
- **Sharded generations and attached overlays in fsqlite:** a probe with 8 shards made
  an ordered page 2.5 times slower, a facet 12 times, and a two-hop neighborhood 133
  times, and this SQLite build attaches at most 10 databases.
- **Recycling superseded generation files in place:** a standard tool that still holds
  an old file would read a different database without an error.
- **Typed per-kind tables as the default mapping:** the generic tables are still needed
  for export, and one generic mapping needs no per-kind DDL. The typed mapping was
  measured for size and migration time only, and no W3 run used it.
- **`SnapshotStore` as the bulk import route:** it is 2.4 to 2.7 times slower than
  `DirectStore` (provisional) and leaves a store 1.65 times the head.
- **Row-changeset merging for cross-record structures:** even with idempotent deletes
  and an in-build closure, one edge differed from the one-writer state.
- **Committed single-file `_graph` and `_search` exports at scale:** they pass GitHub’s
  100 MiB file limit between S1 and S2, and any change rewrites them in full.

## Recommendations

Keep softschema records as the system of record: one file per entity in git to about
100,000 documents, and append-only record batches above that (both inferred).
Serve from a SQLite file that a generic KB layer builds, and develop fsqlite v2 as the
way many writers accumulate into published generations.

```text
softschema records: files in git, then batches   system of record
  -> parse and validate changed files            one reader, cached by content hash
  -> JSONL rows and operation batches            interchange, not committed at scale
  -> KB layer: mapping, reducer, derive          a separate package
  -> SQLite generation (plain file or fsqlite)   serving store and portable artifact
  -> UI, CLI, and export back to records
```

### The System of Record by Scale

The records stay softschema records at every scale, and their container changes.

- **To about 100,000 documents, one file per entity in git.** The limit is inferred.
  GitHub blocks files over 100 MiB and recommends repositories under 1 GB. S2 holds 712
  MB of records in 228,852 files, and by their S0 proportions its edge and search
  exports each pass 100 MiB. No workflow measured git.
- **Above that, append-only record batches over a consolidated base.** A batch holds
  full records with their upsert, delete, and merge operations, as the spike’s batch
  format v2 does. The reference applier rebuilds the per-entity tree from a base and a
  batch. After p05 each arm that applied a batch gave the oracle’s answers for that tree,
  and the fsqlite loader’s one-writer state is also state-verified against it.
  Batches as the record were not run at scale.
- **Per-entity files remain** for the records that people review, and as an export of
  the rest.
- **Splitting the corpus across repositories delays the switch.** Paraverse already
  composes several KB directories into one view.
- **No database is the record.** The projection is rebuilt from the base and the
  batches. fsqlite v2 prunes applied envelopes, so the batches are kept outside the
  store.

### The Role of Each Component

| Component | Role |
| --- | --- |
| softschema records | The system of record. To about 100,000 documents: one entity per file in git, sharded directories, provenance in the payload, and no committed derived exports. Above that: append-only batches of full records and operations over a consolidated base |
| softschema | Contracts, compiled schemas, and validation. It should gain declared annotations for identity, reference targets, relation names and directions, field order, and index hints; schema file names that carry the contract version; and a canonical record serialization |
| JSONL row cache and operation batches | Interchange between parsing and import, keyed by content hash and schema hash. Edges carry their origin record, deletes are explicit, and merges are redirect facts, as in the spike’s batch format v2 |
| KB layer, a new package | The generic mapping (entity, edge, and document tables with JSON payloads), view indexes and their queries, the batch reducer, tombstone and redirect rules, search and facet builders, the validation cache, export, and any graph cache |
| SQLite file | The serving store and the artifact handed to other tools |
| Plain SQLite | The default engine for one consolidating process |
| fsqlite | Publication of immutable generations and, in v2, accumulation from many writers |
| FalkorDB | An optional, rebuildable cache for Cypher exploration. Not part of the default path |

### Which Serving Store, and When

| Situation | Store |
| --- | --- |
| One consolidating process on a local disk, at any measured scale | Plain SQLite, built at a temporary path and renamed |
| Several consumers that pin versions, or a store on a shared or cloud path | fsqlite generations through the serialized lane, `DirectStore` today |
| Many independent writers adding facts between rebuilds | fsqlite v2 operation envelopes with a coalescing publisher. Until v2 exists, queue writers behind one consolidator |
| Small durable writes on one host with sub-second visibility | Plain SQLite in WAL mode, on the evidence of a probe |
| Multi-hop expansion through hubs as a product feature | An in-process adjacency cache built from the generation |

Through S2 a full rebuild from cached rows is the simplest correct consolidation: 17 to
18 s of SQLite time at 249,000 nodes (provisional), and about 1.5 minutes inferred at
1M.

### fsqlite v2: What to Implement First

Because no compatibility is owed, v2 can replace `f1.0` outright as a new format that
names its features in `required_features`, with one store class and no upgrade path.

The order below is inferred.
No spike measured these subsets alone: (i) and (g) ran only inside spike 3’s patch, with
the link commit (h) present, and (n) ran bundled with (k), (l), and (d).

1. **First release: derive at build, admission, and maintenance.** Implement derived
   objects (e) with a full `ANALYZE`, plan assertions, and FTS5 in the file; changeset
   admission from (n); and, if they separate from (h), gc against a pinned, verified
   generation (i) with envelope retention and a ledger floor (g).
   - Spike 1 confirmed (e) by itself, and (e) changes no publication rule.
   - Pinned gc as prototyped touches the publish path.
     Its safety rests on a floor that a publisher reads before linking and again after,
     and its 0 of 20 refusals were measured with the link commit and the lease in place.
     If (i) cannot be carved out, it moves to the phase that holds (h).
   - Collecting against the publish check narrows the recovery guarantee: between
     scrubs, the only fully verified recovery point may be older than every retained
     generation.
   - Ship (e) with (i), because the `f1.0` gc gets slower once it also checks FTS5.
2. **Second: accumulation.** Implement operation envelopes with a serial reducer (k),
   the coalescing publisher (d), and the tombstone and redirect facts with their
   closure. Only then enable the missing-row policy of (n). Alone,
   `missingDelete: 'ignore'` removes the `NOTFOUND` quarantine and leaves the dangling
   edges, 17 and 470 at S2-r2, so it turns a reported conflict into an unreported wrong
   state, which the state check marks known different.
   Add sparse capture (l) only with a helper that detects a missing hydration.
3. **Third: the commit.** Implement the link commit with an expirable lease (h) after a
   written model of its interleavings and a run on a shared filesystem.
4. **Fourth: measure before building.** Clone copies (a) on a reflink filesystem,
   generation manifests (m), a WAL live head (j), and migration steps (f) wait for a
   measurement.

The security review of the prototypes found gaps that the specification must close.
The [v2 design](spikes/softschema-kb/notes/fsqlite-v2-design.md) lists them under (e),
(g), (h), (k), and (n):

- **Lease takeover (h).** Identify a lock owner by boot id and pid namespace, with the
  process start time, not by hostname and pid.
  Let the holder’s recorded lease length decide expiry, not the waiter’s option.
  State for every step under the lease why it is safe with two holders.
  Bound the ledger floor against clock error.
- **Hooks and reducers (e) and (k).** Keep fsqlite’s own tables protected while derive
  hooks and reducers run, and audit the hooks with a session.
  Fail a build in which the ledger changed other than by fsqlite’s own insert, and open
  every connection through the defensive path.
- **Changeset admission (n).** Take table names from SQLite’s own parse, or decode a
  changeset exactly as SQLite does and reject over-long encodings.

These changes overlap work that the [roadmap](../roadmap.md) already lists before 1.0: a
pointer protocol that cannot move `current` backward, a shorter `DirectStore` critical
section, a durable envelope receipt, a ledger checkpoint, a writer seed that avoids the
full copy, a conflict policy bound to the schema, and caller-schema migration.
The v2 specification should say which of those items it replaces.

### Where the Generic KB Layer Lives

Put it in a separate package that runs on plain SQLite and uses fsqlite as an optional
publication backend.

- **fsqlite stays schema-agnostic.** That keeps its CLI operable without application
  code and the package small enough to audit, which are design constraints C11 and C12.
- **The same layer runs on both engines.** The control arm ran the spike’s DDL and SQL
  unchanged on plain SQLite.
- **The layer needs dependencies that fsqlite excludes.** A YAML reader and softschema
  are two.
- **Merge policy is knowledge-base policy.** Which node survives a merge and how origins
  are rewritten should not become storage rules.
- **Readers need no fsqlite code.** The export read each generation with Python’s
  standard `sqlite3`, so paraverse’s Python server can serve from the file.
  W3 was timed from Node only, so that client’s latency is unmeasured.
  With operation envelopes a producer in any language writes a file.
- **Batch admission belongs to the layer.** A batch names record paths, so the reducer
  and the exporter must reject a path that is absolute, has a `..` segment, or resolves
  outside the root.

### FalkorDB as an Optional Graph Cache

Do not keep FalkorDB in the default stack.

- **Latency gives no reason.** The hub neighborhood is a draw at best for the graph
  engine, 329 against 256 ms, and every other category favors SQLite (provisional).
- **If hub expansion becomes a requirement, try the adjacency cache first.** It needs no
  second server and no second copy of the payloads.
- **Keeping paraverse’s loader is defensible for ad hoc Cypher and stemmed search.**
  That holds while the corpus is small.
  Use it only as a full rebuild from the files, which did not show the suspected defect,
  and never as the system of record or the interchange artifact.

### Phased Plan

The phases follow the order above, which is inferred.

| Phase | Work | Depends on | Covers |
| --- | --- | --- | --- |
| 1 | Build the KB layer on plain SQLite with the generic mapping, the content-hash row cache, full rebuild and rename, and softschema annotations. Move paraverse’s browser queries to SQL | No fsqlite change | S2 measured, 1M inferred |
| 2 | fsqlite v2 first release: (e), admission from (n), and (i) with (g) if they separate from (h). Publish generations with search and statistics in the file | The v2 specification and the carve-out of (i) and (g) | Pinned versions and shared paths |
| 3 | fsqlite v2 accumulation: (k), (d), tombstone and redirect facts in the KB layer, and then the missing-row policy of (n) | Phase 2 | Many writers between rebuilds |
| 4 | The commit and the copy: (h), then (a), (m), (j), and (f) by measurement | An interleaving model and a reflink run | 1M with frequent publishes |

## Next Steps

- [ ] Replace the timings marked (provisional) when the quiet re-measurement lands.
  In the same pass, measure the resident file pages after W3, a FalkorDB scan over
  stored lower-case properties or a SQLite scan that lower-cases at query time, and W3
  from Python’s `sqlite3`.
- [ ] Close the gaps of the
  [state check](spikes/softschema-kb/harness/README.md#state-check): record row digests
  in the FalkorDB arm and in the fsqlite arm’s own one-writer run, compare entity rows
  with the reference and not only their count, and build reference states for p01 and
  for S2-r2 after p20.
- [ ] Write the fsqlite v2 implementation plan as a separate specification under
  [the project specs](../project/specs/), starting from the combined patch and its
  tests. It should fix the format marker, the semantics of collecting against a quick
  check, the head-by-listing rule, and the roadmap items it replaces.
  It should carry the security requirements for lease takeover, hook isolation, and
  changeset admission, and decide how a schema-agnostic CLI repairs a store that has
  derived objects and reducers.
- [ ] Carve (i) and (g) out of spike 3 without (h), and repeat its gc-refusal and
  import-store measurements.
  If the carve-out fails, schedule (i) with (h).
- [ ] Measure reflinks on APFS, XFS, or btrfs: a one-record publish at S2, the disk
  added per retained generation, and an S3 run of W1 and W2. The VM has no reflink
  filesystem.
- [ ] Settle tombstones for merges: how long a tombstone lives against the ledger floor,
  fact-keyed edge sets for changeset writers, a closure that removes only edges of
  absent nodes, and the 10 dangling edges that remained when a retry followed a build
  that had deleted their endpoints.
- [ ] Add crash and kill tests for operation envelopes, and enforce the stamped reducer
  version on open.
- [ ] Write the interleaving model for the link commit, and close the residual
  lock-break race.
- [ ] Time the combined prototype on a quiet machine at S2 scale: W1 with the derived
  build, the trickle and sustained runs that its harness does not carry, and the three
  kill points it did not run.
- [ ] Give the FalkorDB prototype the interleaved four-writer test, with an edge digest
  that the state check can compare.
- [ ] Run S3 on a machine with at least 64 GB of disk, and run W4 case 6 and W7.
- [ ] Measure git itself at S2 and S3: status, commit, and clone times and repository
  size, since the limit of files as the system of record is inferred.
  Prototype record batches as the system of record at S3.
- [ ] Propose the softschema annotations, versioned schema file names, and a canonical
  record serialization, and measure a cached or faster validation path against 8.9 ms
  per record.
- [ ] Reduce the suspected FalkorDB 4.18.3 defect to a small reproduction, and report it
  upstream, before any further incremental use.

### Later Comparisons on the Same Harness

A new backend joins the comparison by implementing the
[workload specification](spikes/softschema-kb/WORKLOAD.md), not by copying the first
implementations.

1. Add a directory beside the existing arms with a README that names its arms, stored
   content, versions, and configuration.
2. Read the corpora, the v2 delta batches, and the evolution variants that the
   [corpus generator](spikes/softschema-kb/corpus/README.md) writes.
3. Implement the 24 round-1 and 124 round-2 query instances and their conventions from
   the [harness](spikes/softschema-kb/harness/README.md).
   The oracle is the executable definition.
4. Write one result file per scale and workflow with the machine, versions, per-phase
   timings, and plans, and check every W3 file with the comparison tool against the
   expected results. After each batch, also record the count and digest of the stored
   node rows and edge multiset, and compare them with those that the
   [state check](spikes/softschema-kb/harness/README.md#state-check) holds for the
   reference applier’s output, because a W3 match alone can pass a wrong state.
5. Report parse separately, compare on ingest through durable, and report visible and
   durable times separately.
6. Rerun the plain SQLite control in the same session, because the numbers do not
   transfer between machines.

| Backend | What it would test |
| --- | --- |
| DuckDB with Parquet | Whether a columnar engine serves the scans behind SQLite’s slowest categories (substring search, facets, sorted pages over a whole kind), and whether Parquet can replace JSONL as the interchange and shard format. Check record lookups, small writes, and multi-hop joins |
| Kuzu or another embedded graph store | Whether an on-disk embedded graph engine gives the multi-hop advantage that FalkorDB did not, without a server and without holding the corpus in memory. Check its maintenance first: Kuzu’s repository was archived in October 2025, and forks continue it |
| Dolt | Whether a database can be the system of record and keep review, through row-level diff, branch, and merge. It tests accumulation and merging, not serving |
| Postgres | What a server buys: durable per-row writes from many clients, readers that never block, `jsonb` indexes, trigram search, and recursive queries. It is the baseline for hosted serving, and it gives up the single portable file |

## Methodology

The research combined source analysis, a written workload, measured arms, and
prototypes.

- **Source analysis.** Paraverse at commit `bb9a567`, the `universe2026-md` dataset at
  `a823679`, softschema 0.8.1, falkordblite 0.10.0, and fsqlite’s working tree were
  read, and the [paraverse analysis](spikes/softschema-kb/notes/paraverse-analysis.md)
  cites a source line for each claim.
- **Workload.** The [specification](spikes/softschema-kb/WORKLOAD.md) fixes the
  workflows, phases, stored content, and correctness rule.
  A second round added growing hubs, perturbed values, edge-changing updates, deletes,
  merges, and an invalid record.
- **Arms.** The [FalkorDB arm](spikes/softschema-kb/falkordb/README.md) runs paraverse’s
  own loader unmodified and a spike-only incremental path.
  The [fsqlite arm](spikes/softschema-kb/fsqlite/README.md) uses the public API and
  includes the plain SQLite control.
- **Correctness.** A pure-Python oracle computes every W3 result from the KB files, and
  a reference applier builds the KB that a batch produces.
  The comparison tool was rerun for this brief on the 60 W3 answer files in the
  repository: 55 match in full, 3 hold only the five recursive-path queries and match on
  those, and 2 are the deliberate no-closure ablations of spike 2. A matching file keeps
  its path answers and a digest of every other answer, and it records the hash of its
  expected file and the KB that the harness checked its paths against.
  The rerun compared the digests and the path lengths.
- **After a batch, a W3 match is necessary and not sufficient.** The
  [state check](spikes/softschema-kb/harness/README.md#state-check) builds the reference
  state with the applier for S1-r2 after p05 and p20 and for S2-r2 after p05, and
  compares each run’s recorded edge digest and entity count with it.
  Of the 22 W3 files taken after a batch, its
  [result file](spikes/softschema-kb/results/state-check.json) marks 12 verified, 6
  known different, and 4 unverified, which this brief calls W3-checked only.
  Of the 76 after-batch states that the runs recorded, it marks 58, 12, and 6. The six
  known-different files are:
  - spike 1 at S1-r2, four writers with the closure in the build: 235,469 edges against
    235,470, and 124 of 124 answers
    ([run](spikes/softschema-kb/results/fsqlite-v2/spike1/S1-r2/w2-inbuild-closure.json));
  - spike 2 at S1-r2, sparse changesets with idempotent deletes and no closure: 235,474
    against 235,470, and 124 of 124
    ([run](spikes/softschema-kb/results/fsqlite-v2/spike2/S1-r2/w2-sparse-missingdelete.json));
  - spike 2 at S1-r2, full-copy changesets with idempotent deletes and no closure:
    235,474 against 235,470, and 124 of 124
    ([run](spikes/softschema-kb/results/fsqlite-v2/spike2/S1-r2/w2-full-missingdelete.json));
  - spike 2 at S2-r2, operation envelopes with the reducer that keeps no facts and no
    closure: 1,204,889 edges on both sides with different rows, and 124 of 124
    ([run](spikes/softschema-kb/results/fsqlite-v2/spike2/S2-r2/w2-ops-naive.json));
  - the same configuration at S1-r2: 235,473 against 235,470, and 123 of 124
    ([run](spikes/softschema-kb/results/fsqlite-v2/spike2/S1-r2/w2-ops-naive.json));
  - spike 2 at S2-r2, sparse changesets with idempotent deletes and no closure:
    1,204,901 against 1,204,889, and 118 of 124
    ([run](spikes/softschema-kb/results/fsqlite-v2/spike2/S2-r2/w2-sparse-missingdelete.json)).
- **What each correctness claim rests on.** fsqlite states are compared by table digests
  with one writer that applies the batch in line order: entities, the edge multiset,
  documents, search text, quarantine, and in spike 2 the tombstone and redirect tables.
  The reference applier’s edge digest equals that one-writer digest in every run that
  recorded one, at all three reference states, so the applier and the fsqlite loader
  agree edge for edge, properties included.
  Entity rows are compared with the reference by count and with the one-writer state by
  digest, because the entity digest covers payloads and derived columns that the
  reference does not hold.
  FalkorDB’s incremental state is compared with a full rebuild, and its four-writer
  state with the incremental state, by per-kind and per-relation counts and by W3
  answers. That is a weaker check, because the runs recorded no rows.
  [The W2 findings](#incremental-accumulation-and-concurrent-writers-w2) list the mark
  of each after-batch state.
- **Prototypes.** Each [v2 spike](spikes/softschema-kb/fsqlite-v2/), and the combined
  prototype, is a pair of patches against scratch copies.
  Nothing under `packages/` changed.
- **Recomputation.** The tables here were recomputed from the result files, so some
  figures differ from the arm READMEs.
  W3 medians include each category’s hub instance, and W2 times exclude the batch parse
  for both arms.

The VM has 4 vCPUs, 16 GB of memory, and ext4, with FalkorDB 4.18.3 on Redis 8.6.2,
SQLite 3.53.4 in Node 22.23.4, and PyYAML 6.0.3. Each arm’s README lists its full
configuration.

Threats to validity:

- **One VM.** The numbers show relative sizing, not portable rates.
- **Contention.** The arms shared the VM, and the prototypes ran beside other jobs at a
  load average of 3 to 11. One parse took 43 s in one run and 71 s in another.
  Timings are marked (provisional) for this reason.
- **Few repetitions.** Many figures are single runs or medians of 2 or 3.
- **Synthetic corpora.** Every scale above S0 replicates S0. Round 1 keeps hub degree
  flat at 533 and repeats every value, so its graph and search results understate
  growth. Round 2 shares 61 software records, 25 organizations, and one taxonomy across
  replicas, and it perturbs sort values and the text of 30% of the main record kinds.
  Each replica still has S0’s event structure, and new batch records are copies of
  templates.
- **Unequal stored content.** The paraverse graph stores payloads only, and the SQLite
  arms also store document heads, bodies, opaque files, and export lines.
  Sizes and W5 results are not at equal content, and FalkorDB’s memory would grow if it
  stored the same.
- **FalkorDB as configured by paraverse.** The arm measures FalkorDBLite, not a tuned
  server deployment, with the client’s socket timeout disabled and no append-only file.
  The incremental path is spike code.
- **A suspected FalkorDB 4.18.3 defect, not yet isolated.** At S2-r2, the spike’s
  back-to-back write phases left Repository nodes that every later scan rejected.
  It was seen in one spike-written write sequence, at one scale, on one version.
  Reading every label between phases avoids it and adds about 0.7 s to each apply, which
  dominates the one-record and sustained figures at that scale.
  The S1-r2 run predates the workaround.
- **Planner hints.** The compared queries carry hints on both sides: anchored patterns
  in Cypher, and `INDEXED BY` and one unary plus in SQL. Unhinted plans are up to 3,000
  times slower and are stored per query.
- **Unequal concurrency tests and checks.** The FalkorDB run gave its four writers
  upserts only and applied every delete and merge in one process afterward, and the
  fsqlite runs interleaved them.
  FalkorDB’s final state was checked by counts and W3 answers, and fsqlite’s by row
  digests and by the state check.
- **After-batch correctness.** A W3 match after a batch is necessary and not sufficient.
  The state check has three reference states and none for p01 or for S2-r2 after p20,
  where a claim rests on the one-writer comparison.
  It compares entity rows with the reference by count only, and it has no rows for
  FalkorDB or for the fsqlite arm’s own one-writer run.
  It compares digests that the runs recorded, and it did not reopen their stores.
- **Different parsers and job counts.** W1 parses in one process in the FalkorDB arm and
  in 4 workers in the fsqlite arm, and no W1 run includes softschema validation.
- **Process boundaries and client runtime.** FalkorDB latencies include a socket round
  trip and a Python client, and SQLite latencies come from an in-process Node client.
  The shared path search, result shaping, and JSON decoding run in those runtimes.
  Paraverse’s server is Python, and W3 was not timed from Python’s `sqlite3`.
- **Search semantics and preparation.** The compared search is a substring match, which
  FalkorDB’s text index cannot answer, so its indexed search is reported and not
  compared. The two scans also differ: SQLite scans a table of fields lower-cased at
  load, and FalkorDB lower-cases three properties of every entity node at query time.
- **Serving memory.** The comparison of 0.17 GB with 1.3 GB counts FalkorDB’s data and
  leaves out SQLite’s file pages in the OS page cache, whose resident size was not
  measured.
- **Sustained-write load models.** The v2 figure is an offered load of 200 per second,
  all published. The `f1.0` figure is a saturated closed loop, and the FalkorDB figures
  are closed loops at other scales without durability.
  They are not three capacities.
- **Prototype coverage.** The three spikes timed their patches one at a time, their S2
  runs were limited by disk, and their baselines ran at other times under other load.
  The combined prototype checked answers and states at S1-r2 only and reported no
  timing.

## References

Spike documents, as primary evidence:

- [Workload specification](spikes/softschema-kb/WORKLOAD.md)
- [Paraverse analysis](spikes/softschema-kb/notes/paraverse-analysis.md): source
  analysis, workflow model, formats, and scratch probes
- [fsqlite v2 design](spikes/softschema-kb/notes/fsqlite-v2-design.md): cost model,
  candidate changes, target design, and probes
- [Corpus](spikes/softschema-kb/corpus/README.md) and
  [harness](spikes/softschema-kb/harness/README.md)
- [State check](spikes/softschema-kb/results/state-check.json): the row-level verdict of
  every after-batch state against the reference applier
- [FalkorDB arm](spikes/softschema-kb/falkordb/README.md) and
  [fsqlite arm](spikes/softschema-kb/fsqlite/README.md)
- v2 prototypes: [spike 1](spikes/softschema-kb/fsqlite-v2/spike1/README.md),
  [spike 2](spikes/softschema-kb/fsqlite-v2/spike2/README.md),
  [spike 3](spikes/softschema-kb/fsqlite-v2/spike3/README.md), and the
  [combined prototype](spikes/softschema-kb/fsqlite-v2/combined/README.md)

Repository documents:

- [fsqlite Design and Constraints](../fsqlite-design.md),
  [format specification](../fsql-format-spec.md), and [roadmap](../roadmap.md)
- [Schema Evolution and Workload Fit](research-2026-08-01-schema-evolution-and-workload-fit.md)

External sources:

- [jlevy/paraverse](https://github.com/jlevy/paraverse), source code
- [jlevy/universe2026-md](https://github.com/jlevy/universe2026-md), the S0 dataset and
  its build pipeline
- [jlevy/softschema](https://github.com/jlevy/softschema), source and specification
- [FalkorDB documentation](https://docs.falkordb.com), vendor documentation retrieved
  2026-11-17: design, concurrency, durability, upgrades, known limitations, and
  FalkorDBLite pages
- SQLite official documentation: [WAL](https://sqlite.org/wal.html),
  [sessions](https://sqlite.org/sessionintro.html),
  [FTS5](https://sqlite.org/fts5.html), and
  [network filesystems](https://sqlite.org/useovernet.html)
- [About large files on GitHub](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github),
  official documentation for the 100 MiB file limit
- [The Register on the archived Kuzu repository](https://www.theregister.com/2025/10/14/kuzudb_abandoned/),
  a news report

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
