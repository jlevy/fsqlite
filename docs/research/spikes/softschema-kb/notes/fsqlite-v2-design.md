# fsqlite v2 for an Accumulating Softschema Knowledge Base

**Status:** working notes from the research agents, kept as inputs to
`docs/research/research-2026-11-17-softschema-kb-storage.md`. Paths written `<scratch>/`
refer to the session’s scratch directory and are not in the repository.

**Date:** 2026-11-17

**Status:** Design analysis for the maintainer.
It is input for the Recommendations section of
`docs/research/research-2026-11-17-softschema-kb-storage.md`. Nothing in it is
implemented in the repository.

## How to Read This Document

The maintainer’s framing is that fsqlite is new, so the `f1.0` format, the store layout,
the public API, and the CLI may all change.
This document designs for the workload in
`docs/research/spikes/softschema-kb/WORKLOAD.md` and keeps four guarantees fixed: atomic
publication on local and shared or cloud paths, immutable generations that standard
SQLite tools can read, multi-writer capture without a server, and validate and repair.

Every quantitative statement has one of three bases:

- **Verified:** it cites a source line or a result file, and the citation was checked in
  the working tree of 2026-11-17.
- **Measured:** it cites a probe in Appendix A, which gives the command and the output
  file. The probes ran on the spike VM (4 vCPUs, 16 GB RAM, ext4 mounted with `discard`,
  Node 22.23.4, SQLite 3.53.4) while round-2 benchmark jobs used one to four cores.
  They show sizes and ratios, not portable rates.
  A range covers a probe’s repetitions and, where it ran twice, both runs.
- **Inferred:** it is derived from measured numbers or from the design, and says so.
  Each inference needs a spike before the brief states it as a finding.

Citation prefixes:

| Prefix | Path |
| --- | --- |
| `src/` | `packages/fsqlite/src/` |
| `spike/` | `docs/research/spikes/softschema-kb/` |
| `results/` | `docs/research/spikes/softschema-kb/results/fsqlite/` |
| `fdb/` | `docs/research/spikes/softschema-kb/results/falkordb/` |
| spec, design | `docs/fsql-format-spec.md`, `docs/fsqlite-design.md` |

H is the size of the published head: 36.8 MiB at S0, 334.5 MiB at S1, 1,717 MiB at S2,
and 1,856 MiB at S2-r2. A generation is one published, complete SQLite file, which
`f1.0` calls a snapshot.

## Summary

Every `f1.0` publish handles the whole head at least three times: a copy, a flush, and a
`quick_check`. The measured loops add a search sidecar rebuild and a full integrity
check inside gc. At S2 that is about 6 ms per MiB of head per publish, of which the row
work for one record is under 0.04%. Concurrent capture multiplies the copy: four writers
are 4.7 to 10.2 times slower than one writer at S2-r2, and their row-level merge needs
two application repair passes to reach the one-writer state.

The changes, ranked by impact against risk to the four guarantees:

| Rank | Change | What it removes | Risk |
| --- | --- | --- | --- |
| 1 | (e) Derived objects, statistics, and closure rules built inside each generation | The sidecar (3.5 to 4.4 s and 141 to 164 MiB per publish at S2), the new store for an index change (16.8 s), the 5.4 s unhinted hub join, dangling edges | Low |
| 2 | (i) and (g) gc against a verified generation, retention, a ledger floor | gc refusals (6 to 11 of 20), most of the 64% gc share of the trickle round, the archive (0.65 H) | Low; the ledger floor needs care |
| 3 | (a) Clone-based copies | The copy and most of the flush where the filesystem has reflinks; nothing on ext4 | Low |
| 4 | (n) Conflict policy completion: idempotent deletes, declared cascades, changeset admission | `NOTFOUND` quarantines (1 to 3 of 20 envelopes), silently skipped tables | Low |
| 5 | (k) Operation envelopes applied by a serial reducer | The capture copy on every filesystem, the stale-base quarantines, and their retry publishes | Medium |
| 6 | (l) Sparse-seed changeset capture | The capture copy: 1.09 s to 1.4 ms for one record at S2 | Medium |
| 7 | (d) Coalesced, adaptive publish cadence | Per-record publishes | None |
| 8 | (h) Commit by no-replace link, with an expirable lease | Manual lock recovery, readers waiting on publishers | Medium |
| 9 | (f) Migration steps at generation build | The new store for a typed-column change (8.8 s) | Medium |
| 10 | (m) Generation manifests with deferred materialization, and (j) a WAL live head as its local form | The remaining O(H) publish on filesystems without reflinks | Medium to high |
| 11 | (c) Base plus delta as attached overlays, (b) shards | Not recommended: reads become 2.5 to 133 times slower | High |

The recommended v2 keeps one complete, immutable SQLite file per generation and changes
what happens around it:

- Envelopes carry only base facts, as operations or as changesets captured without a
  head copy. Everything cross-row is derived inside the generation build by declared,
  deterministic hooks: secondary indexes, FTS5, statistics, summaries, and closure
  rules.
- Publication commits by a no-replace link of the next generation name, so the lock
  becomes an expirable lease and a crashed holder needs no manual step.
- Maintenance verifies a pinned generation once, records it, retains applied envelopes
  until a later verified generation covers them, and bounds the ledger with a floor.
- The copy is a clone where the filesystem supports one, and publishes are coalesced
  where it does not.
- A generic entity, edge, and knowledge-base layer belongs in a separate package built
  on fsqlite.

The prototype plan has four spikes: derive at build, cheap capture with serial apply,
maintenance and publication, and O(changed pages) publication.
Section 4 gives each a falsifiable hypothesis, the measurement, and the code locations.

## 1. The Bottlenecks, Quantified

### 1.1 The Cost Model

Let H be head bytes, D the changed rows of a publish, and E the number of envelopes.

| Step | Code | Cost | Grows with |
| --- | --- | --- | --- |
| Capture: copy the head | `src/snapshotStore.ts:1028` | one head copy per envelope | E times H |
| Capture: session, callback, envelope files | `src/snapshotStore.ts:1031-1065` | row work | D |
| Capture: delete the working copy | `src/snapshotStore.ts:1041` | one head-sized unlink | E times H once writeback has begun |
| Reconcile: copy the head | `src/snapshotStore.ts:1296` | one head copy | H |
| Reconcile: read and hash each envelope, load the ledger | `src/snapshotStore.ts:1302-1306`, `:1360`, `:1371` | envelope bytes, lifetime envelope count | E, history |
| Reconcile: apply | `src/conflictPolicy.ts:196-241` | row work with a 2 MB page cache | D |
| Gate: `quick_check`, `foreign_key_check` | `src/snapshotStore.ts:1332`, `src/driver.ts:293-299` | reads the whole file | H |
| Durability: fsync the build | `src/snapshotStore.ts:1406` | flushes the whole copy | H |
| Commit: link, pointer, directory fsyncs | `src/publication.ts:107-161`, `src/fsutil.ts:73-88` | constant | none |
| DirectStore write | `src/directStore.ts:153-200` | one copy, the gate, and the flush, all under the lock | H |
| gc that collects | `src/snapshotStore.ts:1475-1482`, `:1626` | `integrity_check` of the head, one unlink per snapshot | H |
| Search sidecar rebuild (spike) | `spike/fsqlite/fts.ts:19-35` | rebuilds the whole FTS5 index | search rows |

A one-writer SnapshotStore publish therefore costs about two head copies, one check of
the head, one flush of the head, and the row work.
The measured loops add a sidecar rebuild and an integrity check, both proportional to
the head.

### 1.2 Measured Terms by Scale

All values are Verified medians from the result files named below the table.

| Term | S0 | S1 | S2 |
| --- | --- | --- | --- |
| Head | 36.8 MiB | 334.5 MiB | 1,717 MiB |
| Copy the head once, alone | not recorded | 131 to 178 ms | 722 to 1,338 ms |
| Capture, one record | 63 ms | 236 ms | 1,090 ms |
| Reconcile, one record | 49 ms | 388 ms | 1,660 ms |
| DirectStore write, one record | 71 ms | 494 ms | 2,612 ms |
| `quick_check`, warm | 25 ms | 213 ms | 1,108 ms |
| FTS5 sidecar rebuild | 77 ms | 639 ms | 3,754 ms |
| `gc({ retain: 0 })` | 76 ms | 797 ms | 4,324 ms |
| `validate()` | 53 ms | 740 ms | 3,443 ms |
| Sustained trickle, records per second | 15.57 | 2.63 | 0.6 |
| Sustained trickle, visibility p50 | 287 ms | 2,015 ms | 16,498 ms |

Sources: `results/<scale>/w2-trickle.json` (`SnapshotStore.1`, `DirectStore.1`,
`sustained`), `results/<scale>/w2.json` (`base_copy`), `results/<scale>/w1.json`
(`quick_check_warm_ms`), and `results/<scale>/w6.json` (`validate.ms`).

Three regularities follow.

- **The floor is linear in the head.** A one-record DirectStore publish costs 1.93,
  1.48, and 1.52 ms per MiB of head at S0, S1, and S2. One record costs the same as 100:
  2,612 ms against 2,420 ms at S2.
- **The publish is a minority of the loop.** The sidecar adds 1.9 to 2.2 ms per MiB and
  the collecting gc 2.1 to 2.5 ms per MiB. The trickle loop pays 6.1, 5.8, and 6.2 ms
  per MiB per publish, and the publish itself is 32%, 26%, and 24% of that.
- **The sustained rate is bound by capture, and the delay by gc.** At S2 the writer
  needs 1,278 ms per one-record envelope, and the reconciler spends 4,338 ms of each
  6,791 ms round in gc, which is 64% (`results/S2/w2-trickle.json`, `sustained`).

### 1.3 One Record at S2, Decomposed

Measured on a 1,856 MiB head (A.3, A.10):

| Term | Time |
| --- | --- |
| Copy, plain `copyFileSync` | 0.94 to 1.10 s |
| Copy with `COPYFILE_FICLONE` (falls back on ext4) | 0.66 to 1.10 s |
| fsync of the fresh copy | 0.52 to 1.69 s |
| `quick_check`, warm | 0.91 to 1.06 s |
| `quick_check`, cold | 14.8 to 24.8 s |
| `integrity_check`, warm | 3.9 to 4.5 s |
| Unlink of a synced head-sized file | 1.15 to 2.49 s |
| Hard link | 0.2 to 0.3 ms |
| The record itself, on an already synced private copy: transaction, then fsync | 0.3 to 0.4 ms, then 0.4 to 0.5 ms |
| 100 records on the same copy | 1.2 to 1.5 ms, then 1.1 to 8 ms |
| 2,500 records on the same copy | 27 to 58 ms, then 15 to 180 ms |

The row work for one record is under 1 ms beside 2.4 to 3.9 s of copy, flush, and check.
Three terms deserve attention beyond the copy:

- **The check depends on the page cache.** A cold `quick_check` is 15 to 25 times the
  warm one. Inferred: at S3 the head and one build are 13.4 GiB on a 16 GB machine, so
  the gate and gc would run mostly cold.
- **Deleting a head-sized file is not free here.** An unlink of a synced 1.95 GB file
  takes 1.15 to 2.49 s on this volume.
  The cause was not isolated; the volume is mounted with `discard`. gc unlinks under the
  publish lock (`src/snapshotStore.ts:1492-1497`, `:1626`).
- **The build cache is SQLite’s default.** `src/driver.ts:128-130` sets no `cache_size`,
  and this build’s default is 2,000 KiB (A.2). Applying a changeset of 12,000 new
  records and 72,000 edges takes 1.51 to 1.65 s with that cache and 0.82 to 0.91 s with
  256 MiB (A.7). The spike sets a 256 MiB cache inside its callbacks
  (`spike/fsqlite/load.ts:47`), which reaches captures and DirectStore builds but not
  the reconcile build.

### 1.4 Four Concurrent Writers

Round 1 at S2 (`results/S2/w2.json`): the 1% batch became visible after 54.7 s. The
writers took 51.3 s of that, which is 94%, and reconcile 3.4 s. Twenty envelopes each
copied the 1.8 GB head, so the run moved 36 GB of copy traffic at 702 MB/s, and the
capture p50 was 10.2 s against 1.09 s for a capture alone.
The 5% and 20% batches spent 89% and 74% in capture.

Round 2 at S2-r2 makes the comparison direct, because it also runs one writer in line
order (`results/S2-r2/w2.json`, `results/S2-r2/w2-v2.json`):

| Batch | Operations | One writer, DirectStore | One writer, SnapshotStore | Four writers, with retry and closure |
| --- | --- | --- | --- | --- |
| p01 | 2,390 | 4.6 s | 5.7 s | 46.4 s |
| p05 | 11,948 | 9.3 s | 12.5 s | 77.3 s |
| p20 | 47,791 | 19.4 s | 25.4 s | 91.9 s |

Concurrent capture through head copies is 4.7 to 10.2 times slower than a single
serialized writer, and section 1.8 shows it is also the less correct of the two.
The visible capture concurrency buys nothing at this head size.

Readers pay too. `readLease()` takes the publish lock (`src/snapshotStore.ts:926-934`),
so a reader that follows versions waits behind a DirectStore writer: reopen p95 was 1.1
to 1.3 s in the S1 DirectStore arm against 4 to 8 ms in the SnapshotStore arm
(`results/S1/w2-direct.json`, `results/S1/w2.json`, `reader.reopen_ms`).

### 1.5 Bytes

| Quantity | Measured | Source |
| --- | --- | --- |
| Head | 1.80 GB at S2, 1.95 GB at S2-r2 | `results/S2/w1.json`, `results/S2-r2/w1.json` |
| SnapshotStore import store after `gc({ retain: 0 })` | 1.65 H at S0, S1, and S2; 1.61 H at S2-r2 | `snapshot.store_bytes` over `snapshot.snapshot_bytes` |
| Applied-envelope archive | 1.20 GB at S2 for 95 applied envelopes | same |
| One working copy per in-flight capture | H each: 7.2 GB for 4 writers at S2 | `src/snapshotStore.ts:1025-1029` |
| FTS5 sidecar | 141 MiB at S2, a separate artifact per version | `direct.fts_sidecar.bytes` |
| Changeset for 47,334 updated documents and entities | 97.9 MB, about 1 KB per row | `results/S2/w4.json`, `string_to_object.envelope_bytes` |
| Export-only line store `kb_line` | 417 MB, 23% of the S2 head | `direct.breakdown.kb_line` |
| S3 projection | 6.7 GiB per generation, 33.7 GiB for W2 | `results/S3/feasibility.json` |

Nothing deletes `tx/applied`: the only writer is the move at
`src/snapshotStore.ts:2230-2232`, and the only reader lists it at `:1795-1798`.

### 1.6 Reads

Reads cost what plain SQLite costs.
The median p50 ratio to the control is 1.03, 1.00, and 0.99 at S0, S1, and S2
(`spike/fsqlite/README.md`, W3 Queries), and 1.00 and 1.02 at S1-r2 and S2-r2 (computed
from `w3.json` and `w3-plain-sqlite.json`). This is the property a redesign must not
spend.

### 1.7 The Round-1 Findings, Verified

| Finding | Verdict | Evidence and correction |
| --- | --- | --- |
| Every publish copies the whole file; one record costs as much as 100; 0.6 records per second sustained; 52 to 59 s with 4 writers; reads equal plain SQLite | Verified | Three `copyFileSync` calls with no mode flag: `src/snapshotStore.ts:1028`, `:1296`, `src/directStore.ts:153`. Sections 1.2 to 1.6 add that capture is 74% to 94% of the 4-writer time and gc is 64% of the trickle round. |
| fsqlite rejects FTS5; the sidecar costs about 4 s and 141 MiB at S2 | Verified | `validatePrimaryKeys` at `src/snapshotStore.ts:298-346`, called from `init()` at `:691`; DirectStore inherits it (`src/directStore.ts:56-65`). The message was reproduced for both strategies (A.2). A session over all tables does record FTS5 shadow tables (A.1), so a v2 that admits virtual tables must exclude them from capture explicitly. |
| No DDL in write callbacks; an index or typed-column change needs a new store (16.8 s at S2) | Verified | `src/driver.ts:188-205`; `results/S2/w4.json`, `side_by_side.total_ms` 16,839. A changeset captured on a bare schema applies cleanly to a target with extra indexes, an FTS5 table, statistics, and an added trailing column (A.1). The exact-DDL-hash rule is stricter than changeset compatibility requires. |
| `ANALYZE` cannot travel in an envelope; one added index made a page about 1,000 times slower | Corrected | The capture is not empty. The session records `sqlite_stat1`, and the write produces a 239-byte envelope (A.2). Reconcile reports it applied and ledgers it, but SQLite skips a changeset table that the target lacks, so the head gets no statistics. Once a DirectStore `ANALYZE` has created `sqlite_stat1`, envelope statistics do apply, and then two envelopes that both ran `ANALYZE` conflict: under the default `strict` policy the second is quarantined together with its data rows, and under `lww` the head keeps stale statistics (A.2). The slowdown is real and statistics fix it: 7.8 to 8.6 ms against 0.01 ms for one organization, and 5,441 ms against 6.6 ms for the round-2 hub (A.8). |
| gc keeps refusing under contending DirectStore writers | Verified, reproduced | The refusal is `src/snapshotStore.ts:1520-1527`. `results/S1/w2-direct.json` records 6, 8, and 8 of 20. The spike harness reproduced it at S0: 9 to 11 of 20 (A.11). |
| SnapshotStore keeps every applied envelope; the import store is 1.7 times the head | Verified | Section 1.5. The measured ratio is 1.65. |
| Crash recovery needs manual lock removal at the lock-holding kill points | Verified | `src/lock.ts:159-167` never takes over a lock, and repair refuses while one exists (`src/snapshotStore.ts:1986-1995`). `results/S1/w6.json` records `manual_lock_recovery: true` for `crash.direct-build` and `crash.publication`. |
| S3 is infeasible on this VM | Verified as a projection | `results/S3/feasibility.json`. W1 through DirectStore (11.8 GiB) would have fit in the 13.9 GiB free; W2 (33.7 GiB) cannot. |
| ext4 has no reflinks | Measured | `COPYFILE_FICLONE_FORCE` fails with `ENOTSUP`, `cp --reflink=always` fails, and `COPYFILE_FICLONE` falls back at the plain-copy speed (A.3). |

Verification also found these facts, which the design uses:

- SQLite’s changeset apply skips a table that is missing or incompatible in the target
  and still returns success (A.1). The exact schema hash hides this for caller tables in
  `f1.0`, but not for `sqlite_stat1`.
- This `node:sqlite` build allows 10 attached databases (`MAX_ATTACHED=10`, A.2, A.6).
- `PRAGMA quick_check` also checks an FTS5 table.
  With an FTS5 trigram index inside the file, the warm gate rises from 0.9 to 1.0 s to
  2.2 to 2.9 s at S2 (A.9).

### 1.8 The Round-2 Findings

**Hubs.** With hub degree growing to 24,428, the hub neighborhood query rises from 43 ms
at S1-r2 to 256 ms at S2-r2, ordinary nodes beside a hub reach 97 ms against 1.8 ms in
round 1, and the slowest path takes 154 ms (`spike/fsqlite/README.md`, Hub Growth).
These are SQLite read costs: the control is equal.
FalkorDB is slower on the same queries (section 5.2).

**Planner.** Two plans went wrong at S2-r2 (`results/S2-r2/w3-plans.json`). The unhinted
hub join took 5,405 ms; statistics fix it without a hint (5,441 ms to 6.6 ms, A.8). The
unfiltered view was served from the wrong index in 99.8 ms against 0.033 ms with
`INDEXED BY`; statistics do not fix that one (94 ms with statistics, A.8), so view
queries must keep naming their index.

**Import.** The SnapshotStore W1 route takes 57.4 s at S2-r2 against 22.3 s for
DirectStore and 19.0 s for plain SQLite, and a one-record publish takes 2.9 to 4.0 s
(`spike/fsqlite/README.md`, Round 2). The schema check costs 42 CPU-seconds in the parse
phase, outside fsqlite.

**Concurrent merge is not correct for this mapping.** Four writers applied delta-v2
batches whose upserts replace a record’s edges by origin and whose deletes and merges
remove rows (`spike/fsqlite/mapping.ts:549-594`). Three things happened
(`results/S1-r2/w2.json`, `results/S2-r2/w2.json`):

1. Reconcile quarantined envelopes as `permanent-conflict: NOTFOUND`: 2 of 20 at S1-r2
   p20, 1 of 20 at S2-r2 p05, and 3 of 20 at S2-r2 p20. Two writers had deleted the same
   edge rows from the same base.
   `f1.0` aborts on every `NOTFOUND` (`src/conflictPolicy.ts:124-139`).
2. Re-capturing the quarantined operations in one envelope and publishing again cost 1.5
   s at S1-r2 and 10.0 to 18.0 s at S2-r2 (`reconcile.retry.ms`).
3. The state was still wrong: 66 dangling edges at S1-r2 p20, and 12 and 138 at S2-r2
   p05 and p20 (`reconcile.closure.dangling_edges_before`). At S2-r2 they changed 6 of
   the 124 W3 answers after p05 (`spike/fsqlite/README.md`, W2 With v2 Batches).
   A closure envelope that replays the deletes and merges, and a third publish of 6.6 to
   7.3 s at S2-r2, made the rows equal to the one-writer state.

The cause is structural, not a tuning problem.
The edge table is a cross-record structure: a row’s existence depends on other records’
deletes and merges, and its `ord` on other records’ parallel edges
(`spike/fsqlite/mapping.ts:506-508`). The reference applier keeps the batch’s merges and
deletes in memory and applies them to later edges (`spike/fsqlite/mapping.ts:441-443`,
`:693-703`). Four writers have four memories, each working on a private copy of an old
head. A row changeset can only replay row images, so it carries the consequences one
writer saw and none of the rule that produced them.

Two probes bound the fix.
`SQLITE_CHANGESET_OMIT` is a legal answer to `NOTFOUND` in `node:sqlite`, and a
changeset can be split by operation with a 30-line parser, so a delete of a missing row
can be a no-op while an update of a missing row is still reported (A.12). A closure step
inside the build is cheap: after 1,000 node deletes at S2 size, removing the 20,940
incident edges takes 70 ms incrementally, and a full referential scan of 1.16 M edges
takes 636 ms (A.13), against 6.6 to 7.3 s for the closure publish.

### 1.9 The Constraint Behind the Numbers

On a filesystem without copy-on-write clones, a store can have only two of these three
properties:

1. each generation is one complete SQLite file;
2. a published file is never modified;
3. a publish costs time and bytes proportional to the change.

`f1.0` gives up the third.
Shards and attached deltas give up the first.
A WAL database and a recycled build file give up the second.
A reflink filesystem provides all three, because the filesystem keeps the delta.
The candidates below are best read as different answers to this choice, and the
recommended design is explicit about which answer applies on which filesystem.

## 2. Candidate Changes

Each candidate gives the mechanism, the expected effect from the measured numbers, the
guarantee it touches and how to keep it, the format and API impact, and the tests.

### (a) Clone-Based Copies (Rank 3)

- **Mechanism.** Pass `fs.constants.COPYFILE_FICLONE` at the three copy sites.
  Node documents it as an attempted copy-on-write reflink with a fallback copy.
  From libuv’s implementation, not re-verified here: on macOS it requests a clone from
  `copyfile`, and on Linux it issues the `FICLONE` ioctl.
- **Expected effect.** None on this ext4: the flag falls back at the same speed (A.3).
  On APFS, XFS with reflinks, and btrfs the copy becomes a metadata operation and the
  publish fsync flushes changed pages only.
  The synced-private-copy rows of section 1.3 measure exactly that state: under 1 ms for
  one record and 42 to 238 ms for 2,500. Inferred: a one-record publish at S2 falls from
  2.6 s to about the warm `quick_check`, 0.9 to 1.1 s. Disk per retained generation and
  per working copy falls from H to the changed pages, so S3’s W2 needs about 6.7 GiB
  plus changes instead of 33.7 GiB. Inferred from libuv and kernel behavior, not checked
  here: on Linux the unflagged copy may already clone on XFS and btrfs through
  `copy_file_range`, so the flag matters most on macOS.
- **Guarantees.** Atomic publication and immutability are unchanged: a clone is a
  separate file, and writes to it never reach the source.
  One recovery property weakens.
  Retained generations share blocks, so a media error in a shared block damages every
  generation that shares it, and the fallback to an older snapshot that repair uses
  (section 11 of the spec) no longer covers that fault.
  Keep it by making independence explicit: `seal()` and a periodic checkpoint generation
  use a plain copy.
- **Format and API.** No format change.
  An option selects `clone` or `physical`, and `fsinspect` reports clone support by
  probing `COPYFILE_FICLONE_FORCE` in the store directory.
- **Tests.** Generations are byte-identical in both modes.
  The source digest is unchanged after its clone is modified.
  `ENOTSUP` and `EXDEV` fall back.
  The crash, kill, publication, and gc suites run on a reflink mount: the macOS CI job
  runs on APFS, and a Linux job needs a btrfs or XFS loop mount.

### (b) Sharded or Partitioned Generations (Rank 11, Not Recommended)

- **Mechanism.** The head is a manifest of shard files.
  A publish copies the touched shards, and readers ATTACH them and query through TEMP
  views.
- **Expected effect.** Measured with 8 shards keyed by a hash of the origin record
  (A.6). Point lookups keep their speed.
  An ordered page is 2.5 times slower, a deep page 9.9 times, a count 3.1 times, a facet
  12.1 times, and a two-hop neighborhood 133 times (23.5 ms to 3,130 ms).
  `MAX_ATTACHED` is 10, so a reader can attach at most 10 shards.
  The write side gains little: with 8 hash shards, 20 changed records leave 0.55 shards
  untouched on average and 50 leave 0.01 (Inferred), so only batches of a few records
  copy less. Sharding by table saves nothing for a record upsert, which touches the
  entity, document, edge, and search tables together.
- **Guarantees.** Each shard is a standard SQLite file, but a generation is no longer
  one database. A standard tool needs an ATTACH script and views, and constraints across
  shards are not enforced.
- **Format and API.** A manifest, per-shard commit, and a view layer in every query.
- **Tests.** Not specified, since the read cost is disqualifying.
  One useful residue is an application pattern: keep export-only bulk such as `kb_line`
  (23% of the S2 head) out of the serving store.

### (c) Base Plus Delta Generations (Overlay Form: Rank 11, Not Recommended)

- **Mechanism.** A generation is a base file plus small attached delta files holding
  upserted rows and tombstones, with periodic compaction.
- **Expected effect.** Publish cost follows the change on any filesystem.
  The read side pays the same UNION view cost that (b) measured, plus an anti-join for
  every overridden or deleted row, and index-only counts and FTS5 need per-layer
  handling. `MAX_ATTACHED` bounds the layers.
- **Guarantees.** The head is not one SQLite database, so standard tools see partial
  data.
- **Format, API, and tests.** Not specified for the overlay form, for the same reason as
  (b).
- **Verdict.** The delta idea survives in two better forms.
  SQLite’s own base plus delta is the WAL, which overlays pages transparently for SQL
  and for standard tools: see (j). A delta expressed as the list of envelopes a
  generation folded, applied to a private replica instead of attached at read time,
  keeps single-file reads: see (m).

### (d) Coalesced, Adaptive Reconcile Cadence (Rank 7)

- **Mechanism.** A publisher loop folds every pending envelope into one build, and
  starts the next build no sooner than a multiple of the last build’s duration or when
  pending bytes pass a threshold.
  Maintenance runs on its own, slower schedule.
- **Expected effect.** Cadence alone cannot fix the sustained trickle, because the
  writer’s capture bounds it (section 1.2). With cheap capture, (k) or (l), the cycle is
  the fixed publish cost plus apply time.
  The one-writer DirectStore arm gives both: 2.9 s for one operation and 19.4 s for
  47,791 at S2-r2, so about 0.35 to 0.7 ms per operation (Inferred by subtraction from
  `results/S2-r2/w2-v2.json`). Inferred: at 100 records per second the cycle is about 3
  s and visibility about 1.5 cycles, against 0.6 records per second and 16.5 s today.
- **Guarantees.** None is touched.
  An accepted envelope is still not power-loss durable before publication (spec section
  10). A single-file envelope with a file and directory fsync closes that gap for 0.41
  ms (A.14).
- **Format and API.** No format change.
  A `publisher()` helper with `minIntervalMs`, `maxDelayMs`, and `maxPendingBytes`.
- **Tests.** The scheduling policy under a fake clock, and the sustained trickle run as
  a soak test with a bound on visibility delay.

### (e) Derived Tables, Indexes, Statistics, and Closure Built at Publish (Rank 1)

- **Mechanism.** The schema splits in two.
  Base tables have primary keys, are captured in changesets, and follow the conflict
  policy. Derived objects are everything computed from them: secondary indexes, FTS5 and
  other virtual tables, summary tables, `sqlite_stat1`, and the results of closure
  rules. A declared, versioned build hook creates and maintains them inside each
  generation build, after the envelopes or the direct callback and before the gate.
  Capture attaches sessions to base tables only, and reconcile refuses an envelope that
  names anything else.
- **Feasibility, measured.** A prototype of 84 changed lines in a scratch copy of the
  package does this through both strategies (A.9). Two SnapshotStore writers and one
  DirectStore write publish generations that hold an FTS5 trigram index, a facet
  summary, secondary indexes, and statistics.
  `validate()` reports `sealed`. An envelope that writes a derived table is quarantined.
  Python’s `sqlite3` reads the generation and runs the FTS5 query.
  Of the 228 existing tests, 226 pass, 1 is skipped, and 1 fails because it asserts the
  gc rule that (i) replaces.
- **Expected effect, measured at S2 size (A.9, A.8, A.13).**
  - Search: the index lives in the generation, so indexed search is visible when the
    data is. Maintaining it costs 0.7 ms for one changed entity, 52 to 55 ms for 100, and
    1.07 to 1.09 s for 2,500, against a 3.1 to 3.8 s full build and the sidecar’s 3.5 to
    4.4 s after every publish.
    It adds 157 MB, 8% of the head.
  - Statistics: `ANALYZE` with `analysis_limit` 1000 takes 283 to 344 ms, a full
    `ANALYZE` 0.97 to 1.04 s, and `PRAGMA optimize` 0.07 to 0.1 ms when nothing has
    changed. The 5.4 s unhinted hub join becomes 6.6 ms.
  - Facets: a summary table builds in 1.03 to 1.06 s and answers in 1.14 ms against 28
    to 29 ms.
  - Index changes: a new view index becomes a build step in the same store.
    Inferred: under 1 s of index build at S2, since the control builds every index in
    2.9 s (`results/S2/w1-plain-sqlite.json`, `indexes_after.index_ms`), plus one
    publish, against 16.8 s and a new `store_id`.
  - Bulk load: derived indexes can be created after the rows.
    The control measures that order at 14.0 s against 16.6 s
    (`results/S2/w1-plain-sqlite.json`).
  - Closure: section 1.8’s dangling edges are removed in the build for 70 ms instead of
    a 6.6 to 7.3 s extra publish.
- **A cost to design around.** `quick_check` verifies FTS5 tables, which adds 1.3 to 1.4
  s to the gate at S2 (A.9). The gate should check base tables on every publish and
  derived virtual tables only when the hook rebuilt them, or follow the verification
  policy of (i).
- **Guarantees.** Readability by standard tools improves: search and statistics travel
  inside the standard file.
  Exactly-once is unaffected, because derived content is a function of base content.
  The determinism rule of spec section 6 now covers the hook: two reconcilers that fold
  the same tail must derive equivalent content.
  Stamp the derived specification’s hash and version in every generation, and refuse to
  build with a different one.
- **Format and API.** `fsqlite_meta` gains the base table list and the derived hash and
  version. The store options gain `derived: { version, ddl, rebuild, update }`, where
  `update` receives the changed keys, which come from the parsed changesets, or from a
  session on the build in the serialized lane; a build without session support calls
  `rebuild`. The schema hash covers base tables only.
  Optional plan assertions let the build run `EXPLAIN QUERY PLAN` for declared queries
  and fail when an expected index is not used, which would have caught both round-2
  plans at publish time.
- **Tests.** Virtual tables pass `init()` and `validate()`. An envelope that names a
  derived or shadow table is refused at capture and quarantined at reconcile.
  A hook failure publishes nothing and leaves no transient.
  A derived version bump rebuilds in place and keeps `store_id`. Two reconcilers derive
  equal content. The fuzz suite runs with hooks.

### (f) A Schema Migration Step at Generation Build (Rank 9)

- **Mechanism.** The schema declares forward-only steps, each with a target version, a
  class, and an `up(db)` function.
  A migration is one generation build under the publish lease: fold the pending tail
  under the old schema, run the steps with DDL allowed, rebuild derived objects, stamp
  the new version and hash, pass the gate, and commit.
  The store keeps its `store_id`.
- **Envelope admission.** An `additive` step (a new table, a trailing column) leaves
  older envelopes valid, which matches SQLite’s own compatibility rule and was measured
  (A.1). Because SQLite skips incompatible tables silently, fsqlite must check each
  changeset’s table headers against the build before applying it; the header parser is
  40 lines (A.1). A `breaking` step quarantines older envelopes that arrive after it as
  `schema-superseded`, and the writer re-captures.
- **Expected effect.** With (e), index and FTS changes are not migrations at all.
  A typed-column addition is `ALTER TABLE ADD COLUMN`, a schema-only change in SQLite,
  plus one publish, against 8.8 s and a new store (`results/S2/w4.json`,
  `add_column_side_by_side`). Readers follow the pointer, so there is no cutover.
- **Guarantees.** Store identity (design C8) becomes a lineage: each generation stamps
  its version and the cumulative hash, and a handle whose steps do not reproduce that
  hash is incompatible.
  Opening a store still never migrates it.
- **Format and API.** `schema: { base, steps, policy }`. The conflict policy is stamped
  with the schema, which closes spec O5.
- **Tests.** A crash at each step publishes nothing.
  Mixed-version envelopes are admitted or quarantined by class.
  Old and new writers overlap.
  A changeset with a missing table or a different primary key is quarantined, not
  skipped.

### (g) Envelope Retention and a Ledger Floor (Rank 2, With (i))

- **Mechanism.** An applied envelope is kept until a later generation that contains it
  has a verification record, then deleted, unless it resolved a conflict and the store
  is configured to keep conflict evidence.
  The ledger gets a floor: a timestamp stored in the generation below which every
  envelope id is either applied and pruned or refused.
  Reconcile quarantines a pending envelope older than the floor as expired, and prunes
  ledger rows below it.
- **Expected effect.** The S2 import store falls from 1.65 H to about H. Validate and gc
  stop paying one ledger lookup per archived envelope (design, Capacity and Cadence),
  and the ledger set that reconcile loads (`src/snapshotStore.ts:1302-1306`) is bounded.
- **Guarantees.** Exactly-once is preserved by the floor rule, since a pruned id can
  never be applied again.
  The retention rule strengthens repair: the newest verified generation plus the
  retained envelopes rebuilds any later head.
  The losing value of a conflict stays recoverable only for envelopes kept as evidence,
  which is what the conflict test relies on (`spike/fsqlite/README.md`, Conflicting
  Writes).
- **Format and API.** A `ledger_floor` key, a `maintain({ retainApplied })` option, and
  a validation rule that compares the archive with the ledger above the floor only.
- **Tests.** An old envelope copied back into pending is refused.
  The floor never moves back.
  A crash between publish and prune loses nothing.
  A writer whose clock is behind the floor fails at capture.

### (h) Commit by No-Replace Link, With an Expirable Lease (Rank 8)

- **Mechanism.** `f1.0` already commits a build by a no-replace hard link to the next
  version name (`src/publication.ts:171-195`). The lock cannot expire only because the
  pointer rename that follows is blind and can move `current` backward
  (`src/fsutil.ts:73-88`, spec L5 and O6). v2 makes the link the commit point.
  The head is the highest committed generation, and `current` becomes a hint that
  readers probe forward from.
  Two racing publishers both link the same name, exactly one succeeds, and the other
  rebuilds from the winner.
  A `floor` record, raised by gc before it deletes, stops a paused publisher from
  re-creating a collected version: after its link it reads the floor and withdraws if
  the version is at or below it.
- **Expected effect.** The lock no longer carries safety, so it can be a lease that
  expires and that a same-host process can break at once when the owner’s process is
  gone. Both lock-holding kill points in `results/S1/w6.json` then recover without an
  operator. Read leases can stop taking the lock as well, at the price of one documented
  race: a holder may find its version’s path missing for the instant between gc’s rename
  and its restore (spec G2). The reader therefore opens the file before it reports the
  lease, and restoring a tombstone after a gc crash becomes part of gc and repair.
  Readers then stop waiting 1.1 to 1.3 s behind publishers.
- **Guarantees.** Atomic publication is kept and simplified to one filesystem operation
  that the format already requires.
  The orphan-ahead-of-pointer state disappears: a linked generation is published.
  Repair can no longer roll the head back by re-pointing.
  It rolls forward instead: it publishes a new generation from the newest verified one
  plus the retained envelopes.
  This is the largest change to a core guarantee in this list, so it needs a written
  model of the interleavings before code.
- **Format and API.** `current` becomes advisory, a `floor` file is added, and the lock
  rules L2 and L5 change.
  The marker names the feature in `required_features`.
- **Tests.** The publication and fencing suites rewritten for the new rule: paused
  publishers at every step, a publisher that resumes after gc, racing links, a stale
  hint. All four W6 kill points with no manual step.
  The existing exactly-once and crash suites unchanged.

### (i) gc Against a Pinned, Verified Generation (Rank 2)

- **Mechanism.** A generation is immutable, so an integrity verdict on it never expires.
  gc verifies one pinned generation G outside the lock, records the verdict, and deletes
  only generations older than `G - retain`. It no longer requires G to be the head.
  A verification record lets later gc calls skip the read until the record is older than
  a configured age, which turns the per-gc check into a periodic scrub.
  gc renames a collected generation to a tombstone under the lease and unlinks it after
  release, so the 1.15 to 2.49 s unlink of section 1.3 no longer blocks publishers.
- **Expected effect.** A three-line prototype (the comparison, its message, and the keep
  floor) removes every refusal in the spike’s DirectStore W2 at S0: 0 of 20 in six
  batches, against 9 to 11 of 20 with the current code (A.11). At S2 a collecting gc
  costs 3.5 to 5.1 s after every publish today; with a verification record it costs one
  unlink per collected generation.
  The trickle round loses most of its 64% gc share.
- **Guarantees.** The purpose of spec G0 is kept: gc never deletes the newest verified
  generation or anything newer.
  The rule changes from “the head is verified now” to “a verified generation at least as
  new as everything deleted remains”.
- **Format and API.** A `verified/<generation>.json` record with the file identity and
  the check level, a `maintain({ verifyMaxAgeMs })` option, and a changed G0.
- **Tests.** gc under continuous publication never refuses.
  A corrupt head with a verified predecessor keeps the predecessor.
  A record whose file identity no longer matches is ignored.
  `validate()` still runs the full check itself.

### (j) WAL Mode for Single-Host Use (Rank 10, as the Local Form of (m))

- **Mechanism.** An opt-in live head: one applier holds the lease and folds envelopes
  into an ordinary WAL database in small transactions, with the ledger row in the same
  transaction. Local readers open it read-only.
  Immutable generations are cut from it at a slower cadence.
- **Expected effect.** Measured on the S2-size file (A.10): a durable one-record commit
  takes 0.7 to 1.8 ms in WAL mode and 4.4 to 6.0 ms with the rollback journal, 100
  records take 14 to 20 ms, and 2,500 take 0.48 to 0.58 s. That is about 2,000 times
  faster than the 2.6 s publish.
  A checkpoint of a 43 MB WAL takes 31 to 38 ms.
- **Guarantees.** The live head is neither immutable nor safe on a shared path, since
  WAL needs coherent locks and shared memory.
  It must be refused where `fsinspect` does not report a local filesystem, and it
  requires SQLite 3.51.3 or later (design, Choose by Coordination Model).
  Publication atomicity becomes SQLite’s commit.
  Generations keep their guarantees at their own cadence.
- **Format and API.** A `live/` directory and a mode flag in `required_features`.
- **Tests.** Kill during apply, reader isolation across commits, generation cuts under
  load, and refusal on a network mount.

### (k) Operation Envelopes Applied by a Serial Reducer (Rank 5)

- **Mechanism.** A second envelope kind carries application bytes, for this workload the
  delta-v2 operations, instead of a changeset.
  Capture is a file write.
  Reconcile applies each envelope by calling a registered reducer inside the same
  transaction as its ledger row, in envelope-id order.
  The reducer’s name and version are stamped like the schema.
- **Expected effect.** Capture costs 0.04 ms, or 0.41 ms with a durability barrier
  (A.14), on every filesystem, and needs no SQLite session, so a Python crawler can
  write envelopes directly.
  The four-writer batch then costs what one writer costs: 4.6 to 19.4 s at S2-r2 instead
  of 46 to 92 s. No envelope is based on a stale private copy, so nothing is quarantined
  for `NOTFOUND` and no retry publish is needed.
  The state is that of one writer applying the operations in envelope order.
  One writer in line order matches the oracle (`spike/fsqlite/README.md`, Round 2,
  Correctness). Envelope order equals line order only for operations that commute, so an
  upsert that arrives after the delete of a node it references still needs the delete to
  be remembered: the tombstones and closure of section 3.6, which the reducer runs in
  the same build.
- **Guarantees.** Capture without a server is kept and widened to any language.
  Exactly-once and deterministic order are unchanged.
  Reconcile now needs application code, as it already needs the application’s schema and
  policy. A reducer that throws quarantines its envelope.
- **Format and API.** An envelope `kind` field, a single-file envelope committed by link
  (which also removes the directory rename of spec O7), an `append()` call for writers,
  and a `reducers` option for the publisher.
- **Tests.** The exactly-once and crash suites with operation envelopes.
  A reducer version mismatch is refused.
  The round-2 batches with four writers produce no quarantine, and with tombstones and
  closure they equal the line-order rows in one publish.

### (l) Sparse-Seed Changeset Capture (Rank 6)

- **Mechanism.** The working database holds the schema only.
  The head is attached read-only and immutable.
  Before the session starts, the write hydrates the rows it will update or delete, and
  the callback then runs as today.
- **Expected effect.** Measured on the 1,856 MiB head (A.4): 1.4 ms for one record, 4.3
  to 4.5 ms for 10, 27 to 29 ms for 100, and 0.92 to 1.03 s for 2,500, with a 94 KB
  working file for one record instead of a 1.95 GB copy.
  The same capture costs 1.09 to 1.16 s today.
  The changeset applies to the full head with no conflict (A.1). A patchset is 51% of
  the changeset bytes and is sufficient for `lww` tables.
- **Guarantees.** Spec W2 says the callback must observe the data and constraints its
  changeset is based on.
  A sparse seed observes the hydrated rows and the read-only head, and constraints
  against rows it did not hydrate are enforced at reconcile, where a violation
  quarantines the envelope.
  A callback that updates a row it did not hydrate changes nothing, so the API should
  hydrate through helpers rather than rely on the caller.
- **Format and API.** No format change.
  The capture call takes `seed: 'sparse'` with a `hydrate` plan, and `seed: 'full'`
  stays for callbacks that need the whole base.
- **Tests.** Sparse and full capture produce equal changesets for the same write.
  A missing hydration is detected by the helper API. Conflict detection for hydrated
  rows is unchanged.

### (m) Generation Manifests With Deferred Materialization (Rank 10)

- **Mechanism.** Each publish commits a small manifest that names the base generation
  and the envelopes it folded, in order, with their outcomes.
  Materializing the generation as a complete file becomes a separate step that may run
  immediately, as in `f1.0`, or at a coalesced cadence.
  The publisher keeps a private build file and applies each manifest’s envelopes to it
  in place. Any replica that applies the same manifests with the same policy and hooks
  reaches the same state, which spec section 6 already requires of two reconcilers.
- **Expected effect.** A logical publish costs the row work and one small fsync: under 1
  ms for one record and 42 to 238 ms for 2,500 (section 1.3), on any filesystem.
  A local reader of the publisher’s replica sees it at once, which is (j). Complete
  generation files appear at the materialization cadence for standard tools, other
  hosts, and backup.
- **Guarantees.** Published artifacts stay immutable: manifests, envelopes, and
  materialized generations.
  Standard tools read a complete generation that may lag the logical head, so the design
  has two heads and must name them.
  Determinism of reducers and hooks becomes essential, since a divergent replica is
  silent corruption; a state digest per manifest would detect it.
- **Format and API.** The manifest is worth adding to the first v2 format even if
  materialization stays immediate.
  It costs a few hundred bytes per generation and provides the change list for
  incremental export, for cache invalidation, and for roll-forward repair.
- **Tests.** Replay from a materialized generation equals the published head.
  A nondeterministic hook is detected by the digest.
  Kill at every step of a logical publish.

### (n) Conflict Policy Completion and Changeset Admission (Rank 4)

- **Mechanism.** Three additions to the changeset path.
  - **Idempotent deletes.** Each table declares what a missing row means for a delete
    and for an update: `ignore` or `quarantine`. `OMIT` is a legal answer to `NOTFOUND`,
    and splitting a changeset by operation lets deletes be idempotent while updates of
    missing rows are still reported (A.12).
  - **Declared cascade relations.** A relation names a child table, its key columns, a
    parent table, and what to do when the parent is missing after the batch is folded:
    delete the child, hide it from a derived table, or quarantine as today.
    This is foreign-key meaning evaluated at reconcile over the merged state, instead of
    at capture over one writer’s copy (spec F3).
  - **Admission.** Reconcile parses each changeset’s table headers and quarantines an
    envelope that names a table outside the base set or with an incompatible shape, so
    nothing is skipped silently.
- **Expected effect.** The `NOTFOUND` quarantines of section 1.8 and their retry
  publishes disappear.
  Dangling edges are removed inside the build.
  Statistics and shadow tables can no longer enter an envelope.
- **What it does not fix.** Edge ordinals and merges still depend on other records.
  For them the mapping has to change, which section 3.6 describes: tombstones and
  redirects stored as base facts, and the live edge table derived.
- **Guarantees.** Constraint closure (spec section 6) is extended, not weakened: the
  default stays `quarantine`, and every relaxation is declared per table and stamped
  with the schema.
- **Format and API.** The policy grows from one action per table to three settings,
  `conflict`, `missingDelete`, and `missingUpdate`, and the schema gains `relations`.
- **Tests.** The merge-constraints suite with each new setting.
  Two writers that delete the same row.
  A delete racing an update.
  The round-2 batches with zero quarantines.

## 3. Recommended Target Design for fsqlite v2

### 3.1 Principles

1. **One complete, immutable SQLite file per generation.** Reads stay plain SQLite
   reads, and standard tools need nothing else.
2. **Envelopes carry facts; builds derive.** Anything that depends on more than one
   row’s writer is computed in the generation build by declared, deterministic rules.
3. **The commit is one no-replace link.** Locks are leases that expire.
4. **Verification is recorded and amortized.** A generation is checked once, the record
   outlives the check, and retention follows the records.
5. **The O(H) terms are explicit.** The copy is a clone where possible, the publish is
   coalesced where not, and the option that trades immutability for speed is local,
   opt-in, and named.

### 3.2 Store Layout

```text
<store>/
  fsqlite.json                  # format f2.0, store_id, required_features
  current                       # hint only: a committed generation number
  floor                         # lowest generation number that may still be committed above
  generations/
    000000000041.sqlite         # committed by no-replace link; the highest number is the head
    000000000041.manifest.json  # base generation, folded envelope ids and outcomes
    .build-<hex>.sqlite         # transient
  verified/000000000041.json    # check level, time, file identity
  inbox/<txid>.env              # single-file envelope: header line, then payload
  applied/, conflicts/, quarantine/
  leases/                       # read leases
  lock/                         # advisory lease: owner, heartbeat, expiry
```

Each generation stamps, in `fsqlite_meta`, the store identity, the base schema version
and cumulative hash, the stamped policy, the derived specification’s version and hash,
the reducer versions, and the ledger floor.

### 3.3 API Sketch

```ts
const store = new Store(dir, {
  schema: {
    base: BASE_DDL, // tables with primary keys; the changeset contract
    steps: [{ to: 2, kind: 'additive', up: (db) => db.exec('ALTER TABLE doc ADD COLUMN rev TEXT') }],
    policy: { entity: { conflict: 'lww', missingDelete: 'ignore' }, '*': 'strict' },
    relations: [{ child: 'edge_fact', columns: ['origin'], parent: 'doc', onMissing: 'delete' }],
  },
  derived: {
    version: 5,
    ddl: DERIVED_DDL, // indexes, FTS5, summaries
    rebuild: (db) => {},
    update: (db, changes) => {}, // changed keys per base table
    statistics: 'optimize',
    plans: [{ sql: VIEW_SQL, uses: 'ix_view_repos_all_by_stars' }],
  },
  reducers: { 'kb-delta/v2': applyKbDelta },
  copy: 'clone',
}).open()

store.append('crawler-7', 'kb-delta/v2', bytes, { durable: true }) // any language can do this
store.capture('agent-3', fn, { seed: 'sparse', hydrate }) // changeset envelope
store.publish() // fold the inbox, derive, gate, commit
store.publish(fn) // the serialized lane: fn runs in the build
store.read(fn)
store.pin() // read lease, no lock
store.maintain({ retain: 2, verifyMaxAgeMs, retainApplied: 'conflicts' })
store.validate()
store.repair()
store.seal(dest)
```

`SnapshotStore` and `DirectStore` become one class with two verbs: `capture` or `append`
without the lease, and `publish` with it.
The CLI keeps its schema-agnostic commands and gains `verify`.

### 3.4 Publication

A build starts from a clone or copy of the head, opens it with a configured page cache,
and then:

1. runs pending migration steps, if the handle declares newer ones;
2. folds inbox envelopes in id order: a changeset after header admission and under the
   stamped policy, an operation batch through its reducer, each with its ledger row in
   one transaction;
3. applies cascade relations and the derived `update` hook to the changed keys;
4. refreshes statistics and checks declared plans;
5. runs the gate on base tables, and on derived tables that were rebuilt;
6. fsyncs, writes the manifest, links the next generation name without replacing, fsyncs
   the directory, checks the floor, and updates the hint.

A failed link means another publisher won; the build is discarded and the fold repeats
on the new head, where the ledger skips what the winner applied.
The lease only prevents wasted builds.

### 3.5 Capture

Writers choose by what they know.
A producer that has a record and its derived rows appends an operation batch.
A producer that needs to read and modify rows uses a sparse changeset capture and reads
the attached head. A full-copy capture remains for callbacks that need every constraint,
and is cheap where clones exist.
All three are envelopes in one inbox with one ledger.

A bulk import is a publisher job, not a stream of envelopes.
It runs in the serialized lane with a large build cache and creates derived indexes
after the rows. The control measures that order at 14.0 s at S2, where the SnapshotStore
route takes 44.1 s, and 57.4 s at S2-r2.

### 3.6 Facts, Tombstones, and Closure

The round-2 anomalies come from storing a cross-record structure in changeset-carried
tables. The design rule that removes them is independent of the envelope kind:

- **Base tables hold facts keyed by their origin.** A record’s document, its entity
  rows, and its complete edge set are rows keyed by the record.
  Replacing a record’s edges is one upsert of its set, not row deletes and inserts, so
  two writers cannot half-apply it and nothing can be `NOTFOUND`.
- **Deletes and merges are facts too.** A tombstone row and a redirect row are inserts
  keyed by the affected id.
  They commute under `lww`, and a later upsert of the same id clears its tombstone in
  envelope order.
- **The live graph is derived.** The closure step resolves edge endpoints through
  redirects to a fixed point, hides or removes edges whose endpoint is tombstoned or
  absent, assigns ordinals in a deterministic order, and maintains the search and facet
  tables. An edge to a record that has not arrived yet is kept as an unresolved fact and
  reported, which the accumulation stage needs.

fsqlite core supplies the mechanisms: the missing-row policy, declared cascade
relations, and the derived hook with changed keys.
Which node survives a merge and how origins are rewritten are knowledge-base policy and
stay in the layer above.
Merges should not become a core relation type until a second application needs them.

The four round-2 design questions map to the design as follows:

| Question | Answer | Where |
| --- | --- | --- |
| Idempotent deletes | A per-table `missingDelete: 'ignore'` policy, implemented with `OMIT` on a delete-only split of the changeset; the default stays `quarantine` | (n), A.12 |
| Tombstones | Base rows keyed by the deleted id, kept until the ledger floor passes them; an upsert of the id clears its tombstone | this section |
| A closure or constraint step at reconcile | Cascade relations and the derived hook run inside the build over the changed keys, before the gate: 70 ms instead of an extra 6.6 to 7.3 s publish | (e), (n), A.13 |
| Merges and cascades as declared relations | Cascades yes, as schema-declared relations that the reconciler enforces. Merges as redirect facts resolved by the knowledge-base layer’s hook, not as a core relation type | (n), this section |

Operation envelopes with a serial reducer make the first row unnecessary, because
nothing is captured against a stale copy.
They do not make tombstones and closure unnecessary.
An upsert that arrives after the delete of a node it references produces a dangling edge
unless the delete is remembered, and the fact-keyed mapping is what makes the state
independent of the order in which the two arrive.

### 3.7 Verification, Retention, and Recovery

- A publish records a `quick` verification of the base tables.
  Maintenance upgrades one generation to `full` at a configured interval.
- gc deletes generations older than the newest `full` record minus `retain`, except
  leased ones, and deletes applied envelopes that a `full` generation contains.
- Repair finds the newest generation that verifies, replays the retained envelopes from
  the manifests, and publishes the result as a new generation.
  It never moves the head back and never deletes the evidence first.
- For a large head on a filesystem with clones, an option defers the per-publish page
  check and relies on the scrub.
  A generation may then be served before it is verified, but it is always detected and
  rebuilt. The default keeps the check on every publish.

### 3.8 Operating Points by Filesystem

| Filesystem | Copy | One-record publish at S2 | Disk per extra generation | Basis |
| --- | --- | --- | --- | --- |
| APFS, XFS with reflinks, btrfs | clone | about 1 s with the per-publish check; tens of ms with deferred verification | changed pages | Inferred from A.3 |
| ext4, shared and cloud paths | physical, coalesced | 2.4 to 3.9 s, shared by every record in the cycle | H | A.3 |
| Local ext4, opt-in live head | none per commit | 0.7 to 1.8 ms; generations at their own cadence | H per materialized generation | A.10 |

Expected results at S2 on this ext4, with (e), (i), (k) or (l), and (d):

| Workflow | `f1.0` measured | v2 expected | Basis |
| --- | --- | --- | --- |
| One record visible | 2.6 to 2.75 s | 2.4 to 3.9 s | section 1.3 |
| One record visible in indexed search | 6.4 to 7.1 s | the same instant | A.9 |
| gc after a publish | 3.5 to 5.1 s | one unlink per collected generation, outside the lock | A.3, A.11 |
| Sustained trickle | 0.6 records per second, 16.5 s delay | hundreds per second, about 1.5 cycles of 3 s | Inferred, (d) |
| Four writers, 1% batch | 46.4 to 54.7 s | about the one-writer 4.6 s | `results/S2-r2/w2-v2.json` |
| Four writers, 20% batch | 52.1 to 91.9 s | about the one-writer 19.4 s | same |
| Import store | 1.65 H | about H | (g) |
| New view index | 16.8 s, new store | an index build and one publish, same store | (e) |
| S3 disk for W2 | 33.7 GiB | 13.4 GiB, or 6.7 GiB plus changes with clones | Inferred |

The single-record latency on ext4 does not improve.
What improves is that the cost is paid once per cycle instead of once per record and
three times over.

### 3.9 Out of Scope

- **A generic entity, edge, and knowledge-base layer.** It belongs in a separate package
  built on fsqlite. It owns the mapping, the delta-v2 reducer, the closure rules for
  merges and tombstones, the view indexes and their `INDEXED BY` queries, the search and
  facet builders, schema validation with a content-hash cache, export, and any graph
  cache. fsqlite stays schema-agnostic, which keeps the CLI operable without application
  code (design C11), the package small enough to audit (design C12), and the same layer
  usable over plain SQLite.
- **Shards and attached overlays**, for the measured read cost.
- **Recycling superseded generation files in place.** It gives O(changed pages)
  publishes on any filesystem, but a standard tool that still holds an old file would
  read a different database without an error.
- **Serializable multi-writer transactions, a server, replication transport, and Windows
  mutation**, which the current design already excludes.

## 4. Prototype Plan

All four spikes use a scratch copy of the package and of `spike/fsqlite/`. The harness
imports fsqlite through one file, `spike/fsqlite/fsq.ts`, and takes its working
directory from `KB_SCRATCH`, so a scratch copy needs two edits (A.11 did this).

### Spike 1: Derive at Build

- **Changes.** (e) with closure, statistics, plan assertions, and the build page cache.
- **Hypotheses.**
  1. With FTS5, the facet summary, and statistics maintained in the build, the time to
     indexed-search visibility equals the time to visibility, and a publish of at most
     100 changed records at S2 spends under 100 ms in the hook.
     It is false if the gate or the hook adds more than 1 s per publish.
  2. The hub join runs under 10 ms at S2-r2 with no hint, and the build fails when the
     unfiltered view is not served from its index.
  3. A new view index is published in the same store in under 5 s at S2 on ext4.
  4. With a 256 MiB build cache, the SnapshotStore W1 reconcile at S2-r2 falls by at
     least 30% from 35.4 s.
- **Measurement.** `run.sh` W1, W3 with `--name w3-fts` against the in-file index,
  `plans.ts`, `trickle.ts`, and W4 case 5 at S1 and S2, and `run_r2.sh` W1 and W3 at
  S1-r2 and S2-r2. Metrics: `indexed_search_visible_after_ms` against
  `visible_after_ms`, `publish_ms`, the hook’s time, snapshot bytes, and the plans.
- **Code.** `src/snapshotStore.ts:298-346` and `:691` (base and derived DDL),
  `:1295-1337` (hook and cache in `fold`), `src/directStore.ts:157-171` (hook in the
  direct build), `src/conflictPolicy.ts:201-207` (base-table filter),
  `src/driver.ts:128-130` and `:211-227` (cache, per-table sessions).
  In the spike: `mapping.ts:87-150` (move indexes to derived DDL), `fts.ts`,
  `queries.ts:207-231`.

### Spike 2: Cheap Capture and Serial Apply

- **Changes.** (k) operation envelopes with the delta-v2 reducer, (l) sparse capture,
  (n) the missing-row policy, and (d) a coalescing publisher.
- **Hypotheses.**
  1. Capture p50 at S2 is at most 5 ms for one record and 50 ms for 100, against 1.09 to
     1.16 s.
  2. Four writers reach visibility within 1.5 times the one-writer DirectStore time at
     S1-r2 and S2-r2, against 4.7 to 10.2 times.
  3. With operation envelopes, no envelope is quarantined and no retry publish is
     needed. With tombstones and closure in the same build, the four-writer rows equal
     the line-order rows and W3 answers 124 of 124 after one publish.
  4. With changeset envelopes and `missingDelete: 'ignore'`, no envelope is quarantined
     for `NOTFOUND`, and the dangling edges remain until Spike 1’s closure runs.
     This separates the two causes.
  5. The sustained trickle at S2 exceeds 100 records per second with a visibility p95
     under two publish cycles.
- **Measurement.** `w2.ts` and `w2v2.ts` at S1-r2 and S2-r2, `trickle.ts` at S1 and S2,
  and `conflict.ts`. Metrics: `capture_ms`, `visible_after_ms`, `reconcile.quarantined`,
  `closure.dangling_edges_before`, `same_rows_as_one_writer_in_line_order`,
  `w3_check_against_reference`, and `sustained`.
- **Code.** `src/snapshotStore.ts:1016-1067` (capture and envelope files), `:1343-1393`
  (admission), `:1295-1337` (reducer dispatch), and `src/conflictPolicy.ts:124-139`
  (missing-row policy).
  In the spike: `w2_worker.ts:34-127` (append operations instead of capturing) and
  `mapping.ts:549-594` (the reducer).

### Spike 3: Maintenance and Publication

- **Changes.** (i) pinned gc with verification records, (g) retention and the ledger
  floor, and (h) commit by link with an expirable lease.
- **Hypotheses.**
  1. gc refuses 0 of 20 times in the DirectStore W2 at S1 and S2, against 6 to 8 at S1.
  2. The sustained trickle round at S2 shrinks by at least half, since gc is 64% of it.
  3. The SnapshotStore import store is at most 1.05 H after maintenance.
  4. All four W6 kill points recover with no manual step within the lease expiry, no
     published generation is lost, and no envelope is applied twice.
- **Measurement.** `w2.ts --strategy direct`, `trickle.ts`, `w1.ts`, and the `w6.ts`
  crash tests at S0 and S1, then S2. The package’s publication, fencing, gc-lease,
  repair, crash, and kill suites, rewritten where the rule changes.
- **Code.** `src/snapshotStore.ts:1459-1579` (gc), `:926-969` (leases without the lock),
  `:2203-2264` (settle and archive), `:1946-2155` (repair), `src/publication.ts:107-195`
  (commit), `src/fsutil.ts:73-88` (pointer as hint), and `src/lock.ts:137-225` (expiry).

### Spike 4: Publication That Follows the Change

- **Changes.** (a) the clone flag, measured on a reflink filesystem, and (m) with (j): a
  private build file with manifests, measured on ext4.
- **Hypotheses.**
  1. On APFS and on XFS or btrfs, a one-record publish at S2 takes at most 1.3 s with
     the per-publish check and at most 100 ms with deferred verification, and a retained
     generation adds under 2% of H for a 1% batch.
  2. On ext4, a logical publish of one record takes under 5 ms and of 2,500 records
     under 0.5 s, a local reader sees it in the next query, and replaying the manifests
     onto the last materialized generation gives byte-equal table digests.
  3. S3 completes W1 and W2 inside 14 GiB of free disk.
- **Measurement.** `trickle.ts` and `w2.ts` at S2 on each filesystem, with `du` on the
  store after each batch, and an S3 run.
  On this VM the kernel lists btrfs and xfs but the `mkfs` tools are not installed, so
  the reflink measurement needs another machine or those packages.
- **Code.** The three copy sites, `src/fsinspect.ts` (a clone probe), and a new manifest
  writer beside `src/publication.ts`.

## 5. Comparisons

### 5.1 Plain SQLite in WAL Mode

| Property | Plain SQLite, WAL | fsqlite v2 |
| --- | --- | --- |
| Small write, single host | 0.7 to 1.8 ms durable at S2 size (A.10) | 2.4 to 3.9 s per cycle on ext4, about 1 s with clones, the WAL figure with the live head |
| Reads | baseline | equal (ratio 0.99 to 1.03) |
| Writers | one at a time on the live file; others wait on the lock | any number append or capture; one publisher at a time |
| Bulk import at S2 | 16.6 s, or 14.0 s with indexes after | 17.9 s today through DirectStore with the same DDL and loader; the indexes-after order becomes available with (e) |
| Shared and cloud paths | unsafe: WAL needs coherent locks and shared memory | the design target |
| Point-in-time artifact | a backup or `VACUUM INTO`, O(H) each | every generation |
| Schema change | ordinary DDL | derived rebuilds and migration steps in a build |
| Crash recovery | automatic | automatic with (h); manual lock removal today |
| Search and statistics | native | native with (e) |

For one process, or cooperating processes on one local disk that can queue, plain SQLite
in WAL mode is simpler and faster, and v2 does not change that.
v2 earns its cost when writers are independent processes in several languages, when the
path is shared, or when each published state must be an immutable file that can be
pinned, exported, and rolled forward from.

### 5.2 FalkorDB

Measured in the spike, with the corpus and query sets equal across arms:

| Workflow | FalkorDB | fsqlite today | fsqlite v2 expected |
| --- | --- | --- | --- |
| W1 at S2, ingest | 42 s, 5.07 GB loader and 1.70 GB server memory | 19.1 s, 0.49 GB | 14 to 17 s (Inferred from the control) |
| W1 at S3 | aborted by the memory guard | not run for disk | feasible with section 3.8 |
| W2, 1% and 20% batches at S2, incremental prototype | 1.9 s and 47 s visible, 2.7 to 3.1 s more to durable | 54.7 s and 52.1 s | about 4.6 s and 19.4 s, durable |
| W2 sustained, S1-r2 | 376 records per second, not durable | 2.63 at S1 | hundreds, durable per cycle |
| Conflicting writes | the later write wins; the loser is not recoverable | policy, loser recoverable | same, with bounded retention |
| W3 median p50 at S2-r2: table, record, search | 17.5, 0.66, 378 ms | 0.30, 0.036, 46.6 ms | same; search 1.7 to 6.6 ms through the in-file index |
| W3 hub neighborhood at S2-r2 | 329 ms | 256 ms | same, or about 20 times faster with the cache of section 5.3 |
| W3 slowest path at S2-r2 | 398 ms | 154 ms | same |
| Start-up at S2 | 20 s | 6 to 9 ms to open | same |
| Export | no file byte-identical; bodies lost | 228,873 of 228,876 byte-identical | same |

Sources: `spike/falkordb/README.md`, `fdb/S2/w2.json`, `fdb/S1-r2/w2.json`, and the
`w3.json` files of both arms at S2-r2.

FalkorDB’s advantage is the cost of a small change, which follows the change.
v2 does not match its 0.3 to 1.9 s for small batches on ext4, and passes it at the 20%
batch. FalkorDB’s atomic unit is one query and its durability waits for a snapshot, so
the comparison at equal guarantees is against its durable figure.
The expected graph advantage did not appear: with hubs growing to 24,428 edges, fsqlite
is faster in every category median and on the hub queries.

### 5.3 A Hybrid: An In-Memory Graph Cache Built From the Artifact

The one read that grows uncomfortably in SQLite is the multi-hop expansion through a
hub. A cache built from the generation answers it without a second system of record.
Measured at S2-r2 (A.5):

- Building a compressed adjacency from 238,957 entities and 1,155,758 edges takes 2.1 to
  2.3 s. The arrays are 10.4 MB; the id strings and map in this unoptimized probe bring
  the process to about 270 MiB.
- The two-hop neighborhood of the largest hub (degree 24,428, 121,316 nodes reached)
  takes 41 to 45 ms against 942 to 968 ms for the recursive SQL on the same connection,
  with the same first 200 results.
  For the second hub it is 28 ms against 546 to 565 ms.

The cache is keyed by generation number, rebuilt or patched from the manifest’s change
list, and discarded freely, so it adds no durability or consistency question.
It belongs in the knowledge-base layer or the server.
fsqlite’s contribution is a stable pin and a change list.
Against FalkorDB this hybrid keeps the artifact portable, keeps memory at rest
proportional to the edge list instead of the corpus, and is faster on the hub query that
a graph engine should win.
A derived degree column is a cheaper partial remedy inside SQL: a query can cap or skip
expansion through nodes above a degree threshold.

## Appendix A. Probes

All scripts and outputs are under `<scratch>/research-b/probes/`. Commands run from that
directory with `node --disable-warning=ExperimentalWarning`. `HEAD` is a
1,946,152,960-byte S2-r2 generation built with the spike’s `parse_kb.py` and `load.ts`,
and `WORK` is a private, synced copy of it.
Both were deleted after the runs to return the disk.

| Id | Command | Result |
| --- | --- | --- |
| A.1 | `p1_session_semantics.mjs` (`p1.out.json`) | A session over all tables records FTS5 shadow tables and `sqlite_stat1`. Per-table sessions record only their table. A base changeset applies to a target with an extra index, FTS5, statistics, and a trailing column. A changeset table that is missing, narrower, or keyed differently in the target is skipped with a success result. An insert captured on an empty schema applies as an upsert under `REPLACE`. A hydrated sparse capture applies with no conflict. The changeset reader in this script is the header and row parser cited in the text. |
| A.2 | `p2_fsqlite_behaviors.ts`, `p2b_analyze_hazard.ts` (`p2.out.json`, `p2b.out.json`), against an unmodified copy of `src/`; `PRAGMA compile_options` | The FTS5, DDL, and reopen errors as quoted in `spike/fsqlite/README.md`. `ANALYZE` in a SnapshotStore write yields a 239-byte envelope naming `sqlite_stat1`; reconcile reports 1 applied; the head has no `sqlite_stat1`. After a DirectStore `ANALYZE`, envelope statistics apply. Two envelopes with `ANALYZE`: `strict-conflict: DATA` and 1,500 of 2,000 rows under the default policy; both applied and stale statistics under `'*': 'lww'`. Compile options include `DEFAULT_CACHE_SIZE=-2000` and `MAX_ATTACHED=10`. |
| A.3 | `p3_io_breakdown.mjs HEAD tmp/p3` (`p3.out.json`, `p3.run2.json`) | Section 1.3. `COPYFILE_FICLONE_FORCE`: `ENOTSUP`. `cp --reflink=always`: `Operation not supported`. |
| A.4 | `p4_sparse_capture.mjs HEAD tmp` (`p4.run2.json`) | Totals 1.37 to 1.38 ms, 4.28 to 4.45 ms, 26.9 to 28.5 ms, and 925 to 1,028 ms for 1, 10, 100, and 2,500 records. Changeset 6.9 KB and patchset 3.5 KB for one record. Without the working database’s own indexes the 2,500-record case took 20.7 s. |
| A.5 | `p5_graph_cache.mjs HEAD` (`p5.run2.json`) | Section 5.3. |
| A.6 | `p6_shards.mjs HEAD tmp 8` (`p6.out.json`) | The ratios in (b). The eleventh ATTACH fails with `too many attached databases - max 10`. ATTACH of 8 shards and both views takes 0.8 ms. |
| A.7 | `p7_build_costs.mjs WORK A`, `p7f_insert_apply.mjs WORK` (`p7.run2.json`, `p7a.out.json`, `p7f.out.json`, `p7f.run2.json`) | 2,500 updated records (13.2 MB changeset): 96 to 125 ms with a 2 MB cache, 68 to 75 ms with 64 MiB or more. 12,000 new records with 72,000 edges (42 MB): 1.51 to 1.65 s, 1.10 to 1.17 s, and 0.82 to 0.91 s at 2 MB, 64 MiB, and 256 MiB. SHA-256 of the 42 MB changeset: 33 to 38 ms. The filtered-out second pass: 30 ms. |
| A.8 | `p7_build_costs.mjs WORK B`, `p11_plans_with_stats.mjs HEAD WORK` (`p7b.out.json`, `p7.run2.json`, `p11.out.json`) | The statistics figures in (e). Hub join for `org:github`: 5,441 ms without statistics, 6.6 ms with. Unfiltered view: 101 ms without, 94 ms with, 0.036 to 0.044 ms with `INDEXED BY`. |
| A.9 | `p7_build_costs.mjs WORK CD`, `p10_gate.mjs HEAD WORK`, `p8_derived_prototype.ts`, and the package tests run in `../pkg-v2` (`p7cd.out.json`, `p10.out.json`, `p8.out.json`, `pkg-v2.diff`) | The FTS5 and facet figures in (e). `quick_check` warm: 0.91 to 1.01 s without FTS5, 2.24 to 2.9 s with; the FTS5 table alone 1.27 to 1.42 s; cold 14.8 s and 18.7 s. Per-table warm checks: entity 377 ms, edge 305 ms, kb_line 150 ms, doc 130 ms, search_text 51 ms. Prototype: 84 changed lines; `node --test test/*.test.ts` gives 228 tests, 226 pass, 1 skipped, 1 fail (`gc refuses to delete when current differs from the version it validated`). |
| A.10 | `p7_build_costs.mjs WORK E` (`p7e.out.json`, `p7.run2.json`) | Durable commits of 1, 100, and 2,500 record upserts. Rollback journal, `FULL`: 4.4 to 6.0 ms, 29 to 34 ms, 535 to 570 ms, after a first write of 45 to 56 ms on each new connection. WAL, `FULL`: 0.7 to 1.8 ms, 16 to 18 ms, 476 to 518 ms. WAL, `NORMAL`: 0.6 to 1.5 ms, 14 to 20 ms, 527 to 582 ms. `wal_checkpoint(TRUNCATE)` of 43 MB: 31 to 38 ms. |
| A.11 | In `../spike-base/fsqlite` and `../spike-v2/fsqlite`, with `KB_SCRATCH=../kbscratch`: `w2.ts <S0 store> --scale S0 --deltas <S0 deltas> --strategy direct` (`gc-ab/`) | gc gave up after 3 attempts for 9, 9, and 10 of 20 writes with the current code, and 10, 10, and 11 in a second run; 0 of 20 in all six batches with the three-line pinned-gc change. gc after a write: p50 0.42 to 1.15 s against 0.19 to 0.31 s. Visibility was inside the noise of the loaded machine: 4.9 to 11.6 s against 2.7 to 3.8 s in the first run, 2.9 to 4.2 s against 3.3 to 4.7 s in the second. The `gc-ab/` files hold the second run; the first run’s files were overwritten. |
| A.12 | `p12_notfound_policy.mjs` (`p12.out.json`) | `ABORT` on `NOTFOUND` reproduces the quarantine. `OMIT` is accepted for `NOTFOUND` and also drops an update of a missing row. A changeset split by operation applies deletes with `OMIT` and still reports the update. A delete of a row another writer updated is a `DATA` conflict. `REPLACE` on `NOTFOUND` throws. |
| A.13 | `p13_closure.mjs WORK` (`p13.out.json`) | After 1,000 node deletes: a full referential scan finds 20,940 dangling edges in 636 ms; the incremental delete of the same edges takes 70 ms; none remain. |
| A.14 | `p9_envelope_append.mjs tmp` (`p9.out.json`) | A 7 KiB single-file envelope committed by link: 0.037 ms, or 0.41 ms with file and directory fsync. 600 KiB: 0.35 ms and 1.14 ms. |

A reflink measurement was not possible: `/proc/filesystems` lists btrfs and xfs, but no
`mkfs` tool for either is installed.

## Appendix B. Sources Read

- `docs/research/spikes/softschema-kb/WORKLOAD.md`
- The draft analysis `research-a/analysis.md`, sections 3, 5, and 6
- `spike/fsqlite/`: `README.md`, `run.sh`, `run_r2.sh`, `common.ts`, `mapping.ts`,
  `load.ts`, `fts.ts`, `migrate.ts`, `queries.ts`, `trickle.ts`, `w2.ts`,
  `w2_worker.ts`, `w3.ts`, `w6.ts`
- `results/` for S0, S1, S2, S3, S1-r2, and S2-r2, as recorded at 04:03 on 2026-11-17
- `spike/falkordb/README.md` and `fdb/` for S1, S2, S1-r2, and S2-r2
- `README.md`, `packages/fsqlite/README.md`, `docs/fsqlite-design.md`,
  `docs/fsql-format-spec.md`, `docs/roadmap.md`, `docs/qa-runbook.md`, and
  `docs/research/research-2026-08-01-schema-evolution-and-workload-fit.md`
- `packages/fsqlite/src/`: `snapshotStore.ts`, `directStore.ts`, `driver.ts`,
  `conflictPolicy.ts`, `publication.ts`, `lock.ts`, `fsutil.ts`, `types.ts`

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
