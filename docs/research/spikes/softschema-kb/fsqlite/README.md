# Softschema KB Spike: the fsqlite Arm

This directory holds the fsqlite half of the storage spike that
[WORKLOAD.md](../WORKLOAD.md) specifies.
It imports a softschema knowledge base (KB) into fsqlite, serves the W3 queries from
`harness/queries.json`, applies incremental batches from concurrent writers, evolves the
schema, and exports the KB back to its original files.
It uses fsqlite only through its public API (`packages/fsqlite/src/index.ts`), runs its
TypeScript on Node with type stripping, and adds no npm dependencies.
Python, with the standard library and PyYAML, does the YAML work on both ends.

The code is temporary research code for the research brief
`docs/research/research-2026-11-17-softschema-kb-storage.md`. Numbers come from one
cloud VM (4 vCPUs, 16 GB RAM, ext4, Node 22.23.4, SQLite 3.53.4), so they show relative
sizing, not portable rates.

## How to Run

```bash
docs/research/spikes/softschema-kb/fsqlite/run.sh S0   # then S1, S2
python3 docs/research/spikes/softschema-kb/fsqlite/summary.py S0 S1 S2
python3 docs/research/spikes/softschema-kb/harness/compare.py \
  docs/research/spikes/softschema-kb/harness/expected/S1/w3.json \
  docs/research/spikes/softschema-kb/results/fsqlite/S1/w3.json
```

`run.sh` writes `results/fsqlite/<scale>/*.json` and keeps working stores under
`$KB_SCRATCH/fsqlite-spike/<scale>/`. Synthetic corpora, W2 deltas, and W4 variants come
from the shared `kb-corpora/` that `corpus/` generates.
Python steps run as
`uv run --no-project --with pyyaml --exclude-newer 2026-11-03 python ...`.

## Files

| File | Role |
| --- | --- |
| `parse_kb.py` | Python pass: KB, delta batch (`--delta`), or KB diff (`--diff`) to intermediate JSONL |
| `mapping.ts` | Generic mapping (a): DDL from table views, derived fields, the streaming loader |
| `typed.ts` | Typed mapping (b): per-kind tables generated from the compiled schemas |
| `load.ts` | W1 import through DirectStore or SnapshotStore, with per-phase timings |
| `w1.ts` | W1 orchestration: parse and import as separate measured processes, gc, FTS sidecar |
| `control.ts` | Plain SQLite control arm (C15) for W1 and W3, with the same DDL and SQL |
| `queries.ts` | Every W3 query, plus statement tracing for `EXPLAIN QUERY PLAN` |
| `w3.ts` | W3 runner: cold then warm runs, plans, optional per-query timeout |
| `plans.ts` | Plan audit for the table queries (C7): planner choice against `INDEXED BY` |
| `fts.ts` | FTS5 trigram search sidecar, a rebuildable projection outside the store |
| `w2.ts`, `w2_worker.ts` | W2: 4 writer processes and a W3 reader per delta batch, then reconcile |
| `trickle.ts` | W2 trickle (C18): 1, 10, 100 records, and a sustained run |
| `conflict.ts` | W2 conflicting writes (C20) under each conflict policy |
| `w4.ts`, `migrate.ts` | W4 on the shared evolve variants; side-by-side copy for DDL changes |
| `export_kb.py`, `w5.ts` | W5 export with Python `sqlite3`, fidelity check, reload into W3 |
| `w6.ts` | W6 operations: artifacts, standard tools, start-up, memory, crash tests |
| `common.ts`, `fsq.ts`, `measure.py` | Shared helpers, the fsqlite import, wall time and peak RSS |
| `summary.py`, `run.sh` | Headline tables, and the per-scale run order |

## Mapping Design

The arm uses mapping (a), a generic and schema-driven layout, for every workflow.
Mapping (b), typed tables, is built in W4 for comparison.

| Table | Primary key | Holds |
| --- | --- | --- |
| `entity` | `id` | `kind`, export `name`, display `label`, `path`, `payload` (JSON text as parsed), `derived` (JSON) |
| `edge` | `(source, relation, target, ord)` | Edge attributes as JSON; `ord` numbers parallel edges in file order |
| `search_text` | `(id, rank)` | Lowercased display name (rank 0), `payload.title` (1), `payload.bio` (2) |
| `doc` | `path` | Frontmatter keys in order with the owner’s payload nulled, Markdown body |
| `kind_schema` | `kind` | Compiled schema JSON and the browser’s field descriptions |
| `kb_file`, `kb_line` | `path`, `(path, n)` | Opaque files and the lines of opaque `.jsonl` files |

- **Constant DDL.** A new kind or field needs no DDL, because both live in JSON. The DDL
  depends only on the UI’s table views.
  Each view (kind, equality filter, sort) becomes one partial expression index
  `(filter, sort, id) WHERE kind = '<kind>'`. The page is an ordered range scan of that
  index, and its total is an index count.
- **Derived fields.** `derived` holds what paraverse promotes to FalkorDB properties: a
  session’s `start_epoch` and a `start_key` that sorts missing values last.
  `label` follows paraverse’s `readable_name`. Payloads are never rewritten, so export
  stays exact.
- **No foreign keys, triggers, virtual tables, or `ON CONFLICT` clauses.** Every table
  has a non-null primary key, so both store types accept the schema.
  Foreign keys from `edge` to `entity` were left out on purpose: SnapshotStore checks
  them at each envelope boundary, so an edge to a record another writer adds in the same
  reconcile would quarantine by envelope order.
- **Indexes.** `(kind, label, id)`, a covering `(id, kind)` for joins that only need a
  kind, `path`, the view indexes, and `edge (target, relation, source)` and
  `(relation, target, source)` beside the primary key.
- **Graph queries.** Neighborhoods are one recursive CTE. Paths use the application-side
  bidirectional breadth-first search that both arms share, one SQL statement per
  frontier; the in-engine recursive CTE is reported separately with a timeout.

### Search and FTS5

`node:sqlite` in Node 22.23.4 has FTS5 (`ENABLE_FTS5`, and the trigram tokenizer works).
fsqlite rejects a virtual table in a store schema, for DirectStore and SnapshotStore
alike, with
`FsqliteError [incompatible]: table "f" has no primary key; fsqlite requires a NON-NULL primary key`.
The check is `validatePrimaryKeys` in `packages/fsqlite/src/snapshotStore.ts` (lines 298
to 346), which `init()` calls at line 691; DirectStore inherits it through
`DirectStrategyStore` (`directStore.ts`, line 56). A write callback also cannot create a
TEMP virtual table (`refused`: “application callback changed the SQLite temporary
schema”), but a read connection can.

So the arm reports two search figures: the canonical substring scan of `search_text`,
which lives in the store and changes with every envelope, and an FTS5 trigram sidecar
(`fts.ts`), an ordinary SQLite file built from the published head and attached
read-only. The sidecar must be rebuilt for every published version; W1 and W2 count that
rebuild.
A trigram phrase `MATCH` returns the same rows as the substring oracle for these
terms. The first sidecar query used `LIKE ... ESCAPE`, which bypasses the trigram index
and was no faster than the scan; `MATCH` fixed it.

## Results

All W3 results match `harness/expected/<scale>/w3.json` at S0, S1 and S2 (24 of 24
queries, `compare.py` with `--kb` path validation), for the canonical arm, the FTS5
sidecar variant, and the plain SQLite control.
S3 was not run; see [S3 Feasibility](#s3-feasibility).
Each workflow’s raw numbers, plans, and configuration are in
`results/fsqlite/<scale>/*.json`. The VM was shared with the FalkorDB arm, so CPU
contention moved some figures between runs: the S2 parse took 43 s in one run and 71 s
in the reported one.

### W1 Full Rebuild

| Scale | Parse s (4 jobs) | DirectStore ingest to durable s | SnapshotStore ingest to durable s | Plain SQLite ingest to durable s | Peak RSS MiB (parse / import) | Snapshot MiB | FTS sidecar s / MiB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S0 | 1.2 | 0.6 | 1.0 | 0.3 | 42 / 169 | 37 | 0.1 / 5 |
| S1 | 8.0 | 4.1 | 8.1 | 3.0 | 166 / 439 | 335 | 0.7 / 31 |
| S2 | 71.4 | 19.1 | 44.1 | 16.6 | 630 / 494 | 1,717 | 3.5 / 141 |

- **Phases** (C11). Parse is reported once, with its job count; softschema validation is
  not run, as in paraverse’s default load.
  The Node import splits into decode (JSON of the intermediate rows), transform (labels,
  promoted fields, search text), ingest (inserts with index maintenance), verify (counts
  against `stats.json`), and publish.
  At S2, DirectStore spends 2.4 s decoding, 1.4 s transforming, 10.8 s ingesting, 0.1 s
  verifying, and 3.0 s publishing (COMMIT, `quick_check`, `foreign_key_check`, fsync,
  link, pointer swap; a warm `quick_check` alone is 1.1 s). “Ingest to durable” in the
  table excludes decode, so it compares with other backends.
- **fsqlite against plain SQLite** (C15). With the same DDL and loader, plain SQLite
  with indexes declared first takes 16.6 s at S2 and DirectStore 17.9 s, so the protocol
  costs about 8%, mostly the publish check and fsync.
  Plain SQLite with indexes built after the load takes 14.0 s. fsqlite cannot use that
  order, because the DDL is fixed at `init()` and a callback may not create an index, so
  its index order costs about 19% more.
- **SnapshotStore is the slower import route.** At S2 its captures (20,000 rows each)
  add 7.3 s of head copies and changeset work, and the one reconcile takes 23.9 s:
  applying changesets is slower than inserting.
  Its store also keeps every applied envelope in `tx/applied`: 3.0 GB at S2 against a
  1.8 GB head, because gc never prunes the archive.
- **gc** (C17). `gc({ retain: 0 })` after the import removes the empty snapshot 0 and
  takes 3.5 s at S2, because a collecting gc runs the full integrity check of the head.
- **Size.** The snapshot is 1.56 to 1.59 times the KB’s file bytes at every scale (1.68
  GiB at S2 for 1.06 GiB of files), since it also holds documents, bodies, search text
  and indexes so that export is exact.
  The FTS5 sidecar adds 141 MiB and 3.5 s at S2.

### W3 Queries

Warm p50 and p95 in milliseconds over 50 runs, after one cold run on a new connection
with the snapshot evicted from the OS page cache.
Cold runs and every statement’s `EXPLAIN QUERY PLAN` are in the result files.

| Query | S0 p50 (p95) | S1 p50 (p95) | S2 p50 (p95) |
| --- | --- | --- | --- |
| table.sessions_by_start.p1 | 0.0991 (0.245) | 0.142 (0.184) | 0.564 (0.748) |
| table.sessions_by_start.p3 | 0.0676 (0.155) | 0.135 (0.188) | 0.564 (0.725) |
| table.people_by_org.p1 | 0.354 (0.448) | 0.252 (0.292) | 0.28 (0.44) |
| table.people_by_org.p3 | 0.214 (0.241) | 0.268 (0.321) | 0.3 (0.465) |
| table.repos_by_stars.p1 | 0.0451 (0.0748) | 0.072 (0.101) | 0.212 (0.296) |
| table.repos_by_stars.p3 | 0.0475 (0.0668) | 0.0744 (0.0946) | 0.211 (0.273) |
| record.person | 0.114 (0.215) | 0.112 (0.259) | 0.108 (0.269) |
| record.session | 0.0637 (0.103) | 0.0646 (0.101) | 0.0642 (0.144) |
| record.organization | 0.0565 (0.104) | 0.0559 (0.0979) | 0.0551 (0.122) |
| record.repository | 0.0761 (0.121) | 0.0797 (0.134) | 0.0788 (0.245) |
| search.copilot | 1.39 (2.55) | 9.28 (9.61) | 52.1 (58.6) |
| search.kubernetes | 1.11 (1.24) | 7.76 (8.04) | 44 (51) |
| search.supply_chain | 1.41 (1.61) | 8.76 (17) | 46.5 (57.2) |
| search.accessibility | 1.47 (2.21) | 8.92 (9.34) | 46.3 (55.9) |
| path.person_person_2 | 0.141 (0.384) | 0.25 (0.352) | 0.149 (0.406) |
| path.person_org_3 | 0.247 (3.27) | 0.447 (3.84) | 0.28 (0.499) |
| path.person_repo_3 | 2 (2.7) | 2.13 (3.23) | 2.76 (3.43) |
| path.person_person_4 | 2.6 (11.2) | 2.62 (3.2) | 2.98 (3.63) |
| path.unreachable | 2.22 (7.1) | 1.85 (2.24) | 2.04 (4) |
| facet.sessions_per_topic | 0.675 (1.31) | 6.76 (6.95) | 36.9 (41.7) |
| facet.people_per_org | 0.508 (0.597) | 4.3 (4.41) | 22.1 (25.6) |
| neighborhood.person | 0.816 (0.999) | 0.944 (1.04) | 1.15 (1.75) |
| neighborhood.session | 1.44 (1.72) | 1.6 (1.7) | 1.76 (1.84) |
| neighborhood.organization | 0.292 (0.345) | 0.309 (0.37) | 0.341 (0.483) |
| search.copilot (search via FTS5 sidecar) | 0.386 (0.45) | 3.21 (3.58) | 17.9 (26.6) |
| search.kubernetes (search via FTS5 sidecar) | 0.106 (0.148) | 0.53 (0.585) | 2.27 (2.33) |
| search.supply_chain (search via FTS5 sidecar) | 0.151 (0.22) | 0.794 (0.884) | 3.34 (4.26) |
| search.accessibility (search via FTS5 sidecar) | 0.19 (0.296) | 0.966 (1.02) | 4.42 (6.77) |
| path.person_person_2 (path via recursive CTE) | 63 (65.7) | 126 (144) | 229 (241) |
| path.person_org_3 (path via recursive CTE) | 77.4 (80.1) | 245 (255) | 412 (453) |
| path.person_repo_3 (path via recursive CTE) | 66.8 (71.8) | 135 (159) | 210 (258) |
| path.person_person_4 (path via recursive CTE) | 19.6 (21) | 47.5 (51.5) | 66.7 (79.2) |
| path.unreachable (path via recursive CTE) | 19.8 (33.2) | 47.3 (49.7) | 73.1 (104) |

- **Reads are SQLite reads.** Against the plain SQLite control the median p50 ratio is
  1.03, 1.00, and 0.99 at S0, S1 and S2: once a reader holds a connection to a published
  snapshot, fsqlite adds nothing.
  A per-request `store.read()`, which opens and verifies the snapshot, costs about 0.4
  to 0.7 ms extra.
- **Graph queries stay flat** because the synthetic corpora do not grow their hubs (C8):
  record, path and neighborhood do the same work at every scale.
  Search and facets scan and grow linearly.
- **Paths** (C5). The application-side bidirectional BFS, shared with the FalkorDB arm,
  takes 0.15 to 3.0 ms at S2. The in-engine recursive CTE takes 66 to 412 ms warm (1.9 s
  cold) at S2 and never hit the 60 s timeout.
- **Search** (C4). The substring scan grows to 44 to 52 ms at S2. The FTS5 trigram
  sidecar answers in 2.3 to 18 ms; `copilot` is slowest because it matches 11,178
  entities, all of which the total count must visit.
- **Plans** (C7, `w3-plans.json`). Both view queries use their partial expression index
  for the ordered page without `INDEXED BY` (no temporary B-tree), at every scale.
  The people-by-organization page regressed when the covering `(id, kind)` index was
  added: with no `ANALYZE` statistics, SQLite joined through the `(kind, label)` index
  and scanned every person per member, 161 to 224 ms at S2. A unary plus on `e.kind`
  restores the id lookup: 0.15 ms at S2, against 0.7 to 2.1 ms for the original `IN`
  subquery form. `ANALYZE` would also work: it is accepted inside a DirectStore write
  (fsqlite’s schema fingerprint skips `sqlite_*` tables), but a SnapshotStore envelope
  cannot carry it, since `sqlite_stat1` has no primary key and the capture comes back
  empty.

### W2 Incremental Accumulation

Each batch starts from a hard-linked clone of the W1 store: 4 writer processes split the
shared `deltas/pNN` batch into 5 envelopes each while a reader process loops over the W3
queries, then one reconcile publishes and the FTS5 sidecar is rebuilt.
“Visible after” runs from spawning the writers to the reader serving the new head.

| Scale | Batch | Arm | Visible after ms | Capture p50 ms | Reconcile ms | Sidecar rebuild ms | Reader p95 ms during | Reader errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S0 | p01 (54 records) | SnapshotStore | 1601 | 80.1 | 180.2 | 97 | 13.9 | 0 |
| S0 | p05 (270 records) | SnapshotStore | 1609 | 83.7 | 135.2 | 128 | 7.3 | 0 |
| S0 | p20 (1081 records) | SnapshotStore | 2628 | 193.6 | 377.0 | 162 | 5.6 | 0 |
| S0 | p01 (54 records) | DirectStore | 5438 | 170.3 | n/a | 86 | 4.5 | 0 |
| S0 | p05 (270 records) | DirectStore | 4245 | 104.8 | n/a | 262 | 4.1 | 0 |
| S0 | p20 (1081 records) | DirectStore | 5134 | 134.2 | n/a | 124 | 3.7 | 0 |
| S1 | p01 (487 records) | SnapshotStore | 9374 | 1,705.3 | 469.5 | 789 | 9.9 | 0 |
| S1 | p05 (2433 records) | SnapshotStore | 8381 | 1,156.4 | 1,051.6 | 808 | 10.8 | 0 |
| S1 | p20 (9733 records) | SnapshotStore | 8987 | 1,289.6 | 2,254.4 | 887 | 10.9 | 0 |
| S1 | p01 (487 records) | DirectStore | 41972 | 1,111.7 | n/a | 1,164 | 32.9 | 0 |
| S1 | p05 (2433 records) | DirectStore | 30432 | 748.4 | n/a | 754 | 16.9 | 0 |
| S1 | p20 (9733 records) | DirectStore | 25899 | 758.0 | n/a | 834 | 11.4 | 0 |
| S2 | p01 (2487 records) | SnapshotStore | 54724 | 10,195.5 | 3,439.0 | 3,723 | 59.5 | 0 |
| S2 | p05 (12436 records) | SnapshotStore | 58933 | 7,401.5 | 6,494.5 | 3,940 | 60.8 | 0 |
| S2 | p20 (49744 records) | SnapshotStore | 52144 | 4,813.1 | 13,570.9 | 4,418 | 61.1 | 0 |

- **Every batch was applied correctly**: all new entities appear, every updated record
  differs from the base (for example 9,949 of 9,949 at S2 p20), and the reader saw no
  errors in about 3,700 to 4,300 queries per S2 batch.
- **The head copy is the floor.** Every capture copies the published head (1.8 GB at S2;
  0.8 to 1.3 s alone), and 4 concurrent captures need 4 head-sized working copies, so
  visibility at S2 is 52 to 59 s whatever the batch size.
  Reconcile grows with the batch (3.4 s to 13.6 s at S2). Indexed search lags by the
  sidecar rebuild (3.7 to 4.4 s at S2).
- **Reader latency during writes** rises at S2 (p95 about 60 ms, mostly search and
  facets competing for I/O), with p50 unchanged at about 1.2 ms.
- **DirectStore** serializes the 20 writes, and each publishes a full generation, so at
  S1 visibility of the whole batch takes 26 to 42 s. Its writers collect old generations
  after each write, but under contention a collecting gc keeps refusing, retryably,
  because a peer moves `current` during its full integrity check (6 to 8 of 20 attempts
  gave up at S1). Without that gc, disk grows by one head per write; the variant was not
  run at S2.

#### Trickle Writes (C18)

| Scale | 1 record ms (Snapshot / Direct) | 10 records ms | 100 records ms | Sustained records/s | Visibility p50 / p95 ms |
| --- | --- | --- | --- | --- | --- |
| S0 | 106 / 71 | 115 / 71 | 102 / 77 | 15.57 | 287 / 448 |
| S1 | 621 / 494 | 642 / 498 | 662 / 529 | 2.63 | 2015 / 3334 |
| S2 | 2750 / 2612 | 3688 / 2386 | 3005 / 2420 | 0.6 | 16498 / 22147 |

A single record costs as much as a hundred, because the head copy, the reconcile build,
and the publish fsync dominate.
At S2 a one-record publish takes about 2.6 to 2.8 s, the sidecar rebuild another 3.7 s,
and `gc({ retain: 0 })` 4.3 s. The sustained run (one writer capturing one-record
envelopes, one reconciler looping reconcile and gc) reaches 15.6 records per second at
S0, 2.6 at S1, and 0.6 at S2, with a median visibility delay of 0.3 s, 2.0 s, and 16.5
s.

#### Conflicting Writes (C20)

Two writers capture from the same head and set the same person’s `bio` to different
values. Envelopes apply in byte-sorted transaction-ID order, which starts with a
millisecond timestamp.

| Policy | Published value | Envelope outcome | Losing value recoverable |
| --- | --- | --- | --- |
| `lww` | the later writer’s | both applied | yes, from its envelope in `tx/applied` |
| `union` | the earlier writer’s | both applied, the later change omitted | yes, from `tx/applied` |
| `strict` | the earlier writer’s | the later envelope quarantined | yes, from `tx/quarantine` |

The result is the same at S0, S1, and S2. Recovery replays the kept changeset onto a
copy of the base snapshot with `node:sqlite`’s `applyChangeset`, and each manifest names
its writer. That recoverability depends on fsqlite never pruning `tx/applied`, which is
also why the archive grows without bound.

### W4 Schema Evolution

The inputs are the shared variants in `kb-corpora/<scale>/evolve/`. Under the generic
mapping, `parse_kb.py --diff` turns each variant into rows (changed files by inode and
bytes, and a row-level graph diff), one SnapshotStore envelope carries them, and
reconcile publishes.
At S0 and S1 a full rebuild of each variant produced identical table digests.

| Case | Generic mapping (a) | S0 s | S1 s | S2 s | Rebuild of the variant, S1 s | Typed mapping (b) |
| --- | --- | --- | --- | --- | --- | --- |
| New kind (`award`) | data only | 0.6 | 4.1 | 24.2 | 11.3 | new table: new store |
| Optional field (`recording_url`) | data only | 0.6 | 5.2 | 26.0 | 11.2 | `ALTER TABLE ADD COLUMN`: new store |
| Rename relation (`presents` to `speaks_at`) | data only | 0.7 | 4.0 | 24.2 | 11.7 | data only while edges stay generic |
| String to object (`primary_language`) | data only, plus a new store for the view index | 0.8 | 6.9 | 34.7 | 11.4 | new column type: new store |

Times are the diff plus capture plus reconcile.
At S2 the diff (17 to 27 s) dominates, because it reads both 1.1 M-row edge files; the
envelope and reconcile take 4.7 to 7.3 s.

- **No in-place DDL.** `CREATE INDEX` inside `SnapshotStore.write` and `ALTER TABLE`
  inside `DirectStore.write` are both refused (`refused`: “application callback changed
  the SQLite schema”). Opening the store with changed DDL is `incompatible` (stamped
  `schema_hash` mismatch), even at the same `schemaVersion`.
- **Side-by-side copy.** A DDL change initializes a new store and streams every row from
  the old snapshot through one `DirectStore.write` (`migrate.ts`; `ATTACH` is impossible
  inside the callback’s transaction).
  The string-to-object case’s index change took 0.4 s at S0, 3.2 s at S1, and 16.8 s at
  S2, and the new view’s query uses the new index.
  The typed mapping’s added column took 0.3, 1.8, and 8.8 s. Both produce a new
  `store_id`; switching readers is the application’s cutover.
- **Typed tables are smaller** for the same records and edges (816 MiB against 1,070 MiB
  at S2), since column names are not repeated in every payload, but every schema change
  becomes a new store, and the generic store’s documents, bodies and search text would
  still be needed for export.

### W5 Export Round Trip

Python’s standard `sqlite3` reads the published snapshot (`mode=ro&immutable=1`, no
fsqlite code) and writes the KB back with the pipeline’s YAML style.

| Scale | Files | Byte-identical | Parsed-equal | Export s | Reload into W3 |
| --- | --- | --- | --- | --- | --- |
| S0 | 5,001 | 5,000 | 5,001 | 3.4 | 24 of 24 equal |
| S1 | 44,801 | 44,798 | 44,799, plus 2 equal as row sets | 74 | 24 of 24 equal |
| S2 | 228,876 | 228,873 | 228,874, plus 2 equal as row sets | 145 | 24 of 24 equal |

- Every record artifact, Markdown body (including `\r\n` inside bodies), opaque file,
  and the `_search` file are byte-identical at every scale.
- `_schemas/profile.schema.yaml` differs by one quoting choice in one description: the
  schema compiler wrote `"...person's..."` where PyYAML writes `'...person''s...'`.
- The synthetic corpora write `_graph/nodes.jsonl` and `edges.jsonl` replica by replica;
  the export writes key order.
  The rows are equal as sets; keeping the original order would need a sequence column.
- Export time includes the comparison; at S2 its peak RSS is 3.2 GiB, from parsing both
  edge files.

### W6 Operations

- **Artifacts.** A collected DirectStore store is 3 files: `fsqlite.json`, `current`,
  and one snapshot (1.8 GB at S2). `validate()` takes 0.05, 0.7 and 3.4 s at S0, S1 and
  S2.
- **Standard tools.** Python `sqlite3` opens the snapshot directly, `quick_check` is
  `ok`, and `application_id` is `0x4653514C`. The `sqlite3` CLI is not installed on this
  VM. `fsqlite stats` reads the snapshot as a plain SQLite file.
- **Serving start-up.** A fresh process imports the code in 70 to 90 ms, opens the store
  with a read lease in 6 to 9 ms, and answers the first record query in 1 ms.
- **Memory at rest** (C12). The serving process’s RSS is 101, 117 and 161 MiB at S0, S1
  and S2 after all W3 queries, with a 64 MiB page cache; the file’s pages otherwise live
  in the OS page cache, so fsqlite has no separate “in-memory size”.
- **Crash tests** (C25), at S0 and S1, each with SIGKILL:

| Kill point | State found | Recovery | S1 recovery |
| --- | --- | --- | --- |
| DirectStore build, holding the lock | `in-flight-capture`; lock and `.direct-*` left | repair refuses until the operator removes `publish.lock`; repair; rerun the import | 5 ms, then a 5.0 s rerun |
| SnapshotStore capture | `in-flight-capture`; one `.work-*` file | repair removes it; reconcile publishes the 2 complete envelopes; the importer must resume the rest | 4 ms |
| Reconcile build, before the lock | `in-flight-capture`; one `.build-*` | repair; reconcile applies all 366 envelopes once | 9 ms, then 4.3 s |
| Publication, holding the lock | `in-flight-capture`; lock and `.build-*` | manual lock removal; repair; reconcile publishes all 366 exactly once | 286 ms, then 3.7 s |

Each kill hit its window on the first attempt.
The head was never damaged, and no envelope was applied twice.
The lock never expires on age, so every lock-holding crash needs the documented offline
step: confirm that no client can resume, then remove `publish.lock`.

### S3 Feasibility

S3 (1,000,295 nodes, 4.68 M edges, 920,375 record files) was not run.
The snapshot grows by about 37 MiB per S0 replica, so one retained S3 version is about
6.7 GiB. A DirectStore W1 with the intermediate rows needs about 11.8 GiB, a
SnapshotStore import about 13.5 GiB with its archived envelopes, and W2’s four
concurrent working copies plus the head about 34 GiB. About 14 GiB were free, shared
with the FalkorDB arm, so the run would have filled the disk
(`results/fsqlite/S3/feasibility.json`).

## Configuration

| Setting | Value |
| --- | --- |
| Node, SQLite | v22.23.4, 3.53.4 (Python `sqlite3` 3.53.1 for export) |
| Page size, journal | 4,096 bytes; rollback journal (`DELETE`), never WAL |
| Import cache | `PRAGMA cache_size = -262144` (256 MiB) inside the write callback |
| Reader | `cache_size = -65536` (64 MiB), `temp_store = MEMORY`, no mmap |
| Synchronous | DirectStore builds `FULL`; SnapshotStore working copies and builds `OFF` until the publish fsync |
| Lock options | imports and reconciles `timeoutMs` 600,001, `staleMs` 600,000; elsewhere the defaults (30 s, 20 s) |
| gc retention | `retain: 0` after W1, after every trickle publish, and after each DirectStore W2 write |
| Conflict policy | `lww` on every table, except the C20 test |
| Parse | PyYAML 6.0.3 `CSafeLoader`, 4 worker processes, `--exclude-newer 2026-11-03` |

## Surprises

1. FTS5 works in `node:sqlite`, but no store schema may contain a virtual table, so
   indexed search is a sidecar that must be rebuilt for every published version.
2. Without `ANALYZE` statistics, adding one covering index made an unrelated page query
   1,000 times slower at S2, until a unary-plus hint fixed it.
   `ANALYZE` is possible in DirectStore but cannot travel in a SnapshotStore envelope.
3. A collecting gc starves under concurrent DirectStore writers, because its full
   integrity check outlasts the interval between peers’ publications.
4. The head copy makes a one-record write as costly as a 100-record one: 2.6 s at S2.
5. SnapshotStore archives every envelope forever: good for recovering conflicting
   values, but its import store at S2 is 1.7 times the head.
6. fsqlite fixes index creation at `init()`, so a bulk load cannot defer its indexes.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
