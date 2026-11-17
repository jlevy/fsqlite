# Softschema KB Spike: Quiet Re-measurement

**Date:** 2026-11-17

**Status:** Complete for the cells below.
This pass re-measures the headline numbers of [WORKLOAD.md](../../WORKLOAD.md) on the
round-2 corpora with one benchmark process at a time, for the research brief
`docs/research/research-2026-11-17-softschema-kb-storage.md`.

The earlier runs (round 2 and the three fsqlite v2 spikes) overlapped each other and the
FalkorDB benchmark, at load averages of 3 to 11 on 4 vCPUs, so their timings were taken
under CPU and disk contention.
This pass repeats the headline cells on the same VM and corpora, one process at a time,
and records the load around every run.

Each cell has its own file, `<arm>/<scale>/<workflow>.json`. It holds the machine, the
versions, each repetition’s load before and after, the 10 s load samples, the raw
timings and the compare result.
Repetitions that were discarded or superseded are listed with their reason.
`summary.json` has one row per cell and metric, with the median, min, max and n, and the
earlier contended figure where one exists.

## Method

**Machine.** One cloud VM: 4 vCPUs (Intel Xeon), 16 GB of RAM, ext4, Linux 6.18. Node
22.23.4 with SQLite 3.53.4; Python 3.13.18 with `sqlite3` 3.53.1 and PyYAML 6.0.3
(`CSafeLoader`); falkordblite 0.10.0 (Redis 8.6.2 with the FalkorDB 4.18.3 module,
`THREAD_COUNT` 4), falkordb 1.7.1, redis-py 8.1.0 and softschema 0.8.1, all from
paraverse’s lock. fsqlite builds use a 4,096-byte page, the rollback journal and a 256
MiB import cache; readers use a 64 MiB cache.
FalkorDB runs redislite’s default save rules (`900 1 / 300 100 / 60 200 / 15 1000`),
except in the saves-disabled cell.

**One process at a time.** A wrapper starts each run only when the 1-minute load average
is under 1.0. It records the load before and after the run, and every 10 s it samples
the load and the CPU used by processes outside the run.
A process belongs to the run when it carries the run’s environment marker, which every
child inherits. FalkorDBLite’s daemonized `redis-server` drops the environment, so a
`redis` process that appears during the run also counts as the run’s. A repetition is
discarded and rerun when the 1-minute load after it, or in any sample during it,
exceeded 1.5, and processes outside the run used more than 0.5 CPU in some 10 s
interval. The second condition exempts load the run makes itself: a 4-job parse, 4
writers with a reader, or the FalkorDB loader beside its server.
Phases ran back to back, so the load before most runs was 0.9 to 1.0, left over from the
run before.

**Disk.** Before every S2-r2 run the wrapper required the run’s estimated need plus 4 GB
free, and it recorded the lowest free space during the run (never under 4.25 GB).
Stores, RDB files and scratch copies were deleted once measured.

**Code.** Every arm ran from fresh scratch copies under `<scratch>/quiet/`; nothing
under `packages/`, the spike source directories or the existing results changed.

- fsqlite baseline (`f1.0`): copies of `packages/fsqlite` and of the spike’s `fsqlite/`,
  `harness/` and `corpus/`.
- v2 Spikes 1, 2 and 3: the same copies, with each spike’s `package.patch` and
  `spike.patch` applied and laid out as its README says.
  Every patch applied cleanly.
  The package test suites were not rerun.
- FalkorDB: the spike’s own `falkordb/` scripts, imported read-only and run in
  paraverse’s locked environment, with their outputs sent to the quiet directories.
- Additions, all in the scratch copies:
  - `--reuse-rows` and `--name` on `w1.ts`, as in Spike 1’s copy;
  - `--batches`, `--arms` and `--name` on the baseline `w2v2.ts`, as in Spike 2’s;
  - `--rows`, `--sizes`, `--skip-batches` and `--skip-sustained` on each `trickle.ts`;
  - a plain SQLite driver that calls `control.ts`’s `plainLoad` and `w3.ts`’s
    `runOnSnapshot`, one measurement per process;
  - a FalkorDB W3 driver that runs `w3_queries.measure` on the 124 compared instances,
    without the uncompared extras (RediSearch, in-engine paths, `algo.SPpaths`);
  - a FalkorDB W2 driver that calls `w2_v2.run_batch` for p05, and also compares the
    rebuilt graph’s W3 with the oracle.

**Inputs.** The S2-r2 and S1-r2 corpora and their `deltas/`. Each scale was parsed once
(`parse_kb.py --validate`, 4 jobs), and every fsqlite arm loaded those rows.
The trickle cells are new at S2-r2. Their records are the first 15,000 upserts of
S2-r2’s `p20` v2 batch, each `upsert` op with its rows through `parse_kb.py --delta2`,
plus the batch’s node rows.
The batch’s deletes and merges are left out, so each capture is one record.
At S1-r2 the same rule gives all 9,103 upserts of its `p20`.

**Repetitions.** At S2-r2 every cell ran 3 times, each repetition in its own process.
The exception is the one-record publish, which is 3 publishes in one process.
No repetition took more than 6 minutes; the longest, FalkorDB W2 p05, took 5.0 minutes.
S1-r2 ran the same cells once.
Tables give the median, with the min and max in parentheses when n is above 1.

**W3 aggregation.** For each repetition and category, the cell takes the median over the
category’s instances of the cold time, the warm p50 and the warm p95 (20 warm runs per
instance). `hub` is the median over the 4 hub instances (record, path, facet and
neighborhood), which are left out of their own categories.
`table` includes the deep page.
The cell then takes the median over the repetitions.
The brief’s tables count each hub instance in its category.
The earlier figures quoted here are recomputed from the earlier result files in the same
way as the new ones.

**Correctness.** Every W3 run was checked with
`harness/compare.py harness/expected/<scale>/w3.json <run>`. Every run after p05 was
checked against `harness/expected/<scale>-p05/w3.json`.

## Results at S2-r2

S2-r2 has 238,957 nodes, 1,155,758 edges and 224,802 record files; its largest hub has
degree 24,428.

### Parse

The Python parse with 4 jobs took 45.5 s with the schema check and 31.3 s without it
(earlier contended: 49.9 s with the check).
The check used 31.2 CPU-seconds over the 4 workers, so it adds 14.1 s of wall time,
which can be subtracted from any W1 figure that includes the parse.
Peak RSS was 579 MiB. The fsqlite figures below exclude the parse.
FalkorDB parses inside paraverse’s `load_kb`, in one process: 83 s of its 106 s
`read_kb`.

### W1, Ingest Through Durable

| Arm | n | Ingest through durable, s | In-process, s | Earlier contended, s | Peak memory |
| --- | --- | --- | --- | --- | --- |
| FalkorDB, paraverse as built, default save rules | 3 | 82.4 (81.0 to 86.1) | n/a | 85.6 (-4%) | loader 5.18 GB; server 1.74 GB (1.72 to 1.74), with forks 3.06 GB (2.88 to 3.11) |
| FalkorDB, saves disabled, one explicit `SAVE` | 3 | 83.7 (83.3 to 86.2) | n/a | 81.7 (+2%) | loader 5.18 GB; server 1.75 GB (1.74 to 1.76), with forks 1.75 GB (1.74 to 1.76) |
| fsqlite DirectStore | 3 | 24.1 (24.0 to 24.4) | 21.9 (21.4 to 22.2) | 22.3 (+8%) | 491 MiB (491 to 494) |
| fsqlite SnapshotStore | 3 | 59.2 (58.8 to 61.1) | 57.9 (57.7 to 60.0) | 57.4 (+3%) | 884 MiB (835 to 918) |
| Plain SQLite, indexes first | 3 | 19.8 (18.6 to 20.4) | 19.8 (18.6 to 20.4) | 19.0 (+4%) | 483 MiB (472 to 498) |
| Plain SQLite, indexes after (extra) | 1 | 16.0 | 16.0 | 14.9 (+8%) | 612 MiB |
| v2 Spike 1, DirectStore with the derived build | 3 | 28.4 (28.3 to 31.2) | 25.8 (24.5 to 26.9) | 31.0 (-8%) | 611 MiB (605 to 621) |

- **FalkorDB** ingest through durable is `load_graph` plus the explicit `SAVE`, without
  `load_kb`. From files, the default-rules load was servable after 185 s (179 to 198)
  and durable after 189 s; with saves off, 180 s and 184 s. The server peak with forks
  counts redislite’s BGSAVE children: 3.06 GB with the default rules against 1.75 GB
  with saves off.
- **fsqlite** is the import process’s wall time minus JSON decoding, as round 2 reported
  it. The in-process column also leaves out the process start and a warm `quick_check`
  that `load.ts` runs only to report it.
  In-process figures compare like for like with plain SQLite: DirectStore costs 11% more
  (21.9 against 19.8 s), mostly the publish (`quick_check`, `foreign_key_check`, fsync;
  3.4 s). After the import, `gc({ retain: 0 })` took 4.4 s, and the FTS5 sidecar build
  4.3 s.
- **SnapshotStore**: 36.3 s of its 59.2 s is the one reconcile, and 8.1 s is capture
  overhead (head copies and changesets).
- **v2 Spike 1** builds the derived objects after the rows: 12.3 s of apply, 10.6 s of
  derived build, 0.9 s of `ANALYZE` and a 2.9 s gate.
  It costs 4.3 s more than the baseline DirectStore, and needs no sidecar.
- Peak memory for the file backends is the import process’s RSS; the file’s pages live
  in the OS page cache.

### W3 v2

Warm p50, ms:

| Arm | n | table | record | search | path | facet | neighborhood | hub |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FalkorDB | 3 | 19.2 | 0.703 | 375 | 1.06 | 41.1 | 0.623 | 27.9 |
| fsqlite, substring scan | 3 | 0.238 | 0.034 | 48.8 | 0.130 | 18.4 | 0.216 | 9.48 |
| fsqlite, FTS5 sidecar | 3 | 0.252 | 0.034 | 2.02 | 0.154 | 18.6 | 0.205 | 9.52 |
| Plain SQLite | 3 | 0.238 | 0.034 | 49.2 | 0.127 | 18.8 | 0.205 | 9.48 |
| v2 Spike 1, in-file FTS5 and statistics | 3 | 0.233 | 0.030 | 1.40 | 0.112 | 18.1 | 0.189 | 9.28 |

Warm p95, ms:

| Arm | n | table | record | search | path | facet | neighborhood | hub |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FalkorDB | 3 | 24.5 | 0.878 | 420 | 1.18 | 51.3 | 0.749 | 31.5 |
| fsqlite, substring scan | 3 | 0.332 | 0.069 | 53.4 | 0.182 | 18.8 | 0.271 | 15.6 |
| fsqlite, FTS5 sidecar | 3 | 0.541 | 0.073 | 2.13 | 0.245 | 19.3 | 0.310 | 10.7 |
| Plain SQLite | 3 | 0.310 | 0.067 | 53.2 | 0.191 | 19.4 | 0.285 | 10.1 |
| v2 Spike 1, in-file FTS5 and statistics | 3 | 0.293 | 0.055 | 1.51 | 0.152 | 18.5 | 0.259 | 9.87 |

Cold, ms (the first run on a new connection after the file left the page cache; for
FalkorDB, the first run after the server started from the RDB, which took 12.9 s):

| Arm | n | table | record | search | path | facet | neighborhood | hub |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FalkorDB | 3 | 23.5 | 0.856 | 376 | 1.20 | 41.7 | 0.804 | 30.2 |
| fsqlite, substring scan | 3 | 6.71 | 2.14 | 603 | 5.33 | 75.6 | 4.04 | 56.8 |
| fsqlite, FTS5 sidecar | 3 | 7.30 | 2.07 | 17.5 | 6.80 | 67.0 | 4.62 | 52.1 |
| Plain SQLite | 3 | 6.94 | 1.78 | 590 | 6.04 | 68.3 | 4.91 | 55.3 |
| v2 Spike 1, in-file FTS5 and statistics | 3 | 3.97 | 1.81 | 12.9 | 3.59 | 35.2 | 3.36 | 29.9 |

- Typical record, path and neighborhood queries stay under 1.1 ms in every arm, while
  the scans (FalkorDB tables, every substring search, every facet) and the hubs grow
  with the corpus.
- fsqlite, its FTS5 variants and plain SQLite are within a few percent of each other
  warm, except search, where indexed search is 24 to 35 times faster than the scan.
- Spike 1’s in-file FTS5 index answers search in 1.40 ms against the sidecar’s 2.02 ms.
  Its cold runs are 15 to 53% below the baseline scan arm’s, by category; the cause was
  not isolated.

### W2 p05 (11,948 Operations)

| Arm | n | Capture and apply, or publish | Visible | Durable | Earlier contended visible |
| --- | --- | --- | --- | --- | --- |
| FalkorDB, rebuild (paraverse as built) | 3 | KB build 14.8 s (14.0 to 16.8); load 191 s (188 to 192) | 205 s (205 to 206) | 209 s | 217 s (-5%) |
| FalkorDB, incremental prototype | 3 | map 5.14 s (4.92 to 5.80) | 10.3 s (10.2 to 11.3) | 13.2 s (13.1 to 14.1) | 12.1 s (-15%) |
| fsqlite SnapshotStore, 1 writer | 3 | capture 7.37 s (6.76 to 7.38); reconcile 5.35 s (5.07 to 5.40) | 12.4 s (12.2 to 12.7) | = visible | 12.5 s (-1%) |
| fsqlite SnapshotStore, 4 writers, retry and closure | 3 | writers 37.0 s (36.5 to 42.8); reconcile 5.88 s (5.11 to 5.94); retry 4.00 s (3.94 to 4.66); closure 4.15 s (3.93 to 4.30) | 51.8 s (51.1 to 57.3) | = visible | 77.3 s (-33%) |
| v2 Spike 2, operation envelopes, 4 writers | 3 | writers 0.657 s (0.643 to 0.705); reconcile 7.16 s (6.50 to 7.28) | 7.96 s (7.18 to 7.99) | = visible | 10.4 s (-23%) |

- **Visibility** runs from the start of the update to a new reader seeing the new state.
  For fsqlite, publish is durable.
  For FalkorDB, durable adds an explicit `SAVE`. The rebuild also includes materializing
  the post-batch KB (the KB build, 14.8 s).
- **Correctness.** Every after-p05 state answered all 124 W3 queries like the oracle’s:
  the FalkorDB rebuild and the incremental prototype, fsqlite with 1 writer, fsqlite
  with 4 writers, and Spike 2. With 4 baseline writers, every repetition quarantined 1
  envelope (`NOTFOUND`). The retry publish and the closure publish then repaired it: the
  closure found 12 to 15 dangling edges and left 0, and the rows equalled one writer’s
  line order. Spike 2 quarantined nothing, needed one publish, left 0 dangling edges and
  equalled line order, in all 3 repetitions.
- **Readers** saw no error during the writes.
  The reader’s p95 was 86 to 94 ms with 4 baseline writers and 74 to 91 ms with Spike 2.
  Indexed search, through the rebuilt FTS5 sidecar, became visible after 56.5 s and 12.3
  s.

### One-Record Publish and Sustained Trickle

One-record publish (one v2 record per publish, median of 3 publishes in one process; gc
is `gc({ retain: 0 })` after each publish):

| Arm (3 publishes each) | Capture | Visible | gc after the publish | gc share of publish plus gc |
| --- | --- | --- | --- | --- |
| fsqlite baseline, SnapshotStore | 1,197 ms | 3,599 ms | 4,782 ms | 0.571 |
| fsqlite baseline, DirectStore | n/a | 2,775 ms | 5,119 ms | 0.645 |
| v2 Spike 2, operation envelope | 0.626 ms | 2,379 ms | 4,322 ms | 0.645 |
| v2 Spike 2, sparse changeset | 3.42 ms | 2,414 ms | 5,191 ms | 0.672 |
| v2 Spike 3, SnapshotStore | 1,404 ms | 3,994 ms | 673 ms | 0.166 |
| v2 Spike 3, DirectStore | n/a | 2,744 ms | 1,339 ms | 0.312 |

Sustained trickle, 60 s (one writer; the baseline and Spike 3 capture as fast as they
can, which is a closed loop; Spike 2 offers 200 records per second to `runPublisher`,
which folds everything pending into each build):

| Arm | n | Records per s | Visibility p50 | Visibility p95 | Reconcile or build | gc | gc share |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fsqlite baseline (closed loop) | 3 | 0.470 (0.460 to 0.500) | 10.1 s (9.43 to 10.7) | 16.1 s (14.4 to 18.1) | 3.72 s (2.93 to 4.67) | 5.60 s (5.56 to 5.69) | 0.605 (0.545 to 0.655) |
| v2 Spike 2 (offered 200 per s) | 3 | 175 (167 to 178) | 8.75 s (7.88 to 8.78) | 13.1 s (12.1 to 13.2) | 3.47 s (3.44 to 3.80) | 5.34 s (5.28 to 5.43) | 0.609 (0.581 to 0.610) |
| v2 Spike 3 (closed loop, gc collectOn quick) | 3 | 0.330 (0.330 to 0.360) | 9.16 s (8.83 to 9.49) | 12.2 s (11.2 to 13.4) | 3.23 s (3.18 to 3.81) | 1.83 s (1.41 to 1.85) | 0.328 (0.307 to 0.362) |

- “gc share” is gc over reconcile, or build, plus gc.
  For Spike 2, gc is 58% of the publish cycle measured between pointer swaps (9.3 s).
- Spike 2 published every captured record (11,910 in 60 s). Its visibility p95 of 13.1 s
  is 1.4 publish cycles.
  Its records per second is what it was offered, not a capacity.
- The baseline and Spike 3 rates are capacities of a closed loop.
  Each capture copies the 2 GB head, so they reach 28 to 30 and 20 to 22 records in 60
  s. Spike 3’s gc is 1.8 s, nearly all of it unlinking the superseded head, against 5.6
  s. But its capture median is 2.4 to 2.9 s against the baseline’s 1.5 to 1.6 s, so it
  captures fewer records, at a lower visibility p95. That the unlink slows the
  concurrent capture is inferred, not isolated.
- No earlier figure exists at S2-r2. At S2 (round 1) the earlier contended runs gave 0.6
  records per second (p95 22.1 s) for the baseline, and 172 per second (p95 13.0 s) for
  Spike 2.

### Sizes

| Artifact | Bytes | Notes |
| --- | --- | --- |
| FalkorDB RDB (default save rules) | 268 MiB |  |
| fsqlite head, DirectStore | 1,856 MiB | FTS5 sidecar 140 MiB |
| Plain SQLite file | 1,856 MiB |  |
| v2 Spike 1 head (derived objects inside) | 1,975 MiB | FTS5 116 MiB, facets 39.3 MiB |
| fsqlite SnapshotStore import store after gc | 3,048 MiB | 1.61 H |
| v2 Spike 3 SnapshotStore import store after gc | 1,893 MiB | 1.00 H (before gc 1.61 H) |
| v2 Spike 2 operation envelopes for p05 (20) | 58.4 MiB |  |

- The fsqlite head is 1.69 times the KB’s 1.15 GB of files, and the plain SQLite file is
  the same size.
- Spike 1’s head is 6.4% larger, with the FTS5 index and the facet summary inside.
  The baseline’s FTS5 sidecar is a separate 140 MiB file.
- The SnapshotStore import store keeps every applied envelope: 1.61 times the head after
  gc. Spike 3’s gc prunes them to 1.00 times the head.
- Spike 2’s 20 operation envelopes for p05 hold 58 MiB, 3.1% of the head.
- The FalkorDB RDB is 268 MiB, 14% of the fsqlite head, because paraverse stores no
  Markdown bodies, documents or search text.

## Slope From S1-r2 to S2-r2

S2-r2 has 5.09 times S1-r2’s nodes (238,957 against 46,927) and 5.12 times the head
bytes.

| Cell | Unit | S1-r2 (n = 1) | S2-r2 (median of 3) | Slope |
| --- | --- | --- | --- | --- |
| W1 FalkorDB default, ingest through durable | s | 13.3 | 82.4 | 6.18x |
| W1 FalkorDB saves off, ingest through durable | s | 14.5 | 83.7 | 5.77x |
| W1 fsqlite DirectStore | s | 4.14 | 24.1 | 5.81x |
| W1 fsqlite SnapshotStore | s | 10.8 | 59.2 | 5.48x |
| W1 plain SQLite | s | 3.80 | 19.8 | 5.21x |
| W1 Spike 1 | s | 5.31 | 28.4 | 5.35x |
| W3 FalkorDB search p50 | ms | 73.7 | 375 | 5.08x |
| W3 FalkorDB hub p50 | ms | 5.22 | 27.9 | 5.35x |
| W3 fsqlite scan search p50 | ms | 8.80 | 48.8 | 5.55x |
| W3 fsqlite scan hub p50 | ms | 1.92 | 9.48 | 4.92x |
| W3 fsqlite FTS sidecar search p50 | ms | 0.458 | 2.02 | 4.42x |
| W3 Spike 1 in-file FTS5 search p50 | ms | 0.426 | 1.40 | 3.27x |
| W3 FalkorDB facet p50 | ms | 7.27 | 41.1 | 5.65x |
| W3 fsqlite scan facet p50 | ms | 3.48 | 18.4 | 5.29x |
| W2 p05 FalkorDB rebuild, visible | s | 36.9 | 205 | 5.56x |
| W2 p05 FalkorDB incremental, visible | s | 1.53 | 10.3 | 6.69x |
| W2 p05 fsqlite 1 writer, visible | ms | 1,812 | 12,441 | 6.86x |
| W2 p05 fsqlite 4 writers, visible | ms | 6,587 | 51,838 | 7.87x |
| W2 p05 Spike 2 ops 4 writers, visible | ms | 1,982 | 7,958 | 4.02x |
| One-record publish, baseline SnapshotStore | ms | 800 | 3,599 | 4.50x |
| One-record publish, Spike 2 operation envelope | ms | 558 | 2,379 | 4.27x |
| One-record publish, Spike 3 SnapshotStore | ms | 833 | 3,994 | 4.79x |
| Sustained, baseline records per s | records per s | 2.46 | 0.470 | 0.19x |
| Sustained, Spike 2 records per s | records per s | 188 | 175 | 0.93x |
| Sustained, Spike 3 records per s | records per s | 1.97 | 0.330 | 0.17x |
| Head or RDB bytes, fsqlite DirectStore | bytes | 380,325,888 | 1,946,152,960 | 5.12x |
| Head or RDB bytes, FalkorDB | bytes | 55,217,433 | 281,515,331 | 5.10x |

- W1, scans, facets, hubs and the FalkorDB rebuild grow about linearly (4.4 to 6.2x).
  Spike 1’s in-file FTS5 search grows 3.3x.
- Visibility after p05 grows faster than the corpus for the baseline: 6.9x with 1
  writer, and 7.9x with 4 writers, which copy the head 4 at a time.
  FalkorDB’s incremental prototype grows 6.7x. Spike 2’s 4 writers grow 4.0x.
- The one-record publish grows 4.3 to 4.8x, with the head.
- The closed-loop trickle rate falls 5.2x (baseline) and 6.0x (Spike 3). Spike 2’s rate
  stays at what it was offered: at S1-r2 the writer ran out of records after 46 s, so
  S1-r2’s 188 per second is 9,103 records.

## Changes of More Than 30% From the Earlier Contended Figures

The headline metrics are W1 time and memory; W2 visible, writers and reconcile; and W3
cold, p50 and p95 per category.
Of the 276 with an earlier figure, recomputed in the same way, 250 are within 30% and
182 within 10%. These differ by more than 30%:

- **W2 p05, baseline 4 writers, S2-r2:** visible 51.8 s against 77.3 s (-33%). Inferred,
  not isolated: in the contended run the 4 concurrent head copies shared the disk with
  other jobs.
- **W2 p05, Spike 2 writers’ wall time:** 0.66 against 1.43 s (-54%) at S2-r2, and 0.40
  against 0.60 s (-34%) at S1-r2. These are 4 Node processes starting and appending.
  Visible is -23% at S2-r2.
- **Spike 1 W3, S2-r2:** cold times fell 38 to 94%: hub 29.9 against 487 ms, search 12.9
  against 54.7 ms, table, path and neighborhood 38 to 48%. The warm p95 fell 43 to 65%
  for search, table and hub.
  Warm p50 changed by at most 9%.
- **Spike 1 W3, S1-r2 (1 repetition):** table p50 0.118 against 0.084 ms (+41%), hub p50
  3.11 against 2.02 ms (+54%), neighborhood p95 +46%, table p95 +68%, and hub cold -80%.
- **Warm p95 tails at S2-r2:** FalkorDB table +37% (24.5 against 17.9 ms); fsqlite scan
  hub +63% (15.6 against 9.6 ms); fsqlite FTS table +64% (0.54 against 0.33 ms).
  Their p50s moved by +9%, +3% and +3%. These are the 19th of 20 warm runs, so single
  slow runs move them.
- **S1-r2, baseline and plain SQLite W3 (1 repetition):** hub p50 and p95 fell 42 to 46%
  (scan p50 1.92 against 3.32 ms); FTS record and path cold -39% and -33%; scan search
  cold +31%.
- **Parse, S1-r2:** 9.0 against 16.2 s (-44%); at S2-r2, -9%.

## Correctness

Every W3 run matched its oracle file.

- S2-r2, `expected/S2-r2`: FalkorDB, fsqlite scan, the fsqlite FTS5 sidecar, plain
  SQLite and Spike 1, 3 runs each: MATCH, 124 ok, 0 differ (15 of 15).
- S2-r2 after p05, `expected/S2-r2-p05`: the FalkorDB incremental prototype and the
  FalkorDB rebuild, fsqlite with 1 writer, fsqlite with 4 writers, and Spike 2, 3 runs
  each: 124 of 124 (15 of 15).
- S1-r2: the same 10 runs, once each: 124 of 124 (10 of 10).
- Superseded S2-r2 runs from the contaminated window also matched (7 of 7).
- Extra cells, against the oracle restricted to their category: the Python path runs
  matched 21 of 21, and the FalkorDB stored-lowercase search runs 20 of 20, at both
  scales. The paired query-time search returned the same results.

## Extra Cells: Review A’s Asymmetries

Review A (finding A8 and suggestion A16 on the PR) names two asymmetries that favor
SQLite and can be measured here.
Each was run as a separate labelled cell after the core cells
(`falkordb/<scale>/w3-search-stored-lowercase.json` and
`sqlite-control/<scale>/w3-path-python.json`).

- **Search.** SQLite scans `search_text`, which the load wrote with the three fields
  already lower-cased, while FalkorDB runs `toLower(...) CONTAINS` on three properties
  of every node at query time.
  On a copy of the W1 RDB, one write stored the three lower-cased properties (15.3 s at
  S2-r2 and 3.15 s at S1-r2), and the same 20 search instances then ran with `CONTAINS`
  on them. The query-time form ran paired in the same server session.
- **Client runtime.** W3 runs in Node for SQLite and in Python for FalkorDB. The shared
  path search (bidirectional BFS, one statement per frontier) was ported line for line
  to Python’s `sqlite3` and run on the plain SQLite file with the same SQL.

| Cell | n | Cold, ms | Warm p50, ms | Warm p95, ms |
| --- | --- | --- | --- | --- |
| FalkorDB search, query-time `toLower` (paired, same session), S2-r2 | 3 | n/a | 379 (375 to 381) | 428 (427 to 435) |
| FalkorDB search, stored lower-case properties, S2-r2 | 3 | 85.7 (84.9 to 87.0) | 85.4 (85.0 to 86.5) | 101 (98.3 to 102) |
| SQLite scan of the pre-lowercased `search_text` (plain SQLite W3), S2-r2 | 3 | 590 (588 to 598) | 49.2 (48.1 to 49.3) | 53.2 (51.5 to 55.7) |
| Path, Node `node:sqlite` (plain SQLite W3), S2-r2 | 3 | 6.04 (5.26 to 7.38) | 0.127 (0.126 to 0.147) | 0.191 (0.171 to 0.237) |
| Path, Python `sqlite3`, same file and SQL, S2-r2 | 3 | 5.96 (4.69 to 6.43) | 0.114 (0.114 to 0.115) | 0.161 (0.160 to 0.166) |
| Path hub instance (`v2.path.hub`), Node, S2-r2 | 3 | 7.98 | 0.129 | 0.177 |
| Path hub instance (`v2.path.hub`), Python, S2-r2 | 3 | 8.29 (5.66 to 8.36) | 0.125 (0.123 to 0.126) | 0.163 (0.159 to 0.175) |
| FalkorDB search, query-time `toLower` (paired, same session), S1-r2 | 1 | n/a | 77.1 | 95.7 |
| FalkorDB search, stored lower-case properties, S1-r2 | 1 | 18.6 | 17.6 | 20.4 |
| SQLite scan of the pre-lowercased `search_text` (plain SQLite W3), S1-r2 | 1 | 117 | 8.85 | 9.80 |
| Path, Node `node:sqlite` (plain SQLite W3), S1-r2 | 1 | 4.65 | 0.118 | 0.160 |
| Path, Python `sqlite3`, same file and SQL, S1-r2 | 1 | 4.59 | 0.113 | 0.148 |
| Path hub instance (`v2.path.hub`), Node, S1-r2 | 1 | 6.78 | 0.124 | 0.154 |
| Path hub instance (`v2.path.hub`), Python, S1-r2 | 1 | 7.15 | 0.121 | 0.173 |

- **S2-r2.** Stored lower-case properties cut FalkorDB’s search p50 from 379 to 85.4 ms
  (4.4 times faster); the SQLite scan stays 1.7 times faster than that (49.2 ms).
  The shared path search takes 0.114 ms warm from Python against 0.127 ms from Node
  (0.90 times), and 5.96 against 6.04 ms cold.
- **S1-r2.** Stored lower-case properties cut FalkorDB’s search p50 from 77.1 to 17.6 ms
  (4.4 times faster); the SQLite scan stays 2.0 times faster than that (8.85 ms).
  The shared path search takes 0.113 ms warm from Python against 0.118 ms from Node
  (0.95 times), and 4.59 against 4.65 ms cold.

So query-time lower-casing is about 77% of FalkorDB’s scan search at S2-r2 (379 against
85 ms), and the rest of the gap to SQLite is the engine.
The client runtime explains none of the path gap: Python’s `sqlite3` runs the same BFS
as fast as Node, while FalkorDB’s path p50 is 1.06 ms against SQLite’s 0.127 ms.
The page-cache residency that A8 also names (`fincore`) was not measured; `fincore` is
not installed on this VM.

## Deviations

- **Contaminated window.** The coordinator reported a review agent holding one core from
  about 06:48 to 06:50 UTC, with shorter jobs until about 07:06. Twelve repetitions that
  overlapped 06:45 to 07:10 UTC were rerun and their results replaced:
  - baseline W3 plain SQLite repetitions 2 and 3;
  - W2 p05 with 1 writer, repetitions 1 and 2;
  - the one-record publish;
  - the 3 sustained trickles;
  - the 3 W2 p05 runs with 4 writers;
  - Spike 1 W1, repetition 1.

  One overlapping repetition, W2 p05 with 1 writer, repetition 3, stayed: its load
  stayed under 1.0 throughout.
  The wrapper saw no foreign CPU above 0.15 in any of the 13 repetitions, and CPU steal
  was negligible, so the agent’s work either fell between runs or was not visible in
  this VM’s process table.
  The superseded runs are kept under `superseded_runs` in their cell files.

- **Discarded repetitions** (foreign CPU above 0.5 while the load exceeded 1.5), each
  rerun:
  - S1-r2 Spike 3 `trickle-sustained` repetition 1 at 08:56 UTC: load 2.36, foreign CPU
    0.80 (a `python3` process).
  - S2-r2 fsqlite `w1-direct` repetition 1 at 06:18 UTC: load 2.05, foreign CPU 0.70 (a
    `node` process).
  - S2-r2 fsqlite `w1-snapshot` repetition 3 at 06:25 UTC: load 1.59, foreign CPU 1.97
    (a `python` process).
  - S2-r2 fsqlite `w1-snapshot` repetition 3 at 06:28 UTC: load 1.86, foreign CPU 0.76
    (a `node` process).
  - S2-r2 FalkorDB `w1-nosave` repetition 2 at 07:45 UTC: load 1.63, foreign CPU 1.03 (a
    `python3` process).

- **Kept with foreign bursts.** Some kept repetitions had foreign CPU above 0.5 in one
  sample while the load stayed at or under 1.5, so the rule kept them.
  The cell files record each sample.
  Where the cell has one headline time, it is shown against the other repetitions:
  - S1-r2 Spike 2 `trickle-one` repetition 1: foreign CPU 0.73 in one sample, load at
    most 0.99.
  - S1-r2 Spike 2 `trickle-sustained` repetition 1: foreign CPU 0.63 in one sample, load
    at most 1.08.
  - S2-r2 fsqlite `w1-plain-first` repetition 2: foreign CPU 0.51 in one sample, load at
    most 1.35; 20.4 s against 19.8, 18.6 s for the other repetitions.
  - S2-r2 fsqlite `w1-plain-first` repetition 3: foreign CPU 0.70 in one sample, load at
    most 1.39; 18.6 s against 19.8, 20.4 s for the other repetitions.
  - S2-r2 fsqlite `w1-snapshot` repetition 3: foreign CPU 1.87 in one sample, load at
    most 1.38; 59.2 s against 61.1, 58.8 s for the other repetitions.
  - S2-r2 FalkorDB `w1-default` repetition 2: foreign CPU 1.02 in one sample, load at
    most 1.08; 81.0 s against 86.1, 82.4 s for the other repetitions.
  - S2-r2 FalkorDB `w1-nosave` repetition 1: foreign CPU 0.82 in one sample, load at
    most 1.35; 83.3 s against 83.7, 86.2 s for the other repetitions.

- **FalkorDB’s server counted as foreign.** Until 07:39 UTC the wrapper counted the
  daemonized `redis-server` as foreign CPU. That affected FalkorDB W1 with default
  rules, repetitions 1 and 2, whose load stayed at 1.1, so the verdict is unchanged.
  The wrapper was then fixed.

- **Setup failures, not measurements.** The first FalkorDB attempt failed to start
  `redis-server`: the scratch `TMPDIR` made its Unix socket path too long.
  It ran again with `<scratch>/tmp`, as the FalkorDB README sets it.
  The first extras attempt failed because the plain SQLite file’s directory had been
  deleted.

- **Disk.** The first S2-r2 4-writer attempt was refused by the disk check with an
  over-estimate: it needed 11 + 4 GB, with 13.0 GB free.
  Its measured peak was 8.75 GB, and it ran with an 8.5 GB estimate.
  The reruns found 12.3 GB free and were refused again.
  They ran after the store was rebuilt and the 1.37 GB parsed rows were deleted, at
  08:40 to 08:48 UTC, after S1-r2 had started.
  The lowest free space was 4.72 GB.

- **Store rebuilds.** As unmeasured setup, the S2-r2 baseline store was rebuilt 3 times
  (the 4-writer cell, the reruns, the 4-writer reruns), the plain SQLite file twice at
  S2-r2 and once at S1-r2 (the reruns and the extras), and the S2-r2 rows were parsed
  again for the extras.
  Spike 2’s and Spike 3’s base stores were built once each, also as setup; their records
  are in `w1-direct-setup.json`.

- **Scope.** FalkorDB W3 ran without its uncompared extras.
  Spike 1’s W3 used live facets, without `--facet-summary`. Spike 3’s SnapshotStore
  import ran once at S2-r2. The plain SQLite indexes-after import ran once per scale.
  Spike 3’s trickle used `collectOn: 'quick'` with `verifyMaxAgeMs` of 1 hour, after one
  full scrub (3.8 s), as its S2 run did.

- **Trickle input.** There was no S2-r2 trickle before.
  This pass used v2 upserts from `p20` (see Inputs) through new `--rows` flags in each
  copy’s `trickle.ts`.

- **Background processes.** A disk-guard loop and three `tail -F` processes from the
  earlier spike agents ran throughout; together they used under 0.01 CPU. The OS page
  cache was not dropped between runs.
  W3 cold runs evict their own files.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
