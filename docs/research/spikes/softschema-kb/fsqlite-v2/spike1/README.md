# fsqlite v2 Spike 1: Derive at Build

**Date:** 2026-11-17

**Status:** Prototype and measurements for the maintainer.
It implements Spike 1 of [the fsqlite v2 design](../../notes/fsqlite-v2-design.md)
(section 2(e), section 4) in scratch copies of `packages/fsqlite` and of the spike’s
`fsqlite/` directory.
Nothing under `packages/` changed; the two patches here carry the prototype.

Every timing was taken on the spike VM (4 vCPUs, 16 GB RAM, ext4, Node 22.23.4, SQLite
3.53.4) while two other prototype agents and the FalkorDB arm used the same CPUs, disk,
and page cache.
They are medians with the run count stated, under contention, and a later
quiet pass should re-measure the headlines.

## Outcome

| Hypothesis | Outcome | Numbers against the baseline |
| --- | --- | --- |
| H1: indexed search is visible with the data; at most 100 records at S2 spend under 100 ms in the hook; neither the gate nor the hook adds 1 s | Confirmed | Indexed search is visible when the data is (the index is in the generation): 3.0 to 6.3 s at S2 against 6.1 to 7.4 s with the sidecar. Hook median 0.9 to 11.6 ms for 1 to 100 records, maximum 16.2 ms. Gate median 1.15 to 1.72 s against the 1.1 s whole-file check it replaces |
| H2: the hub join runs under 10 ms at S2-r2 with no hint, and the build fails when the unfiltered view is not served from its index | Confirmed | Unhinted hub join 5,405 ms to 8.6 ms (S2-r2) and 209 ms to 1.0 ms (S1-r2). A build asserting the unfiltered view’s plan is refused and publishes nothing, at S1, S2, S1-r2, and S2-r2 |
| H3: a new view index is published in the same store in under 5 s at S2 | Confirmed at S2-r2; S2 had one cold sample | Three derived version bumps on the 1,975 MiB S2-r2 head published in 2.5, 3.9, and 4.5 s (index build 0.27 to 0.44 s), same `store_id`, against a 16.8 s side-by-side copy into a new store at S2. The one S2 run took 39.2 s, 32.6 s of it a cold gate. S1: 0.76 s against 3.2 s |
| H4: with a 256 MiB build cache the SnapshotStore W1 reconcile at S2-r2 falls by at least 30% from 35.4 s | Refuted at S2-r2 | Two runs each: the 256 MiB cache does not shorten the reconcile (`f1.0` schema 34.2 and 40.8 s with it, 39.5 and 54.6 s without; v2 26.3 and 26.8 s with it, 24.1 and 26.7 s without). v2 is 24 to 26% below 35.4 s, from building derived objects after the rows, not from the cache. At S1-r2 the cache cut the `f1.0` reconcile by 33% (6.45 to 4.30 s, three runs) |

Two findings came from the measurements rather than the hypotheses:

- **Sampled statistics misplan.** With `analysis_limit = 1000`, `ANALYZE` read only the
  first rows of `(kind, label, id)`, estimated 201 rows per kind instead of 2,704, and
  moved the filtered view’s total off its partial index: `table.sessions_by_start` went
  from 0.14 to 15.7 ms at S1. A full `ANALYZE` (121 ms at S1, 1.0 to 1.7 s at S2 and
  S2-r2) restores the plan, and the build now asserts each filtered total’s plan, so a
  regression of this kind fails the build.
  The evidence is in `results/fsqlite-v2/spike1/S1/*-analysis-limit-1000.json`.
- **Closure inside the build removes dangling edges, not merge consequences.** Four
  writers at S1-r2 p05 answer 124 of 124 W3 queries like the oracle after one publish,
  where the baseline needed a closure publish.
  The rows still differ from one writer in line order by one edge, because line order
  retargets an edge to a merge survivor and the closure removes it.
  At p20, 10 dangling edges remain after the retry publish, because the closure sees
  only the deletes of its own build (details below).

## What Changed

### Package (`package.patch`)

The derived specification is opt-in.
Without `derived`, the store behaves as `f1.0`.

- `src/types.ts`: `StoreOptions` gains `derived` (`version`, `ddl`, `rebuild`, `update`,
  `statistics`, `analysisLimit`, `plans`, `rebuildAboveRatio`), `relations` (closure
  rules), `buildCacheKiB`, and `onBuild` (per-build timings).
- `src/derived.ts` (new): resolves and hashes the specification, diffs derived objects
  across versions, reads changed primary keys from a changeset, applies closure
  relations, runs statistics (`ANALYZE` after a rebuild, `PRAGMA optimize` after an
  update), checks plan assertions with `EXPLAIN QUERY PLAN`, stamps `base_tables`,
  `derived_version`, and `derived_hash` in `fsqlite_meta`, and runs the gate.
- `src/snapshotStore.ts`: `init()` builds snapshot 0 with empty derived objects.
  A capture whose changeset names anything but a base table is refused.
  `fold` sets the build cache, drops the derived objects before applying when the
  pending bytes exceed half the base generation (a bulk load, so indexes come after
  rows), filters envelopes to base tables, collects the changed keys, and runs closure,
  the derived hook, statistics, and plans before the gate.
  `reconcile()` publishes a derived refresh with no pending envelopes when the handle’s
  version is newer. The schema hash still covers the `schema` DDL, which now holds the
  base tables only.
- `src/directStore.ts`: `write(fn, { derived })` records a session on the build and
  passes the changed keys to the hook (`update`, the default), or drops and rebuilds the
  derived objects around the callback (`rebuild`, for a bulk load).
- `src/conflictPolicy.ts`: an envelope that names a non-base table (a derived table, a
  shadow table, `sqlite_stat1`) is a permanent conflict, so reconcile quarantines it.
- `src/driver.ts`: `unprotectOwnedTables()`, so the hook can stamp `fsqlite_meta`.
- `test/derived.test.ts` (new): 8 tests.

The gate checks every ordinary and shadow table with `quick_check(T)` and skips the FTS5
integrity check after an update; after a rebuild it runs the whole `quick_check`. A
generation is built against a stamped version: a build refuses a newer version, or the
same version with a different hash, and upgrades an older one in place with the same
`store_id`.

### Spike (`spike.patch`)

- `mapping.ts`: the DDL splits into `baseDdl()` (tables) and `derivedDdl()` (every
  secondary index, a contentless FTS5 trigram index `search_fts` with a `search_doc`
  rowid map, and a `facet_count` summary).
  The hook rebuilds or updates them from the changed keys.
  Closure relations remove edges whose source or target entity a build deleted.
  Plan assertions cover the three view pages, the two filtered totals, and the
  people-by-organization join without its hint.
  `genericOptions()` sets a 256 MiB build cache; `FSQ_BUILD_CACHE_KIB`,
  `FSQ_ANALYSIS_LIMIT`, `FSQ_REBUILD_RATIO`, and `FSQ_NO_DERIVED=1` (the `f1.0` schema
  with only the cache changed) vary it.
- `queries.ts`, `w3.ts`: `--fts-inline` searches the generation’s FTS5 index and
  `--facet-summary` reads `facet_count`.
- `load.ts`, `w1.ts`: the DirectStore import runs `write(fn, { derived: 'rebuild' })`;
  results record the build, the hook and gate times, and the derived bytes; there is no
  sidecar. `--reuse-rows` and `--name` let routes run one at a time.
- `trickle.ts`: records `visible_after_ms`, `indexed_search_visible_after_ms`, the hook,
  and the gate per publish.
- `plans.ts`: on a hard-link clone, a no-op build that also asserts the unfiltered
  view’s plan without `INDEXED BY` (expected to fail), then one with the declared
  assertions.
- `w4.ts`: case 5 is a derived version bump published by one reconcile in the same store
  (`--side-by-side` keeps the old path).
  `h3.ts` (new) repeats it three times.
- `w2.ts`: `--no-closure-envelope` leaves the state the in-build closure produces.
- `common.ts`: results go to `results/fsqlite-v2/spike1/`. `run_spike1.sh` (new) runs
  the set. The remaining files only build their stores with `genericOptions()`.

## How to Apply and Reproduce

In a scratch checkout of the repository, from its root:

```bash
patch -p1 < docs/research/spikes/softschema-kb/fsqlite-v2/spike1/package.patch
patch -p1 < docs/research/spikes/softschema-kb/fsqlite-v2/spike1/spike.patch
(cd packages/fsqlite && node scripts/run-tests.mjs)
export KB_SCRATCH=<scratch>/research-c/spike1/kbscratch   # kb-corpora/ links the corpora
bash docs/research/spikes/softschema-kb/fsqlite/run_spike1.sh S1   # then S2, S1-r2, S2-r2
python3 docs/research/spikes/softschema-kb/harness/compare.py \
  docs/research/spikes/softschema-kb/harness/expected/S1/w3.json \
  docs/research/spikes/softschema-kb/results/fsqlite-v2/spike1/S1/w3-fts.json
```

The patches add 8 tests, so the test-count claim in `docs/qa-runbook.md` must read 236
for the test runner’s documentation check to pass.
The spike imports the patched package through `fsq.ts` unchanged, because the scratch
copies keep the repository layout.

The runs here deviated from `run_spike1.sh` in three ways.
S1 ran W1 through both routes; S2 and S2-r2 ran DirectStore only, for disk.
The S2-r2 cache matrix ran two rounds instead of three.
The first S2-r2 `h3.ts` run was stopped when free disk fell to 2.8 GB, and ran again in
a second S2-r2 pass (`w1-pass2.json`).

## Results

Results are in `results/fsqlite-v2/spike1/<scale>/`, in the shape of `results/fsqlite/`.

### Correctness

Every W3 run matches its expected file with `harness/compare.py`:

| Run | S1 | S2 | S1-r2 | S2-r2 |
| --- | --- | --- | --- | --- |
| `w3.json` (substring scan, live facets) | 24 of 24 | 24 of 24 | 124 of 124 | 124 of 124 |
| `w3-fts.json` (in-file FTS5 and facet summary) | 24 of 24 | 24 of 24 | 124 of 124 | 124 of 124 |
| `w3-after-p05-4writers.json` (four writers, in-build closure, no closure envelope) | n/a | n/a | 124 of 124 against `S1-r2-p05` | not run |

The `S1/*-analysis-limit-1000.json` run also matched 24 of 24; its regression was a
latency, not an answer.

### H1: Indexed Search Visibility and the Hook

`trickle.ts`, three runs per size and arm; the gate replaces the baseline’s whole-file
`quick_check` (1.1 s warm at S2, 0.2 s at S1).

| Scale | Arm | Records | Visible ms (v2 = indexed search) | Baseline visible + sidecar ms | Hook ms | Gate ms |
| --- | --- | --- | --- | --- | --- | --- |
| S2 | SnapshotStore | 1 / 10 / 100 | 4,366 / 4,419 / 6,273 | 6,503 / 7,388 / 6,681 | 1.2 / 1.2 / 11.6 | 1,440 / 1,149 / 1,679 |
| S2 | DirectStore | 1 / 10 / 100 | 3,206 / 2,966 / 3,805 | 6,358 / 6,065 / 6,126 | 0.9 / 1.3 / 7.6 | 1,355 / 1,287 / 1,723 |
| S1 | SnapshotStore | 1 / 10 / 100 | 837 / 797 / 1,203 | 1,259 / 1,326 / 1,297 | 1.0 / 1.2 / 7.7 | 200 / 205 / 225 |
| S1 | DirectStore | 1 / 10 / 100 | 604 / 579 / 657 | 1,172 / 1,129 / 1,197 | 0.7 / 1.3 / 11.8 | 212 / 203 / 245 |

- The hook (changed-key parsing, closure, FTS5 and facet maintenance, `PRAGMA optimize`,
  plans) never exceeded 16.2 ms.
  The gate is the baseline check plus at most 0.6 s under contention; on the warm S2
  head the per-table gate takes 0.9 to 1.2 s and the whole check with FTS5 2.0 to 2.3 s
  (`S2/gate-probe.json`).
- Plain visibility rose against the baseline’s: at S2 by 0.6 to 1.4 s for DirectStore
  and 0.7 to 3.3 s for SnapshotStore, where captures took 1.8 to 2.8 s against 1.1 to
  1.2 s. The hook and gate explain little of it; the file is also 13% larger (1,940
  against 1,717 MiB, of which 160 MiB is FTS5 and facets and 85 MiB an origin index the
  round-1 baseline lacked).
  The quiet pass should settle it.
- The sustained trickle got worse: 0.23 records per second and a 43 s visibility p50 at
  S2, against 0.6 and 16.5 s. Its captures took 3.9 s against 1.3 s, and `gc({ retain: 0
  })`, whose `integrity_check` now also verifies the FTS5 index, took 6.7 s against 4.3
  s. Design change (i), which Spike 3 measures, would replace that check with a recorded
  verification.

### H2: Statistics and Plan Assertions

`plans.ts`. Statistics come from the build (full `ANALYZE` after the import).

| Query | S1-r2 baseline | S1-r2 v2 | S2-r2 baseline | S2-r2 v2 |
| --- | --- | --- | --- | --- |
| Hub join without hint (`v2.table.04`, `org:github`) | 209 ms | 1.01 ms | 5,405 ms | 8.57 ms |
| Next largest organization (`v2.table.05`) | 57 ms | 0.21 ms | 1,282 ms | 1.34 ms |
| Unfiltered view without `INDEXED BY` (`v2.table.18`) | 16.7 ms | 22.7 ms | 99.8 ms | 103 ms |

Every unhinted join uses `ix_entity_id_kind (id=? AND kind=?)` and returns the hinted
rows. Statistics do not fix the unfiltered view, and the plan assertion catches it: the
build that declares it is refused with `plan assertion repos_all_by_stars without
INDEXED BY failed: ... SEARCH entity USING INDEX ix_entity_kind_label (kind=?); USE
TEMP B-TREE FOR ORDER BY`, `current` stays at 1, and no transient is left (0.4 s at
S1-r2, 6.2 s at S2-r2, mostly the copy).
The same build with the declared assertions publishes, with a hook of 0.4 to 1.4 ms.

### H3: A New View Index in the Same Store

W4 case 5 changes the `repos_by_stars` view index to filter on `primary_language.name`.
Under v2 it is a derived version bump: one reconcile with no pending envelopes drops the
old index, creates the new one, runs `ANALYZE` on it, checks the plans, and publishes.
A `CREATE INDEX` inside a write callback is still refused.

| Run | Publish s | Index build s | Gate s | Same `store_id` | New index used |
| --- | --- | --- | --- | --- | --- |
| S1 (`w4-case5.json`) | 0.76 | 0.08 | 0.28 | yes | yes |
| S2 (`w4-case5.json`, one run) | 39.2 | 5.3 | 32.6 (cold) | yes | yes |
| S2-r2 (`w4-case5-repeat.json`, three runs in order) | 3.9 / 4.5 / 2.5 | 0.32 / 0.44 / 0.27 | 1.12 / 2.09 / 1.26 | yes | yes |
| Baseline side-by-side copy | 3.2 (S1), 16.8 (S2) | n/a | n/a | no | yes |

After each S2-r2 publish a warm per-table check of the new head took 0.86 to 1.0 s, so
the 2.1 s gate was partly cold.
The rest of each publish is the 2 GB copy and its fsync.

### H4: The Build Cache

`w1.ts --routes snapshot` (`w1-h4-*.json`): the SnapshotStore import’s reconcile with
the build cache at 256 MiB and at SQLite’s 2 MB default, with the derived objects (v2)
and, as a control, with the `f1.0` schema (`FSQ_NO_DERIVED=1`, indexes maintained during
the apply). The baseline reconcile was 7.45 s at S1-r2 and 35.4 s at S2-r2.

| Scale | Runs | `f1.0` schema, 2 MB | `f1.0` schema, 256 MiB | v2, 2 MB | v2, 256 MiB |
| --- | --- | --- | --- | --- | --- |
| S1-r2 | 3 | 6.45 s (5.46 to 7.11) | 4.30 s (4.10 to 4.96) | 4.82 s (4.81 to 5.22) | 4.27 s (4.07 to 4.78) |
| S2-r2 | 2 | 39.5, 54.6 s | 40.8, 34.2 s | 24.1, 26.7 s | 26.3, 26.8 s |

- At S1-r2, where the 385 MiB head is close to the cache size, 256 MiB cuts the `f1.0`
  reconcile by 33%.
- At S2-r2 it shows no consistent effect, in either schema, beside the contention spread
  (39.5 to 54.6 s for one configuration).
  A W1 import touches every page of a 2 GB file, so a 256 MiB cache cannot hold its
  working set; the design’s 1.9x figure (A.7) was a 12,000-record batch on an existing
  head.
- The v2 reconcile is 24 to 26% below 35.4 s with 256 MiB because it drops the derived
  objects before applying (apply 9.6 to 10.6 s, then 12.4 to 12.5 s of derived build and
  `ANALYZE`, and a 3.0 s full gate), not because of the cache.

### Closure in the Build

`w2.ts --no-closure-envelope` at S1-r2: four writers, five envelopes each, v2 batches.

| Batch | Quarantined | Edges the closure removed | Dangling edges after | W3 against the oracle | Rows equal to one writer in line order |
| --- | --- | --- | --- | --- | --- |
| p01 | 0 | 0 | 0 | n/a | yes |
| p05 | 0 | 5 (3.1 ms) | 0 | 124 of 124 after one publish | no: 235,469 against 235,470 edges |
| p20 | 2 (`NOTFOUND`), then a retry publish | 56 in 2 builds (3.1 and 1.0 ms) | 10 | n/a | no |

The baseline reached the line-order rows only with a third publish that replays the
batch’s deletes and merges, 6.6 to 7.3 s at S2-r2. The in-build closure costs
milliseconds but cannot retarget an edge to a merge survivor, and the retry’s upserts
can name nodes an earlier build deleted.
Both need the tombstone and redirect facts of design section 3.6. The `NOTFOUND`
quarantines are Spike 2’s.

### W1, Size, and W3 Latency

| Scale | DirectStore ingest to durable s (baseline) | Derived build s | Gate s | Snapshot MiB (baseline) | FTS5 MiB (sidecar) | Facets MiB |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | 5.9 (4.1) | 1.6 | 0.6 | 377 (335) | 22.9 (31.4) | 8.3 |
| S2 | 38.8 (19.1) | 12.2 | 12.3 | 1,940 (1,717) | 117 (141) | 43.2 |
| S1-r2 | 6.2 (4.3) | 1.8 | 0.6 | 385 (363) | 22.8 (32.5) | 7.6 |
| S2-r2 | 31.0 (22.3) | 12.0 | 3.8 | 1,975 (1,856) | 116 (140) | 39.3 |

- Building the derived objects after the rows halves the S2-r2 ingest (14.2 to 7.3 s),
  but the derived build (indexes, FTS5, facets, `ANALYZE`) and the whole-file gate cost
  more than that under contention; the S2 gate of 12.3 s against a warm 2.0 to 2.3 s is
  a cold page cache. The baseline’s figures exclude the sidecar (0.7 s at S1, 3.5 to 3.9
  s at S2).
- Scan-arm W3 medians stay within 12% of the baseline in every category (the largest gap
  is search at S2-r2, 52.1 against 46.6 ms).
  Across the four scales, the in-file FTS5 search medians are 0.35 to 3.6 ms against the
  sidecar’s 0.49 to 3.9 ms, and summary facets 0.07 to 0.28 ms against 3.5 to 30 ms.

### Package Tests

`node scripts/run-tests.mjs` in the patched copy: 236 tests, 235 pass, 1 skipped (the
baseline’s skip), 0 fail; `tsc --noEmit`, `eslint`, and `prettier --check` are clean.
All 228 existing tests pass unchanged: no rule changed, because the derived
specification is opt-in.
The 8 new tests cover virtual tables through `init()` and `validate()`, envelopes and
direct writes building FTS5, facets, and statistics, refusal at capture and quarantine
at reconcile, a hook failure and a failed plan assertion publishing nothing, a version
bump keeping `store_id`, closure, bulk rebuilds, and the changeset key reader.

## What Did Not Work

- `analysis_limit = 1000` (the design’s 283 to 344 ms figure) misplanned a count; the
  build uses a full `ANALYZE` instead.
- Closure by deletion leaves the merge and cross-build cases above.
- Disk ran short: the S2 and S2-r2 SnapshotStore W1 routes with the derived objects ran
  only in the cache matrix, the first S2-r2 `h3.ts` run was stopped, and the S2-r2
  four-writer closure check was not run (four 2 GB working copies per batch).
- Four S2-class builds measured a cold page cache in the gate (12.3 s in the S2 import,
  22.1 and 23.2 s in the S2 and S2-r2 plan-assertion builds, 32.6 s in the S2 W4 case
  5), so those gate figures are contention, not the design.
- The round-1 baselines (S1, S2) predate `ix_edge_origin` and the unfiltered view’s
  index, so W1 and size comparisons at those scales include them; round 2 compares like
  with like.
- **Owned tables are unprotected while application hooks run** (review B, B6).
  DirectStore calls `unprotectOwnedTables` and then runs the application’s
  `derived.rebuild` or `derived.update`, and reconcile runs them with no protection;
  only the closure hook is audited with a session.
  A rebuild that clears every non-base table would empty `applied_tx`, and the gate
  would not see it. `derived.ts` also opens `new DatabaseSync(':memory:')` for the
  caller’s DDL, the one connection that skips `connect()` and its pinned defensive flag.
  A real v2 must keep the triggers on and stamp `fsqlite_meta` through a path they
  allow, audit `rebuild` and `update` with a session as it audits the closure hook, fail
  a build in which `applied_tx` changed other than by fsqlite’s own insert, and open
  every connection through `connect()`.

## Files

- `package.patch`: `diff -ruN` of the package copy against `packages/fsqlite`.
- `spike.patch`: `diff -ruN` of the spike copy against
  `docs/research/spikes/softschema-kb/fsqlite`.
- `results/fsqlite-v2/spike1/{S1,S2,S1-r2,S2-r2}/`: `w1*.json`, `w3.json`,
  `w3-fts.json`, `w3-plans.json`, `w2-trickle.json`, `w4-case5*.json`,
  `w2-inbuild-closure.json`, `w3-after-p05-4writers.json`, `gate-probe.json`, and the
  cache matrix `w1-h4-*.json`.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
