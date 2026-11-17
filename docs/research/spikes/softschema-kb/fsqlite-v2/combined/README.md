# fsqlite v2 Combined Prototype: Spikes 3, 1, and 2

**Date:** 2026-11-17

**Status:** Integration check for the maintainer.
It applies the three v2 spike patches to one scratch copy of `packages/fsqlite` and one
of the spike’s `fsqlite/` directory, resolves their conflicts by
[the design’s](../../notes/fsqlite-v2-design.md) section 3, and checks correctness at
S1-r2. Nothing under `packages/` changed; the two patches here carry the prototype.
No timing is reported: a quiet timing pass ran on the same machine, so these runs only
check answers and states.

## Summary

The three spikes compose into one package that passes its own suite, and the combined
prototype answers every S1-r2 check like the oracle and like one writer in line order.

- **Tests.** 279 `node:test` cases run: 278 pass, 1 is skipped (the baseline’s skip,
  which needs a non-root process), 0 fail.
  The 80 CLI goldens pass, and `tsc`, `eslint`, and `prettier` are clean.
- **W3.** W1 then W3 v2 matches `expected/S1-r2/w3.json` 124 of 124, both with the
  substring scan and with the in-file FTS5 index.
- **Four writers.** With operation envelopes, p05 publishes once with no quarantine and
  matches `expected/S1-r2-p05/w3.json` 124 of 124. At p20 no edge dangles after the
  closure, and the published rows equal the line-order rows.
- **Merges.** The single closure is Spike 1’s closure at build, with Spike 2’s tombstone
  and redirect facts resolved first.
  With a reducer that keeps no facts, at p20 it moved 13 edges to their merge survivors
  and removed 15 edges of deleted nodes.
  Every survivor then carries exactly its line-order edges.
  Spike 1’s cascade relations alone also leave no dangling edge, but they delete those
  edges: the survivors end with 551 edge rows instead of 557.
- **Kill point.** A W6 kill during publication, holding the publish lease, recovers with
  no manual step and no lost generation, and all 360 captured envelopes are applied
  exactly once.

The conflicts were mostly mechanical: three spikes rewrote the same build loop and the
same apply function.
Three integration seams needed new code: reducer writes had no changed keys, two closure
mechanisms needed one order, and repair must replay single-file envelopes.

## Composition Order

The patches went on in the order 3, 1, 2, each into the result of the one before:

1. Spike 3 (`package.patch`, `spike.patch`) applied cleanly to the package and the
   spike.
2. Spike 1 failed 10 package hunks in `conflictPolicy.ts`, `directStore.ts`,
   `snapshotStore.ts`, and `types.ts`, and 4 spike hunks in `common.ts`, `trickle.ts`,
   and `w2.ts`.
3. Spike 2 failed 12 package hunks in `conflictPolicy.ts`, `snapshotStore.ts`, and
   `types.ts`, and 17 spike hunks in `common.ts`, `fsq.ts`, `trickle.ts`, `w2.ts`,
   `w2_worker.ts`, and `w3.ts`.

Each failed hunk was merged by hand, and the hunks that applied with fuzz were checked
against their intent.
Snapshots of each stage were kept to diff the merges.

## Conflicts and Resolutions

### Package

| Place | Conflict | Resolution |
| --- | --- | --- |
| `applyWithPolicy` (`conflictPolicy.ts`) | Spike 3 returns the count of resolved conflicts (conflict evidence, G5); Spike 1 adds a base-table filter; Spike 2 splits the changeset by operation for the missing-row policy and returns `{ omittedMissing }` | One function, `(db, changeset, policy, beforeCommit, baseTables?, missing?)`, returning `{ resolved, omittedMissing }`. The non-base check runs in every split pass. New rule: an omitted missing update discards a write, so it counts as conflict evidence; an omitted missing delete does not |
| `fold` (`snapshotStore.ts`) | All three rewrote the build loop: Spike 3 adds the ledger floor and conflict marks; Spike 1 adds the derived mode, changed keys, the derived step, and its gate; Spike 2 adds reducer dispatch, table admission, timings, and its closure | One loop in the order of design 3.4: copy, the build cache, the derived mode; per envelope the ledger, the floor (now also for operation envelopes), then admission and the reducer or the policy apply; then the ledger floor, the reducer stamps, the derived step (closure, cascade relations, derived update, statistics, plans), and Spike 1’s gate |
| Changed keys for reducers | Spike 1 reads changed keys from changesets; Spike 2’s reducers write the build directly, so the derived hook would see nothing | Each operation envelope runs under a session; its changeset gives the same changed keys a changeset envelope gives. A reducer that writes anything but a base table is quarantined, as Spike 1 does for changesets |
| Closure | Spike 1 has `relations` (cascade deletes from this build’s deletes); Spike 2 has a `closure` store option run after the envelopes | One closure, Spike 1’s, at build. Spike 2’s hook moves into the derived specification as `derived.closure` and runs before the cascade relations, under a session, so the edges it moves reach the relations and the derived update as changed keys. Merges stay application policy (design 3.6): the knowledge-base hook resolves redirects and tombstones, and core keeps only cascade relations |
| Repair roll-forward | Spike 3 replays retained envelopes from `tx/applied/`; Spike 2’s admission read only `tx/pending/` | Admission takes the source directory, so repair replays single-file operation envelopes; a test rolls a corrupt head forward with one |
| `FoldResult`, `ReconcileResult` | Each spike added fields | Kept all: `conflicted`, `refreshed`, `omittedMissing`, `closure`, and Spike 2’s reporting fields |
| `reconcile` | Spike 1 publishes a derived refresh with nothing pending; Spike 3 advances a lagging hint there | Both: return early only when nothing is pending and no refresh is due |
| `write` | Spike 3 checks the writer clock against the ledger floor; Spike 2 splits full and sparse capture and a shared commit; Spike 1 refuses non-base changesets at capture | One clock check used by both capture paths (sparse reads the floor through the attached head); the base-table refusal and the clock check sit in the shared commit |
| `DirectStore.write` | Spike 3 writes a ledger row and the floor before protecting owned tables; Spike 1 wraps the callback in a session and the derived step | The ledger row and floor first, then protection, the derived drop, the session, the callback, and the derived step and gate |
| Helpers | Spike 2 adds its own `txTimestamp`, which takes 12 digits of a 13-digit timestamp, and its own `sleepSync` | Spike 3’s helpers kept; Spike 2’s copies removed |
| `changesetTables` | Spike 1 (`derived.ts`) and Spike 2 (`changeset.ts`) export functions with the same name | Imported under an alias; both changeset readers remain |
| `append` temp file | Spike 2’s temp name carried no owner | Tagged with Spike 3’s `<host>-<pid>`, so recovery removes a dead appender’s temp at once |
| Publisher byte count | `runPublisher` counted a directory’s size for a changeset envelope | One helper sizes both envelope kinds; Spike 1’s rebuild ratio uses it too |

### Spike Harness

| File | Conflict | Resolution |
| --- | --- | --- |
| `common.ts` | Three results directories | `KB_RESULTS_ARM`, default `fsqlite-v2/combined`, with Spike 3’s package path and scratch layout |
| `fsq.ts` | Two package paths | Spike 3’s `../../package` |
| `mapping.ts`, `v2.ts` | Spike 1’s `genericOptions()` and Spike 2’s `v2StoreOptions()` both configure the store | `genericOptions()` adds Spike 2’s reducers and missing-row policy, and `genericDerived()` adds `kbClosure` as `derived.closure`. The closure is on by default; `KB_V2_CLOSURE=0` leaves only the cascade relations |
| `w3.ts`, `w2.ts` | Spike 2 built stores and the line-order reference with the `f1.0` DDL, whose schema hash differs from Spike 1’s base DDL | Every store opens with `genericOptions()` |
| `w2.ts` | Spike 1 replays a closure envelope unless `--no-closure-envelope`; Spike 2 only with `--repair` | One reconcile by default; `--repair` keeps round 2’s retry and closure envelope. The report merges both closure figures, and a new check counts edges on absorbed ids and digests the edges of every survivor, against the line-order store |
| `w2_worker.ts` | Spike 2’s strategies on Spike 3’s worker | Merged |
| `trickle.ts` | Spike 2’s capture arms and sustained publisher against Spike 1’s and Spike 3’s changes | Not merged: the file is Spike 3 plus Spike 1. Timing scripts were out of scope here |
| `w6.ts` | None | `--phases` runs a subset of the kill points |
| `run_combined.sh` | New | The runs below |

## Tests

| Check | Result |
| --- | --- |
| `node scripts/run-tests.mjs` (the package’s test command) | 279 tests: 278 pass, 1 skipped, 0 fail |
| `tryscript run 'test/cli-golden/*.tryscript.md'` | 80 passed |
| `tsc --noEmit` | clean |
| `eslint . --max-warnings 0` | clean |
| `prettier --check .` with the repository’s config and ignore file | clean |

The 279 cases are the 228 of the unmodified package, 24 from Spike 3, 8 from Spike 1, 14
from Spike 2, and 5 new in `test/v2-combined.test.ts`. After its suite, `run-tests.mjs`
checks the test counts quoted in the repository’s docs.
In a copy outside the repository that step finds no docs and fails; run against the
repository, it reports that `docs/qa-runbook.md` states 228 and must read 279.

Tests whose rule the combination changes on purpose:

- `test/v2-spike2.test.ts`, the closure hook test: the hook is now `derived.closure`, so
  it needs a derived specification, runs before the cascade relations, and passes the
  rows it changes to the derived update, which the test now asserts.
- `test/derived.test.ts`, one assertion: the reconcile result carries Spike 2’s
  reporting fields, so the test compares the four original fields instead of the whole
  object. The rule is unchanged.

The 5 new tests cover the seams: reducer writes reach the derived hook and a reducer
that writes a derived table is quarantined; the closure moves an absorbed node’s edges
to its survivor in one build and across builds, where the cascade relations alone delete
them; gc prunes applied single-file envelopes, and repair replays one onto a clean
generation; the missing-row policy on a derived store; and an omitted missing update
kept as conflict evidence.
Every Spike 3 test passes unchanged.

## Correctness at S1-r2

`run_combined.sh S1-r2`, with the harness comparing each W3 file by `compare.py`.
Results are in `results/fsqlite-v2/combined/S1-r2/`.

| Check | Result file | Outcome |
| --- | --- | --- |
| W1 (DirectStore, validated) then W3 v2, substring scan | `w3.json` | MATCH: 124 ok, 0 differ, against `expected/S1-r2` |
| The same, in-file FTS5 index and facet summary | `w3-fts.json` | MATCH: 124 ok, 0 differ |
| W2 p05, 4 writers, operation envelopes (`ops`), then W3 | `w3-after-p05-4writers-ops.json` | MATCH: 124 ok, 0 differ, against `expected/S1-r2-p05`; 0 quarantined, 1 publish, rows equal line order |
| W2 p20, 4 writers, `ops` | `w2-ops.json` | 0 dangling edges, rows equal line order |
| W2 p20, 4 writers, the reducer without facts (`ops-naive`) | `w2-ops-naive-closure.json` | The closure found 28 edges on deleted or absorbed ids, removed 15 and moved 13; 0 dangling; rows equal line order |
| The same with only the cascade relations (`KB_V2_CLOSURE=0`) | `w2-ops-naive-relations-only.json` | 0 dangling, but the `edge` table differs from line order |
| W6, kill during publication | `w6.json` | Recovered with no manual step; see below |

The W1 store holds 46,927 entities and 226,281 edges and is 1.0 H after gc.
At p05 every variant also matches the oracle 124 of 124, and the reader saw no error in
any run.

### Dangling Edges and Merges at p20

The p20 batch holds 9,385 operations, which the 4 writers split into 20 envelopes, with
94 merges and 188 deletes.
A merge stores a redirect from the absorbed id to its survivor, and the check compares
the head with one writer applying the batch in line order:

| Variant | Dangling edges after the closure | Edges on an absorbed id | Edges naming a survivor | Equal to line order |
| --- | --- | --- | --- | --- |
| Line order (one DirectStore write) | 0 | 0 | 557 | (reference) |
| `ops`, facts reducer and closure | 0 | 0 | 557, same digest | yes |
| `ops-naive`, combined closure | 0 | 0 | 557, same digest | yes |
| `ops-naive`, cascade relations only | 0 | 0 | 551 | no (`edge`) |

The facts reducer resolves endpoints through the stored redirects as it applies, so its
closure had nothing to do.
The reducer without facts leaves edges on absorbed ids, and the combined closure moves
them to their survivors before the cascade relations run.
With the relations alone, those edges are deleted, which is the merge effect Spike 1
found. A second pair of runs kept both p20 heads: the relations-only head lacked 12
edges, every one naming a survivor, that the combined head held.
Envelope ids interleave by time, so the counts differ from run to run.

### W6 Kill During Publication

The import (SnapshotStore route, 360 envelopes of 1,000 rows) was killed by SIGKILL
while it held the publish lease during publication, before the link.

- `validate` reported `in-flight-capture`: a build transient and a lock whose owner
  process is gone.
- `repair` broke the dead owner’s lock and removed the build transient, with no manual
  step, and `validate` then reported `live`. Generation 0 existed before and after, so
  no published generation was lost.
- The finishing reconcile published all 360 envelopes in one generation: 360 in the head
  ledger, each once; 46,927 entities; `sealed`.

## What Still Fails or Is Missing

- **The doc count check.** `docs/qa-runbook.md` must read 279 for the package’s test
  command to pass in the repository.
- **The schema-agnostic CLI cannot roll forward.** `fsqlite repair` opens a store
  without its schema, derived specification, or reducers.
  On a corrupt head it refuses with a schema hash mismatch and publishes nothing; only
  the application’s handle can roll forward.
  This is Spike 3’s rule, but the combination makes the application code necessary in
  more places.
- **Changed keys are approximate.** They come from the changesets, so an operation that
  the missing-row policy omitted is still reported, and a key can repeat.
  Derived hooks must be idempotent per key.
- **The knowledge-base closure trusts tombstones.** An upsert clears a tombstone only in
  a loader that saw the delete.
  A reducer without facts, or a changeset writer, could leave a tombstone on a live
  node, and `kbClosure` would then delete that node’s edges.
  It did not happen at p05 or p20; removing only edges of absent nodes would close it.
- **Bulk builds and reducers.** When pending bytes exceed half the base, the build drops
  the derived indexes before the reducers run, so a reducer that reads through them
  scans. W2 never reached that mode.
- **Operation envelopes skip the capture clock check.** `append` does not read the head,
  so a writer whose clock is behind the ledger floor is quarantined as `expired` at
  reconcile instead of failing at capture.
- **Two changeset readers** remain, one in `derived.ts` and one in `changeset.ts`.
- **Spike 2’s trickle and sustained runs are not carried**, so `run_spike2.sh` fails for
  S1 and S2 against this harness.
- **Owned tables are unprotected while application hooks run** (review B, B6), from
  Spike 1. DirectStore calls `unprotectOwnedTables` and then runs the application’s
  `derived.rebuild` or `derived.update`, and reconcile runs them with no protection;
  only the closure hook is audited with a session.
  A rebuild that clears every non-base table would empty `applied_tx`, and the gate
  would not see it. `derived.ts` also opens `new DatabaseSync(':memory:')` for the
  caller’s DDL, the one connection that skips `connect()` and its pinned defensive flag.
  A real v2 must keep the triggers on and stamp `fsqlite_meta` through a path they
  allow, audit `rebuild` and `update` with a session as it audits the closure hook, fail
  a build in which `applied_tx` changed other than by fsqlite’s own insert, and open
  every connection through `connect()`.
- **The reducer guard can be disarmed by the code it guards** (review B, B6), from Spike
  2\. The guard is a row in `temp.fsqlite_guard`, so
  `UPDATE temp.fsqlite_guard SET armed =
  0` inside a reducer turns it off, and `assertCallbackBoundary` still passes; review B
  reproduced an emptied ledger with nothing refused.
  A real v2 must keep the owned-table triggers on unconditionally and stamp
  `fsqlite_meta` and `applied_tx` through a path the triggers allow.
- **The changeset reader used for admission disagrees with SQLite** (review B, B7), from
  Spike 2. `varint()` gives the ninth byte 7 bits, and SQLite gives it 8, so for a
  crafted 9-byte length the reader and `applyChangeset` see different rows: in review
  B’s probe the reader failed closed, but a crafted blob can make it see other tables
  and operations than SQLite applies, which defeats table admission and the split by
  operation. A real v2 must take table names from SQLite’s own parse (the `filter`
  callback of `applyChangeset`), or match SQLite’s varint exactly and reject over-long
  encodings, and keep that blob as a test.
- **Lease takeover trusts hostname, pid, and wall clocks** (review B, B3), from Spike 3;
  see its README for the four limits and what a real v2 needs.
- **Scratch defaults in the patched copies** (review B, B10). The patched `common.ts`
  defaults `KB_SCRATCH` to a `kbscratch/` directory beside the copy, and its `??` keeps
  an empty `KB_SCRATCH`, so stores would then land relative to the working directory;
  set `KB_SCRATCH` to a private directory.
  The base spike now requires it.
- **Not run:** the other three W6 kill points, a kill after the link (which
  `kill.test.ts` covers), changeset envelopes with the missing-row policy at S1-r2, any
  timing, and any S2 scale.
  The format identity is still `f1.0`, as in Spike 3.

## How to Reproduce

The scratch layout holds the package copy and the spike copy side by side:

```bash
R=<repo>; W=<scratch>/combined; P=$R/docs/research/spikes/softschema-kb/fsqlite-v2/combined
mkdir -p $W/package $W/softschema-kb/results $W/kbscratch
tar -C $R/packages/fsqlite --exclude=./node_modules --exclude=./dist -cf - . | tar -C $W/package -xf -
(cd $W/package && patch -p1 < $P/package.patch)
ln -s $R/packages/fsqlite/node_modules $W/package/node_modules
cp -r $R/docs/research/spikes/softschema-kb/fsqlite $W/softschema-kb/fsqlite
(cd $W/softschema-kb/fsqlite && patch -p1 < $P/spike.patch)
ln -s $R/docs/research/spikes/softschema-kb/harness $W/softschema-kb/harness
ln -s <scratch>/kb-corpora $W/kbscratch/kb-corpora
(cd $W/package && node scripts/run-tests.mjs)
KB_SCRATCH=$W/kbscratch $W/softschema-kb/fsqlite/run_combined.sh S1-r2
```

Prettier needs the repository’s settings outside the repository:
`prettier --check . --config $R/.prettierrc.json --ignore-path $R/.prettierignore`.

## Files

- `package.patch`: `diff -ruN` of the package copy against `packages/fsqlite`.
- `spike.patch`: `diff -ruN` of the spike copy against
  `docs/research/spikes/softschema-kb/fsqlite`.
- `results/fsqlite-v2/combined/S1-r2/`: `w1.json`, `w3.json`, `w3-fts.json`, the three
  `w2-*.json` runs with their `w3-after-p05-*` checks, and `w6.json`.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
