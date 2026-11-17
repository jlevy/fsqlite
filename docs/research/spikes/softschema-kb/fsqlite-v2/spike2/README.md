# fsqlite v2 Spike 2: Cheap Capture and Serial Apply

**Date:** 2026-11-17

**Status:** Prototype and measurement for the maintainer.
It tests Spike 2 of the fsqlite v2 design (the redesign analysis for
`docs/research/research-2026-11-17-softschema-kb-storage.md`, section 4): operation
envelopes applied by a serial reducer (k), sparse-seed changeset capture (l), a declared
missing-row policy with changeset admission (n), and a coalescing publisher (d).
Nothing here is merged into `packages/fsqlite`.
The changes live in two patches beside this file, and the numbers in
`../../results/fsqlite-v2/spike2/<scale>/`.

## Summary

Operation envelopes with a serial reducer remove both the capture cost and the concurrency
errors of round 2. Four writers that append delta-v2 operations become visible after
{S1R2_P05} s at S1-r2 and {S2R2_P05} s at S2-r2 for the 5% batch, against 7.0 s and 77.3 s
in round 2, with no quarantine, no retry, and one publish. In every run the published rows
equal one writer’s line-order rows, and W3 answers 124 of 124 after p05 at both scales.
That needs the deletes and merges kept as base facts, or a closure in the build: without
either, the same envelopes leave 3 and 51 dangling edges at S1-r2 p05 and p20, because
envelope order is not line order.

The declared missing-row policy separates round 2’s two causes. With idempotent deletes,
changeset envelopes are never quarantined for `NOTFOUND`, and the dangling edges remain until
a closure runs. The closure removes them, but a stale changeset can still carry a row that no
rule recognizes: one extra edge remains at S1-r2 p20.

Capture stops depending on the head. At S2, a one-record capture takes {H1_SPARSE1} ms as a
sparse changeset and {H1_OPS1} ms as an operation envelope, against 1.09 to 1.16 s, and 100
records take {H1_SPARSE100} and {H1_OPS100} ms. The publish itself is unchanged on ext4, so
one record is still visible only after a full build of {S2_VISIBLE} s.

The coalescing publisher turns that fixed cost into a per-cycle cost: one writer offering 200
records per second at S2 has all of them published, {H5_RATE} per second, with a visibility
p95 of {H5_P95} s, which is {H5_CYCLES} publish cycles, against 0.6 records per second and
22.1 s in round 1. gc’s integrity check after each publish is {GC_SHARE} of the cycle.

All timings are under heavy contention from other agents (load average 5 to 11 on 4 vCPUs).

## Hypotheses

| # | Hypothesis (design section 4) | Outcome | Numbers |
| --- | --- | --- | --- |
| 1 | Capture p50 at S2 is at most 5 ms for one record and 50 ms for 100, against 1.09 to 1.16 s | H1_OUTCOME | H1_NUMBERS |
| 2 | Four writers reach visibility within 1.5 times the one-writer DirectStore time at S1-r2 and S2-r2, against 4.7 to 10.2 times | Confirmed against this session’s DirectStore, mixed against round 2’s; needs the quiet pass | Four-writer visible ÷ one-writer DirectStore measured in the same session: 1.15, 0.94, 1.33 at S1-r2 and 1.42, 0.69, 0.81 at S2-r2 (p01, p05, p20). Against round 2’s quieter DirectStore times: 2.03, 1.41, 1.57 and 1.36, 1.11, 1.54. Round 2’s four writers were 4.3 to 10.2 times DirectStore; visible time fell from 5.8 to 1.5 s, 7.0 to 1.9 s, 13.5 to 4.9 s at S1-r2 and from 46.4 to 6.2 s, 77.3 to 10.4 s, 91.9 to 29.8 s at S2-r2 |
| 3 | With operation envelopes, no envelope is quarantined and no retry publish is needed; with tombstones and closure in the same build, the four-writer rows equal the line-order rows and W3 answers 124 of 124 after one publish | Confirmed | `ops`, 3 runs per batch at S1-r2 and 2 at S2-r2: 0 quarantined, no retry, one publish, rows equal line order in all 15 runs, 0 dangling edges, W3 124 of 124 after p05 at both scales. The closure ran in the build for 0.2 to 8 ms (it found nothing, because the reducer resolves endpoints through the stored facts), against 0.3 to 1.0 s and 6.6 to 7.3 s for round 2’s closure publish. Without facts or closure (`ops-naive`), 3 and 51 dangling edges at S1-r2 p05 and p20, and 123 of 124 |
| 4 | With changeset envelopes and `missingDelete: 'ignore'`, no envelope is quarantined for `NOTFOUND`, and the dangling edges remain until closure runs | Confirmed at S1-r2; S2R2_H4_STATUS | At S1-r2, sparse and full-copy changesets with `missingDelete: 'ignore'`: 0 quarantined in 6 runs (round 2: 2 at p20, `NOTFOUND`), 6 missing deletes omitted at p20, and 0, 5, and 105 dangling edges after the publish (round 2: 0, 5, 66 before its repair). Sparse and full capture reached identical digests. With the closure in the build: 0 dangling, rows equal at p01 and p05, one extra edge at p20 (a stale merge’s re-insert). S2R2_H4_NUMBERS |
| 5 | The sustained trickle at S2 exceeds 100 records per second with a visibility p95 under two publish cycles | H5_OUTCOME | H5_NUMBERS |

## What Changed

### The Package (`package.patch`)

The patch is against `packages/fsqlite`. It adds about 990 lines of source, including a
170-line changeset reader, and a 460-line test file, and removes 30. With no new option in
use the `f1.0` behavior is unchanged, and every existing test passes.

- **Operation envelopes (k).** `SnapshotStore.append(writerId, reducer, payload, {
  durable })` writes one file, `tx/pending/<txid>.env`: a JSON header line (store id,
  format, schema hash, reducer name and version, payload digest) and then the payload.
  It is written under a temporary name and committed by a no-replace hard link, with a
  file and directory fsync when `durable` is set.
  No SQLite session and no head copy is involved.
  The store option `reducers: { name: { version, apply(db, payload, ctx) } }` registers
  the code that folds them.
  Reconcile applies every pending envelope in id order, whatever its kind: an operation
  envelope runs its reducer inside its own transaction together with its ledger row, so
  the exactly-once ledger is unchanged.
  Admission refuses an unknown reducer, a reducer version mismatch, and a digest, store,
  format, or schema mismatch.
  A reducer that throws rolls back and quarantines only its envelope.
  While a reducer runs, TEMP triggers guard `applied_tx` and `fsqlite_meta`, and the
  callback boundary check refuses schema changes.
  `ctx.build` is state shared by the envelopes of one build, for prepared statements and
  caches; it is cleared whenever an envelope rolls back.
  Each build stamps `reducer.<name>` with the version it applied in `fsqlite_meta`.
- **Sparse-seed capture (l).** `write(writerId, fn, { seed: 'sparse', hydrate })` gives
  the callback an in-memory database that holds the schema only, with the head attached
  read-only and immutable as `head`. `hydrate(db, copy)` runs before the session starts;
  `copy(table, where, ...params)` copies matching head rows into the working database.
  The changeset is the same as a full copy’s for hydrated rows (tested).
  Foreign keys are not enforced in the working database, since hydrated rows usually
  lack their parents; reconcile’s `foreign_key_check` enforces them on the full build.
- **Missing-row policy and admission (n).** A table policy may be `{ conflict,
  missingDelete, missingUpdate }`, each missing setting `ignore` or `quarantine`; the
  default stays `quarantine`, which is `f1.0`.
  When some table ignores a missing row, apply splits the changeset by operation
  (`src/changeset.ts`) and answers `NOTFOUND` with `OMIT` only in the
  delete or update pass of those tables, so an update of a missing row is still reported
  where only deletes are idempotent. `ReconcileResult.omittedMissing` counts the omitted
  operations.
  Before applying a changeset, reconcile reads its table headers and quarantines an
  envelope that names a table the store lacks or with another column count or primary
  key, where SQLite would skip that table and report success.
- **Coalescing publisher (d).** `runPublisher({ until, minIntervalMs, intervalFactor,
  maxDelayMs, maxPendingBytes, afterPublish })` loops: it folds everything pending into
  one build per round, waits between rounds as configured, and runs `afterPublish` (gc in
  the measured runs) after each publish.
- **A minimal closure hook.** `closure(db, info)` runs inside every build after the
  envelopes and before the gate, in its own transaction; a failure publishes nothing.
  Spike 1 builds the general derived and closure hooks; this one exists so that
  hypothesis 3 can run closure in the same build, and it is the only part of this patch
  that overlaps Spike 1.
- **Reporting.** `ReconcileResult` gains `appliedTxIds`, `quarantineReasons`,
  `omittedMissing`, `closure`, and per-step `timings` (copy, apply, closure, gate,
  fsync, commit, settle), which the measurements read.

### The Spike Harness (`spike.patch`)

The patch is against `docs/research/spikes/softschema-kb/fsqlite/`.

- **Base facts in the mapping** (design section 3.6). Two tables join the generic DDL:
  `kb_tombstone (id, path)`, written by a v2 delete for each node, and `kb_redirect
  (absorbed, survivor, absorbed_path, survivor_path)`, written by a merge.
  An upsert clears its own ids from both. `GenericLoader` gains a `facts` mode that
  starts from the stored tombstones and redirects, so an edge applied after the delete or
  merge of its endpoint resolves the same way as in line order.
  The DDL change gives a new schema hash, so every base store was rebuilt with W1.
- **`v2.ts`.** The `kb-delta` reducer (version 2) applies an envelope’s intermediate rows
  through one facts-mode loader per build.
  `kb-delta-naive` (version 1) is the ablation: a fresh loader per envelope, without base
  facts. `kbClosure` removes edges incident to tombstoned ids and replays every stored
  redirect as a merge, which moves edges still incident to an absorbed id to its survivor;
  it counts those edges before and after, through index lookups on the fact tables.
  `hydrateRows` is the sparse-capture plan for the same rows.
  The store options come from `KB_V2_MISSING` and `KB_V2_CLOSURE`, so every process of a
  run opens the store the same way.
- **Writers** (`w2_worker.ts`). Strategies `sparse`, `ops`, and `ops-naive` beside
  `snapshot` and `direct`. An operation envelope carries the unit rows and the batch node
  rows they reference. The trickle writer takes a strategy and an offered rate, and a
  `publisher` role runs `runPublisher` with `gc({ retain: 0 })` after each publish.
- **`w2.ts`.** `--strategy`, `--variant`, `--batches`, and `--reps`. Round 2’s recovery
  steps (retry of quarantined envelopes and a closure envelope) run only with `--repair`,
  so each run reports the state after its one reconcile.
  The line-order reference is one DirectStore write of the whole batch through one
  loader, as round 2 validated against the oracle.
  The run counts dangling edges on the published head with a full referential scan, and
  the row digest covers the two fact tables.
- **`w2v2.ts`.** An `Append` arm (the whole batch as one operation envelope), `--arms`,
  `--batches`, `--batch-reps`, and the FTS5 sidecar and gc made optional.
- **`trickle.ts`.** `Sparse` and `Ops` capture arms beside `SnapshotStore`, and the
  sustained run through `runPublisher` at an offered rate.
- `run_spike2.sh` runs one scale, `summary_spike2.py` prints the tables below,
  `common.ts` takes the results directory from `KB_RESULTS_ARM`, and `fsq.ts` points at
  the package copy.

## How to Reproduce

The runs used scratch copies, as the design’s Appendix A.11 describes.

```bash
SCRATCH=<scratch dir>                       # holds kb-corpora/ (or a link to it)
cp -a packages/fsqlite $SCRATCH/pkg && (cd $SCRATCH/pkg && patch -p1 < <this dir>/package.patch)
mkdir -p $SCRATCH/spike && cp -a docs/research/spikes/softschema-kb/{fsqlite,harness} $SCRATCH/spike/
(cd $SCRATCH/spike/fsqlite && patch -p1 < <this dir>/spike.patch)   # fsq.ts then imports ../../pkg
export KB_SCRATCH=$SCRATCH/kbscratch KB_RESULTS_ARM=fsqlite-v2/spike2
cd $SCRATCH/spike/fsqlite
node --disable-warning=ExperimentalWarning w1.ts --scale S1-r2 --routes direct --validate
FULL_CAPTURE=1 ./run_spike2.sh S1-r2 3      # four writers, then one writer in line order
node --disable-warning=ExperimentalWarning w1.ts --scale S1 --routes direct
./run_spike2.sh S1 3                         # trickle captures, then sustained
python3 summary_spike2.py S1-r2 S1
(cd $SCRATCH/pkg && node --test test/*.test.ts)
```

S2-r2 and S2 run the same way, one scale at a time, with `REPS` and the variants listed
in [Measurement Notes](#measurement-notes).

## Results

Every timing below was taken while the Spike 1 and Spike 3 agents and the FalkorDB S2-r2
benchmark shared the 4 vCPUs and the disk: the load average was 5 to 11 during the runs,
and one S1-r2 reconcile spent 7.0 s in a `quick_check` that normally takes 0.2 s. Medians
carry their run counts, and a later quiet pass should re-measure the headlines.
The one-writer DirectStore reference was measured again in the same session, under the same
contention, and the ratios use it; round 2’s recorded DirectStore times, from a quieter
machine, are given beside it.

### Four Writers on v2 Batches (H2, H3, H4)

Each batch starts from a hard-linked clone of the W1 store.
Four writer processes split the batch by operation, round-robin, into 5 envelopes each,
while a reader process runs the W3 v2 queries; then one reconcile publishes.
“Visible” runs from spawning the writers to the reader serving the new head, as in round 2.

**Operation envelopes, the facts reducer, and the closure in the build (`ops`):**

| S1-r2 batch | Operations | Runs | Visible ms | Writers ms | Reconcile ms | One writer, DirectStore ms (runs) | Ratio | One writer, one envelope ms | Round 2, four writers ms | Round 2, DirectStore ms | Ratio to round 2’s DirectStore |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| p01 | 469 | 3 | 1,483 (1,135 to 1,635) | 662 | 693 | 1,295 (969 to 1,390) (3) | 1.15 | 959 (851 to 1,087) | 5,796 | 732 | 2.03 |
| p05 | 2,346 | 3 | 1,945 (1,885 to 2,288) | 603 | 1,372 | 2,076 (1,991 to 2,122) (3) | 0.94 | 1,290 (1,070 to 1,291) | 7,013 | 1,376 | 1.41 |
| p20 | 9,385 | 3 | 4,896 (4,126 to 6,411) | 1,108 | 3,694 | 3,687 (3,623 to 3,706) (3) | 1.33 | 3,014 (2,991 to 3,924) | 13,478 | 3,111 | 1.57 |

| S2-r2 batch | Operations | Runs | Visible ms | Writers ms | Reconcile ms | One writer, DirectStore ms (runs) | Ratio | One writer, one envelope ms | Round 2, four writers ms | Round 2, DirectStore ms | Ratio to round 2’s DirectStore |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| p01 | 2,390 | 2 | 6,188 (5,420 to 6,956) | 537 | 5,608 | 4,368 (4,234 to 4,502) (2) | 1.42 | 3,607 (2,947 to 4,267) | 46,361 | 4,559 | 1.36 |
| p05 | 11,948 | 2 | 10,392 (8,880 to 11,905) | 1,430 | 8,878 | 14,962 (10,839 to 19,085) (2) | 0.69 | 12,362 (9,713 to 15,010) | 77,344 | 9,336 | 1.11 |
| p20 | 47,791 | 2 | 29,824 (25,147 to 34,500) | 2,736 | 27,065 | 36,854 (35,996 to 37,712) (2) | 0.81 | 50,167 (23,826 to 76,508) | 91,865 | 19,381 | 1.54 |

The four-writer time is the writers’ wall time (process start, reading the rows, 5
appends each) plus one reconcile, which costs about what the one-writer DirectStore write
costs: a head copy, the apply, `quick_check`, and an fsync.
The serial reducer applied in line order as one envelope (`Append`) was faster than
DirectStore for the same rows in every run. Inferred, not isolated: the build runs with
`synchronous = OFF` until its one publish fsync, where DirectStore commits its rollback
journal and the database with `FULL` before the same fsync.

**Correctness, every variant.** “Dangling” is a full referential scan of the published head.
“Rows” compares the entity, edge (as a multiset without ordinals), document, search,
quarantine, tombstone, and redirect digests with one DirectStore write of the whole batch in
line order.

| Scale | Variant | Runs | Quarantined | Retry publishes | Missing deletes omitted | Closure removed, moved | Dangling, p01 / p05 / p20 | Rows equal line order, p01 / p05 / p20 | W3 after p05 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1-r2 | round 2: full-copy changesets, `f1.0` policy, then repair | 1 | 0 / 0 / 2 | 1 retry and 3 closure publishes | n/a | n/a | 0 / 5 / 66 before repair | equal after repair | 124 of 124 after repair |
| S1-r2 | operation envelopes, facts reducer, closure | 3 | 0 | none (1 publish) | 0 / 0 / 0 | 0+0 / 0+0 / 0+0 | 0 / 0 / 0 | yes / yes / yes | 124 ok, 0 differ |
| S1-r2 | operation envelopes, reducer without facts, no closure (ablation) | 1 | 0 | none (1 publish) | 0 / 0 / 0 | - / - / - | 0 / 3 / 51 | yes / no / no | 123 ok, 1 differ |
| S1-r2 | the same with the closure | 1 | 0 | none (1 publish) | 0 / 0 / 0 | 0+0 / 3+0 / 16+6 | 0 / 0 / 0 | yes / yes / yes | 124 ok, 0 differ |
| S1-r2 | sparse changesets, `missingDelete: ignore`, no closure | 1 | 0 | none (1 publish) | 0 / 0 / 6 | - / - / - | 0 / 5 / 105 | yes / no / no | 124 ok, 0 differ |
| S1-r2 | full-copy changesets, `missingDelete: ignore`, no closure | 1 | 0 | none (1 publish) | 0 / 0 / 6 | - / - / - | 0 / 5 / 105 | yes / no / no | 124 ok, 0 differ |
| S1-r2 | sparse changesets, `missingDelete: ignore`, closure | 1 | 0 | none (1 publish) | 0 / 0 / 6 | 0+0 / 4+1 / 74+31 | 0 / 0 / 0 | yes / yes / no | 124 ok, 0 differ |
| S2-r2 | round 2: full-copy changesets, `f1.0` policy, then repair | 1 | 0 / 1 / 3 | 2 retry and 3 closure publishes | n/a | n/a | 0 / 12 / 138 before repair | equal after repair | 124 of 124 after repair |
| S2-r2 | operation envelopes, facts reducer, closure | 2 | 0 | none (1 publish) | 0 / 0 / 0 | 0+0 / 0+0 / 0+0 | 0 / 0 / 0 | yes / yes / yes | 124 ok, 0 differ |
| S2-r2 | operation envelopes, reducer without facts, no closure (ablation) | 1 | 0 | none (1 publish) | 0 / 0 / 0 | - / - / - | 0 / 1 / 70 | yes / no / no | 124 ok, 0 differ |
| S2-r2 | the same with the closure | 1 | 0 | none (1 publish) | 0 / 0 / 0 | 0+0 / 4+1 / 29+24 | 0 / 0 / 0 | yes / yes / yes | 124 ok, 0 differ |

- **Operation envelopes need the base facts or the closure.** The ablation reducer
  (`ops-naive`), a fresh loader per envelope, has no quarantine and needs no retry, but
  envelope order is not line order: one writer’s last envelope, with its deletes and merges,
  lands before another writer’s upserts that reference those nodes.
  It leaves 3 and 51 dangling edges at S1-r2 p05 and p20, and 1 and 70 at S2-r2, and W3
  answers 123 of 124 after S1-r2 p05.
  With the closure in the same build (`ops-naive-closure`), or with the facts reducer that
  resolves endpoints through the stored tombstones and redirects as it applies (`ops`), the
  rows equal the line-order rows.
- **Changeset envelopes with idempotent deletes** (`sparse-missingdelete`, and
  `full-missingdelete` with round 2’s full-copy capture) are never quarantined:
  `missingDelete: 'ignore'` omitted the 6 missing deletes of S1-r2 p20, where round 2
  quarantined 2 envelopes. The dangling edges stay (5 and 105 at S1-r2), exactly as in round
  2 before its closure envelope. Sparse and full capture reached identical digests.
- **The closure fixes the dangling edges of changeset envelopes, but not all of the
  state.** With it (`sparse-missingdelete-closure`), p01 and p05 equal line order, and p20
  has no dangling edge but one extra edge. In the base, `session:2025/1956-r8` mentions
  `org:cathay-pacific-r8`. One writer’s upsert of the session drops that mention.
  Another writer’s merge of `org:cathay-pacific-r8` into `org:cathay-pacific-r5`, captured
  on the old head, deletes the same row and re-inserts it on the survivor.
  The duplicate delete is ignored, and the re-inserted edge has two live endpoints, so no
  tombstone or redirect rule can tell that it should not exist.
  This is section 1.8’s structural point: a changeset replays the consequences one writer
  saw. Only the serial reducer, or a fact-keyed edge set (section 3.6) that the build
  derives, reaches the line-order state.

### Trickle and Sustained Writes (H1, H5)

The records are round 1’s `p20` delta rows (a doc, an entity, and its edges each). Each
capture is followed by a reconcile and `gc({ retain: 0 })`; the FTS5 sidecar is not
rebuilt in these runs.

| Scale | Records | Full copy capture ms | Sparse capture ms | Operation envelope ms | Envelope bytes | Visible ms, full / sparse / envelope | Round 1 full-copy capture ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | 1 | 305 | 3.31 | 0.67 | 1,664 | 904 / 611 / 564 | 236 |
| S1 | 10 | 272 | 4.29 | 0.84 | 17,321 | 824 / 494 / 523 | 247 |
| S1 | 100 | 260 | 15.48 | 2.21 | 247,114 | 857 / 522 / 551 | 254 |

Runs: 3 per cell; each capture cell is the median of its runs.

The full-copy capture is the head copy, as in round 1.
The sparse capture opens the head read-only, creates the schema in memory, attaches the
head, hydrates the record’s entity, search, document, edge rows and the entities its
payload references, records the session, and writes the envelope directory.
The operation envelope serializes the rows and the node rows they reference and writes one
file. The one-record visibility is the reconcile, about 0.5 to 0.6 s at S1 and S2_VISIBLE at
S2, which this spike does not change on ext4 (design section 3.8).

**Sustained,** one writer offering 200 one-record envelopes per second and one
`runPublisher` process that folds everything pending into each build, then runs
`gc({ retain: 0 })`:

| Scale | Capture | Offered per s | Captured per s | Capture p50 ms | Published | Publishes | Records per publish | Build ms | gc ms | Cycle ms | Visibility p50 / p95 ms | p95 in cycles | Round 1: records per s, p50 / p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | operation envelope | 200 | 197.07 | 0.3331 | 5,911 of 5,911 | 14 | 395 | 876 | 1,225 | 2,519 | 2,338 / 4,075 | 1.62 | 2.63, 2,015 / 3,334 |
| S1 | sparse changeset | 200 | 196.19 | 2.4513 | 5,886 of 5,886 | 15 | 388 | 889 | 1,117 | 1,936 | 2,108 / 4,008 | 2.07 | 2.63, 2,015 / 3,334 |

A publish cycle is the interval between consecutive pointer swaps, which includes the gc
after each publish: gc’s full integrity check is half of the cycle at S1 and GC_SHARE at
S2, which is Spike 3’s subject.
Measured against the build alone, the visibility p95 is about 3.5 builds.

### Correctness Checks

`harness/compare.py` against `harness/expected/<scale>-p05/w3.json`, on the head after p05:

| Scale | Result file | compare.py |
| --- | --- | --- |
| S1-r2 | `w3-after-p05-4writers-full-missingdelete.json` | MATCH: 124 ok, 0 differ |
| S1-r2 | `w3-after-p05-4writers-ops-naive-closure.json` | MATCH: 124 ok, 0 differ |
| S1-r2 | `w3-after-p05-4writers-ops-naive.json` | MISMATCH: 123 ok, 1 differ |
| S1-r2 | `w3-after-p05-4writers-ops.json` | MATCH: 124 ok, 0 differ |
| S1-r2 | `w3-after-p05-4writers-sparse-missingdelete-closure.json` | MATCH: 124 ok, 0 differ |
| S1-r2 | `w3-after-p05-4writers-sparse-missingdelete.json` | MATCH: 124 ok, 0 differ |
| S1-r2 | `w3-after-p05-DirectStore.json` | MATCH: 124 ok, 0 differ |
| S2-r2 | `w3-after-p05-4writers-ops-naive-closure.json` | MATCH: 124 ok, 0 differ |
| S2-r2 | `w3-after-p05-4writers-ops-naive.json` | MATCH: 124 ok, 0 differ |
| S2-r2 | `w3-after-p05-4writers-ops.json` | MATCH: 124 ok, 0 differ |
| S2-r2 | `w3-after-p05-DirectStore.json` | MATCH: 124 ok, 0 differ |

The one mismatch is the ablation, whose purpose is to show the order effect.
C20 (`conflict.ts` at S1) is unchanged: `lww` publishes the later writer, `union` the
earlier, `strict` quarantines the later, and both values stay recoverable.

### Package Tests

In the patched copy, `node --test --test-concurrency=2 --test-timeout=30000 test/*.test.ts`
(what `pnpm test` runs, without its check of the test counts quoted in the repository’s
docs, which a copy outside the repository cannot read) gives 242 tests: 241 pass, 1 is
skipped, 0 fail. The unpatched copy gives 228: 227 pass and the same 1 skipped, a test that
needs a non-root process. The 14 new tests are in `test/v2-spike2.test.ts`.
`tsc --noEmit`, `eslint --max-warnings 0`, and `prettier --check` with the repository’s
config pass.

No existing test was changed or fails, so no test is excepted for a deliberate rule change:
every v2 behavior here is opted into by a new option (`reducers`, `closure`, a table policy
object, `seed: 'sparse'`), and the default missing-row setting stays `quarantine`.
The one change a default caller can observe is changeset admission, which refuses an
envelope naming a table the store lacks; no existing test depended on SQLite skipping such
a table. One full run under a load average of 11 cancelled `test/gc-lease.test.ts` at the
runner’s 30 s per-file timeout; the next full run passed it.

## Measurement Notes

- **Runs.** At S1-r2 the `ops` variant ran 3 times per batch and every other variant once;
  the one-writer DirectStore and `Append` arms ran 3 times per batch. At S2-r2 `ops` ran
  twice per batch, the other variants once, and the one-writer arms twice. The capture
  cells ran 3 times each at S1 and S2, and each sustained run once, for 30 s at S1 and 60 s
  at S2.
- **Base stores.** The fact tables change the DDL, so W1 rebuilt each base store through
  DirectStore (`w1.ts --routes direct`); those `w1.json` files are in the results.
- **Disk.** At S2-r2 the head-copy probes were skipped (`KB_COPY_PROBE=0`), and the
  line-order digest of each batch came from the one-writer DirectStore run, which builds the
  same state with the same loader (checked equal at S1-r2), so no four-writer run held a
  second head. Each scale’s stores were deleted after its runs.
- **What is not changed.** Builds keep SQLite’s default 2 MB page cache and the four-writer
  runs still rebuild the FTS5 sidecar after the publish, as in round 2 (Spike 1 changes
  both). gc after each sustained publish is round 1’s collecting gc (Spike 3 changes it).
- **Envelope order.** Envelope ids start with a millisecond timestamp, so four writers that
  append within a few milliseconds interleave by time: a writer’s last envelope, which holds
  the batch’s deletes and merges for its share, can precede another writer’s upserts.

## What Did Not Work, and Caveats

- **The closure fixes edges, not changesets.** Changeset envelopes with idempotent deletes
  and the closure still differ from line order by one edge at S1-r2 p20 (see above).
  Reaching the line-order state from concurrent changesets needs the fact-keyed edge sets
  of design section 3.6, which this spike did not build; the operation envelopes do not
  need them.
- **Sparse capture depends on a correct hydration plan, and a missing row fails silently.**
  The plan in `v2.ts` is written for `GenericLoader`: it must hydrate the parallel edges of
  each new edge’s triple, because the loader reads them to choose the next ordinal, and the
  entities a payload references, for display names. A row the plan misses changes the
  changeset without an error (an unhydrated parallel edge is overwritten under `lww`).
  The design’s helper that detects a missing hydration was not built.
- **The fixed cost of four processes.** The four-writer path spends 0.4 to 1.2 s at S1-r2 and 0.5 to 3.2 s at S2-r2 outside
  the build: four Node processes start, read their rows, and append.
  It weighs most on the small batches, where the H2 ratio is largest.
- **Envelope payloads repeat node rows.** Each operation envelope carries the batch node
  rows its rows reference. That costs little here: the 20 envelopes of S1-r2 p20 hold 47 MB,
  and the whole batch as one envelope with every node row holds 48 MB.
- **Not built.** Crash and kill tests for operation envelopes (the existing crash, kill,
  publication, and repair suites pass, and a new test covers exactly-once with a re-copied
  envelope); enforcement of the stamped reducer version on open (admission compares each
  envelope’s version with the reconciler’s); `publish(fn)` as one verb with `capture` and
  `append`; and patchsets for `lww` tables, which the design notes are 51% of a changeset.
- **The synchronous API.** `runPublisher` blocks its thread, so it runs in its own
  process, as the round-1 reconciler did.
- **The ablation is a mismatch by design.** `ops-naive` without the closure is the one W3
  result that does not match; it exists to show the order effect that tombstones and the
  closure remove.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
