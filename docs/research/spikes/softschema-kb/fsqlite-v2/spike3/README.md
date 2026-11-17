# fsqlite v2 Spike 3: Maintenance and Publication

**Date:** 2026-11-17

**Status:** Prototype and measurements for the maintainer.
Nothing here changes `packages/fsqlite/`. The design under test is `fsqlite-redesign.md`
(the research-b scratch analysis), changes (g), (h), and (i), and its section 4, “Spike
3: Maintenance and Publication”.

## Summary

| Hypothesis | Outcome | Numbers (medians; runs under contention, see Measurement) |
| --- | --- | --- |
| H1: gc refuses 0 of 20 times in the DirectStore W2 at S1 and S2 | **Confirmed** | v2: 0, 0, 0 of 20 at S0 and at S1 (p01, p05, p20), and 0 of 20 at S2 (p01). f1.0 arm in the same window: 8, 9, 6 at S0, 10, 9, 10 at S1; not run at S2. |
| H2: the sustained trickle round at S2 shrinks by at least half | **Refuted**, narrowly | At S2 the round (reconcile p50 plus gc p50) falls 47%, from 8,716 to 4,596 ms; 1,519 ms of the 1,523 ms of gc left is the unlink of the superseded head. At S1 it falls 32% and at S0 62%. |
| H3: the SnapshotStore import store is at most 1.05 H after maintenance | **Confirmed** at S0 and S1; S2 not run | 1.0000 H at S0 and S1, against 1.6265 H and 1.6149 H for the f1.0 arm. |
| H4: all four W6 kill points recover with no manual step, no published generation lost, no envelope applied twice | **Confirmed** at S0 and S1 | 8 of 8 recoveries with no operator step, in 4 to 308 ms; every captured envelope is in the head ledger once (2, 41, and 41 at S0; 2, 366, and 366 at S1). The f1.0 arm needed manual lock removal at 2 of 4 kill points on both scales. |

The package prototype passes 251 of 252 `node:test` cases (1 skipped, as before) and 80
of 80 CLI goldens. The publication, fencing, gc-lease, repair, crash, and kill suites
were rewritten where the rule changed, and 2 tests (3 cases) in 2 other files encoded a
changed rule and were rewritten too (section Tests).

Two things in the design did not hold as written:

- **Collecting only against a `full` record** (section 3.7 of the design) makes gc
  almost free between scrubs, but it collects nothing in that time, so every publish
  adds a head-sized generation: 147 generations in a 20 s trickle at S0. The prototype
  adds `collectOn: 'quick'`, which pins gc to the publication gate’s record and keeps
  the newest full-verified generation as the recovery point.
  H2 is measured with it.
- **Probing forward from the `current` hint** is unsound once gc leaves a leased
  generation below a gap: the probe stops at the island.
  The prototype takes the head from a listing of `snapshots/` instead.

## What Changed in the Package

`package.patch` is `diff -ruN` against `packages/fsqlite` (paths `a/` and `b/`). Source
changes, by design item:

| Item | Files | Change |
| --- | --- | --- |
| (h) commit by link | `publication.ts`, `snapshotStore.ts`, `directStore.ts` | `commitGeneration` replaces `commitSnapshot`: the no-replace link is the commit; the floor is read before and after it; a quick verification record and the hint follow. The head is the highest generation in `snapshots/`. |
| (h) expirable lease | `lock.ts` | A waiter breaks a lock that is older than `staleMs`, or whose owner record names this host and a gone process (zombies included, from `/proc` on Linux). Breaking renames the lock aside after re-checking its inode, mtime, and token, and restores a lock it moved by mistake. `lockStatus()` classifies a lock without changing it. |
| (h) leases without the lock | `snapshotStore.ts` | `readLease()` publishes its lease file and checks the generation, without the publish lock. `seal()` opens its leased generation through `openLeased()`, which waits out gc’s tombstone window. |
| (h) roll-forward repair | `snapshotStore.ts` | See rule R3’ below. |
| (i) pinned gc | `snapshotStore.ts`, `types.ts` | `verified/<version>.json` records (level, verdict, file identity), `verify()`, and gc options `verifyMaxAgeMs`, `collectOn`, `retainApplied`. gc reports `verified`, `fullVerified`, `prunedApplied`, and `timings`. |
| (i) unlink after release | `snapshotStore.ts` | Collected generations are renamed to owner-tagged tombstones under the lease and unlinked after it is released. |
| (g) retention | `snapshotStore.ts`, `conflictPolicy.ts` | gc deletes applied envelopes that the newest full-verified generation holds. `applyWithPolicy` now returns how many replaceable conflicts it resolved, and settle marks such envelopes `CONFLICTED`, which `retainApplied: 'conflicts'` (the default) keeps. |
| (g) ledger floor | `snapshotStore.ts`, `types.ts` | `fsqlite_meta.ledger_floor`, the store option `ledgerWindowMs` (default 7 days), expiry at fold, pruning, and the writer clock check. |
| Transient owners | `snapshotStore.ts`, `directStore.ts` | `.build-`, `.direct-`, `.work-`, tombstone, lease, and record temps carry `<host hash>-<pid>`, so recovery removes a dead local owner’s debris at once. |
| CLI | `cli/main.ts` | The `repair --help` text states the v2 rule. |

On disk, a v2 store adds `verified/` and `floor/`, one `ledger_floor` row in
`fsqlite_meta`, and one `applied_tx` row per DirectStore write.
The marker still says `f1.0` with no required features: a v2 store must not be shared
with `f1.0` clients, and a real v2 must name the feature in `required_features`.

## Rule Changes and Rationale

Rule names refer to `docs/fsql-format-spec.md`; a prime marks a changed rule, and a new
number a new one.

| Rule | f1.0 | v2 prototype | Why |
| --- | --- | --- | --- |
| F5c’ commit | The build is linked to `snapshots/<next>`, then `current` is renamed to name it; the rename is the commit. | The no-replace link is the commit. A link that fails with `EEXIST` means a peer won, and the build retries from the new head. A failure after the link is a `PostPublishError`. | The link is already atomic and exclusive. The blind pointer rename was the one step that could roll the store back, which is why f1.0 needed a lock that never expires. |
| P2’ head and hint | `current` names the head; a snapshot ahead of it is an orphan that blocks publication until repair. | The head is the highest committed generation. `current` is a hint, still strictly parsed (P1), advanced after each commit, by an idle reconcile, and by repair. A hint behind the head is an in-flight tell; a hint ahead of every generation is corruption. | Nothing can be ahead of the head, so the orphan state and its repair step disappear. |
| G4 floor (new) | None. | gc raises the floor to `G - retain` before its first deletion. The floor is the maximum of no-replace entries in `floor/`, so racing maintainers can only raise it. A publisher reads it before linking and after; if `next` is below it, it withdraws its own entry and retries. | Without it, a publisher paused past its lease could re-create a collected version name and report a lost write as published. |
| G4 DirectStore ledger (new) | DirectStore writes leave no ledger row. | Each DirectStore write records `<time>-direct-<owner>-<hex>` in `applied_tx`. A write whose entry the floor withdrew returns the head if the head’s ledger holds that id, and reruns otherwise. | A peer can build on a legitimate commit and gc can collect it before the floor check; the id makes that case exactly once instead of a rerun. |
| L2’, L5’ lease | The lock never expires; a crashed holder needs offline recovery by an operator. | The lock is a lease: a waiter breaks it when it is older than `staleMs` or its local owner process is gone. A broken holder fails its fence and abandons its step. | Safety now rests on F5c’ and G4, so the lock only prevents wasted builds and serializes maintenance. |
| RL1’ read leases | Taken under the publish lock. | Taken without it: publish the lease file, then check that the generation exists. A holder that opens by path may meet gc’s tombstone window and waits it out. | A reader no longer waits behind a DirectStore build that holds the lock for seconds. |
| G0’ pinned gc | Refuse unless the head passed a full check and `current` under the lock still names it. | Pin G, the newest generation with a passing record at the `collectOn` level. Scrub the head first when the newest passing `full` record is older than `verifyMaxAgeMs`. Delete generations below `G - retain`, except leased ones, the head, and the newest full-verified one. Refuse only when no generation verifies. | A verdict on an immutable file never expires, so G need not be the head; this removes the refusal under contention. |
| G2’ tombstones | Renamed and unlinked under the lock. | Renamed under the lease and unlinked after release. Tombstones carry their owner, and a gc settles only a dead, stale, or untagged one. | The unlink of a head-sized file no longer blocks publishers. The owner tag is needed because two gcs now overlap: the spike found a second gc collecting the first one’s tombstone before it unlinked it. |
| G5 retention (new) | `tx/applied/` is never pruned. | gc deletes applied envelopes that the newest full-verified generation holds or that lie below its ledger floor, except conflict evidence under `retainApplied: 'conflicts'`. | Bounds the import store at about H instead of 1.6 H. |
| F7 ledger floor (new) | The ledger grows for the store’s life. | Each build raises `ledger_floor` to `ledgerWindowMs` behind its clock, never past an envelope it applied or found archivable, and never back; it prunes ledger rows below it. A pending envelope below the floor is quarantined as `expired`. A writer whose clock is behind the floor fails at capture. Validate compares the archive with the ledger above the floor only. | Bounds the ledger that every build loads; exactly once holds because a pruned id can never be applied again. |
| R3’ repair | Re-point `current` to the newest clean snapshot, delete snapshots ahead of it, refuse any lock, delete every transient. | Never move the head back. Advance a lagging hint. For a corrupt head, build a new generation from the newest clean one plus the retained envelopes its ledger lacks; keep the corrupt ones, with a failing record so gc never pins them. Refuse only a live lease; break an expired one or a dead local owner’s. Remove lease-scoped transients, a dead owner’s, and stale ones; leave fresh lease-free ones, which may be live work. | Repair becomes safe to run while clients run, and needs no operator step. |

## Tests

| Suite | Tests before | After | Kept | What changed |
| --- | --- | --- | --- | --- |
| `publication.test.ts` | 13 | 15 (19 cases) | 8 | The paused-publisher, orphan-ahead, late-rename, and lost-lease tests now assert the link rule. New: a publisher whose number was committed and collected while it paused withdraws (both strategies); a DirectStore commit that peers built on before its floor check runs once. |
| `fencing.test.ts` | 9 | 15 | 5 | The never-stolen tests become expiry, dead-owner, zombie, live-owner, malformed-lock, stale-observation, and a four-process break race. A lease broken after the link cannot undo the commit. |
| `gc-lease.test.ts` | 19 | 29 | 13 | Pinned gc, scrub records, identity mismatch, validate’s own check, the floor, retention with conflict evidence, the ledger floor, lock-free leases, and a live peer’s tombstone. |
| `repair.test.ts` | 16 | 17 | 9 | Roll-forward, hint advance, lease breaking, and the transient rule. |
| `crash.test.ts` | 2 | 4 (6 cases) | 0 | No crash point needs repair; a crash during archive pruning loses nothing. |
| `kill.test.ts` | 2 | 5 | 1 | A SIGKILLed holder is broken at once on this host and after expiry from another; kills after the link and inside a DirectStore build. |
| `concurrent.test.ts` | 5 | 5 | 4 | One test asserted the orphan-ahead refusal; it now asserts that a reconciler builds on that generation. |
| `direct.test.ts` | 12 | 12 | 11 | One parameterized test asserted that an old foreign lock is never stolen; it now asserts one publication after the break. |

Two new workers support them: `workers/lease-racer.ts` and `workers/direct-hang.ts`;
`workers/reconciler.ts` gained a `link` kill point.
The CLI goldens changed in four places, all from the rule changes: a lagging hint
instead of an orphan (validate, repair, doctor), the new gc result fields, and the
`ledger_floor` meta row in `stats`. The repository’s docs still state the old test
count, so the package’s documentation count check, which `pnpm test` runs after the
suite, fails until they are updated.

Results in this copy, against the unmodified package’s 228 cases (227 pass, 1 skipped):

| Check | Result |
| --- | --- |
| `node --test test/*.test.ts` | 252 cases, 251 pass, 1 skipped, 0 fail |
| `tryscript run 'test/cli-golden/*.tryscript.md'` | 80 passed |
| `tsc --noEmit`, `eslint --max-warnings 0`, `prettier --check` | clean |

## Changes to the Spike Copy

`spike.patch` is `diff -ruN` against `docs/research/spikes/softschema-kb/fsqlite/`.

- `fsq.ts` imports `../../package/src/index.ts`, and `common.ts` takes `KB_SCRATCH`, the
  results directory (`results/fsqlite-v2/spike3/`), and the S0 KB path from the scratch
  layout. `KB_GC_OPTS` (JSON) adds gc options to every maintenance call.
- `w2_worker.ts`, `trickle.ts`, and `w1.ts` record gc’s pin, scrubs, timings, and the
  generation count; `trickle.ts` and `w2.ts` take `--name`.
- `w6.ts` recovers with no manual step: it waits until the killed process is gone, then
  validates, repairs, validates, and finishes.
  It records the lock’s status, the generations before and after, and, for
  SnapshotStore, how many captured envelopes the head ledger holds.
- `run_spike3.sh` runs one scale; `run_spike3_s2.sh` is the disk-limited S2 run.

`spike-f1.0-arm.patch` makes a second copy run the unmodified package, with `--name` on
`w2.ts` and `trickle.ts`, so both arms ran in the same window.

## Measurement

The VM has 4 vCPUs and 16 GB, ext4, Node 22.23.4, and SQLite 3.53.4. Two other spikes
and a FalkorDB benchmark ran at the same time; the load average was 3.4 to 7.6, so every
timing is under contention and shows sizes and ratios, not rates.
Each W2 batch is one run of 20 writes; trickle figures are medians over the sustained
run’s rounds (10 to 147) and over 3 repetitions of each batch size (2 at S2). The f1.0
arm ran right after the v2 arm at each scale.
W3 matches the oracle at every scale run: 24 of 24 at S0, S1, and S2.

### H1: gc Refusals Under Contending DirectStore Writers

| Scale, batch | v2 refusals | f1.0 refusals | v2 gc p50 | f1.0 gc p50 | v2 visible | f1.0 visible | v2 reopen p95 | f1.0 reopen p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S0 p01 | 0/20 | 8/20 | 385 ms | 994 ms | 5.5 s | 8.1 s | 13 ms | 795 ms |
| S0 p05 | 0/20 | 9/20 | 281 ms | 1,636 ms | 3.9 s | 13.2 s | 9 ms | 2,177 ms |
| S0 p20 | 0/20 | 6/20 | 602 ms | 1,932 ms | 8.2 s | 15.4 s | 14 ms | 852 ms |
| S1 p01 | 0/20 | 10/20 | 2,370 ms | 5,901 ms | 21.1 s | 36.8 s | 39 ms | 1,674 ms |
| S1 p05 | 0/20 | 9/20 | 2,662 ms | 5,550 ms | 28.6 s | 34.0 s | 35 ms | 1,036 ms |
| S1 p20 | 0/20 | 10/20 | 2,899 ms | 5,869 ms | 39.8 s | 38.2 s | 33 ms | 3,008 ms |
| S2 p01 | 0/20 | not run | 8,037 ms | not run | 90.2 s | not run | 35 ms | not run |

Both arms use `gc({ retain: 0 })` after every write with the package defaults, so the v2
gc still scrubs its pinned head each time; the refusals go because it no longer needs
that head to be current.
Every batch changed all its updated records in both arms.
The reader’s reopen no longer waits behind a DirectStore write, which drops its p95 from
about 1 to 3 s to 9 to 39 ms.
Visibility is inside the noise of the loaded machine.

### H2: the Sustained Trickle Round

The round is one reconcile plus one gc; the table adds the two medians, because the f1.0
arm records only those.
The `quick` configuration is `gc({ retain: 0, collectOn: 'quick', verifyMaxAgeMs })`: gc
pins the publication gate’s record and keeps the newest full-verified generation, and a
full scrub runs when that record is older than `verifyMaxAgeMs` (60 s at S0 and S1; at
S2 one scrub, 23.3 s under contention, ran before the trickle, and `verifyMaxAgeMs` was
1 h).

| Scale | Arm | Rounds | Reconcile p50 | gc p50 | Round | Change | Scrubs | Generations kept |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S0 | f1.0 | 37 | 174 ms | 210 ms | 384 ms |  | every round | 1 |
| S0 | v2, defaults | 58 | 122 ms | 128 ms | 250 ms | -35% | every round | 1 |
| S0 | v2, quick | 123 | 108 ms | 36 ms | 144 ms | -62% | 1 | 2 |
| S0 | v2, full record only | 147 | 120 ms | 6 ms | 126 ms | -67% | 1 | 147 |
| S1 | f1.0 | 10 | 1,017 ms | 1,103 ms | 2,120 ms |  | every round | 1 |
| S1 | v2, defaults | 10 | 825 ms | 1,256 ms | 2,081 ms | -2% | every round | 1 |
| S1 | v2, quick | 14 | 1,114 ms | 321 ms | 1,435 ms | -32% | 1 | 2 |
| S2 | f1.0 | 4 | 3,452 ms | 5,264 ms | 8,716 ms |  | every round | 1 |
| S2 | v2, quick | 5 | 3,073 ms | 1,523 ms | 4,596 ms | -47% | 0 | 2 |

The median of the v2 arm’s per-round sums is 145, 1,428, and 4,894 ms for the quick runs
(-44% at S2). In the batch phase at S2, gc after a publish took 4 to 1,400 ms in the v2
arm against 4,840 to 6,295 ms in the f1.0 arm, and the FTS sidecar rebuild (3.7 to 4.1 s
in both) now costs more than gc.

With the quick pin, what is left of gc is the unlink of the superseded head after the
lease is released: 313 ms of the 321 ms at S1 and 1,519 ms of the 1,523 ms at S2. It no
longer blocks publishers, but it is still in the trickle loop, which runs gc after every
reconcile. Inferred, not measured: a reconciler that left the unlink to a separate
maintenance cadence would run the round in about the reconcile time, 3.1 s at S2, which
is 65% less than the f1.0 arm.
The round-1 baseline at S2 was 6,791 ms, 4,338 ms of it gc
(`results/fsqlite/S2/w2-trickle.json`). The S2 runs had 4 and 5 rounds in 20 s, so their
medians are coarse.

### H3: the SnapshotStore Import Store

| Scale | Arm | Store after `gc({ retain: 0 })` | Head | Ratio | Applied envelopes pruned |
| --- | --- | --- | --- | --- | --- |
| S0 | f1.0 | 67,554,687 B | 41,533,440 B | 1.6265 H | none |
| S0 | v2 | 41,533,716 B | 41,533,440 B | 1.0000 H | 3 |
| S1 | f1.0 | 611,953,325 B | 378,937,344 B | 1.6149 H | none |
| S1 | v2 | 378,937,621 B | 378,937,344 B | 1.0000 H | 20 |

The gc that prunes is the one W1 already runs; it scrubs the head once (verify 81 ms at
S0, part of the 1,192 ms gc at S1) and deletes every envelope that head’s ledger holds.
The import has no conflicts, so no envelope is kept as evidence.
S2 was not run through the SnapshotStore route: it needs about 5 GB more free disk than
this VM had.

### H4: the Four W6 Kill Points

| Scale | Kill point | f1.0 arm | v2 arm | v2 recovery | Exactly once |
| --- | --- | --- | --- | --- | --- |
| S0 | DirectStore build, lease held | manual lock removal | dead owner’s lease broken by repair | 38 ms | rerun import, sealed |
| S0 | capture | no lock | no lock | 28 ms | 2 of 2 envelopes in the head ledger |
| S0 | reconcile build | no lock | no lock | 4 ms | 41 of 41 |
| S0 | publication, lease held | manual lock removal | dead owner’s lease broken by repair | 38 ms | 41 of 41 |
| S1 | DirectStore build, lease held | manual lock removal | broken by repair | 28 ms | rerun import, sealed |
| S1 | capture | no lock | no lock | 4 ms | 2 of 2 |
| S1 | reconcile build | no lock | no lock | 10 ms | 366 of 366 |
| S1 | publication, lease held | manual lock removal, orphan snapshot 1 removed | broken by repair | 308 ms | 366 of 366 |

No generation that existed before recovery was missing after it, and every store
validated `sealed` after its finishing step.
W6 starts recovery once the killed process is gone, which took up to 16 ms at S1: a
SIGKILL during the 186 MB DirectStore build left the process in uninterruptible I/O
briefly, and until it exits its lease is live, so a recovery that starts at once is
refused. Both v2 publication kills landed before the link, so W6 did not exercise a kill
after the commit; `kill.test.ts` does, and shows the next reconcile settling the
published generation with no repair.
The lease in these runs is 10 minutes (`staleMs: 600000`); none was waited out.

## What Did Not Work, and Open Issues

- **Full-record-only collection grows disk by H per publish** between scrubs (147
  generations at S0); it was not run above S0. The `quick` pin is a deviation from the
  design’s section 3.7, and it narrows the recovery guarantee: between scrubs, the only
  full-verified recovery point may be older than every retained generation it protects.
- **The head is a directory listing**, not a probe from the hint, because gc can leave a
  leased generation below a gap.
  Every `currentVersion()` now reads `snapshots/`.
- **A reader can see a generation before it is power-loss durable**: between the link
  and the directory fsync.
  A writer is never told it published before the fsync.
- **A residual lock-break race** remains: a breaker that re-checks a lock, then renames
  it, can move a fresh lock created between the two calls.
  It restores what it moved; if a third process took the name meanwhile, two holders
  overlap until one fences.
  That costs a wasted build, never a publication, and the four-process race test saw
  none.
- **Zombie detection is Linux only**; elsewhere an unreaped dead owner waits for expiry.
- **The spike found two bugs that the package tests had not**: overlapping gcs
  collecting each other’s tombstones, and W6 seeing a zombie as alive.
  Both are fixed and have tests.
- **The format identity is unchanged**: the marker does not name the feature, so v2 and
  f1.0 clients on one store would be unsafe.
- **S2 was limited by disk**, which other jobs shared and which swung between 0.7 and 16
  GB free. W1 ran through DirectStore only, so H3 has no S2 figure; W2 covers p01 in the
  v2 arm only, because a disk guard stopped the f1.0 arm’s run at 0.73 GB free; and W6
  did not run at S2, as in round 1.
- **Not done**: manifests and roll-forward from manifests (design item (m)), and a
  written interleaving model of (h), which the design asks for before production code.

## How to Reproduce

The scratch layout is one directory holding the package copy and the spike copy side by
side:

```bash
R=/path/to/fsqlite; W=$PWD/spike3   # R is your fsqlite checkout; run from any empty directory
mkdir -p $W/softschema-kb/results $W/kbscratch
mkdir $W/package && tar -C $R/packages/fsqlite --exclude=./node_modules --exclude=./dist -cf - . | tar -C $W/package -xf -
(cd $W/package && patch -p1 < $R/docs/research/spikes/softschema-kb/fsqlite-v2/spike3/package.patch)
ln -s $R/packages/fsqlite/node_modules $W/package/node_modules
cp -r $R/docs/research/spikes/softschema-kb/fsqlite $W/softschema-kb/fsqlite
(cd $W/softschema-kb/fsqlite && patch -p1 < $R/docs/research/spikes/softschema-kb/fsqlite-v2/spike3/spike.patch)
ln -s $R/docs/research/spikes/softschema-kb/harness $W/softschema-kb/harness
ln -s <shared kb-corpora> $W/kbscratch/kb-corpora
(cd $W/package && node --test test/*.test.ts)
$W/softschema-kb/fsqlite/run_spike3.sh S0   # then S1; S2 with run_spike3_s2.sh
```

The f1.0 arm is a second copy at `$W/base/softschema-kb/fsqlite` with
`spike-f1.0-arm.patch` applied and the unmodified package at `$W/orig-package`; its
`run_base.sh` runs the same workflows.
Results land in `results/fsqlite-v2/spike3/<scale>/`, the f1.0 arm’s with a `base-`
prefix after copying.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
