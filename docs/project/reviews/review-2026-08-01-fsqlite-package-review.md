# Engineering Review: fsqlite 0.1.0 (PR #1)

**Date:** 2026-08-01 · **Scope:** `jlevy/fsqlite` PR #1 (`codex/fsqlite-alpha` →
`main`), 99 files, +14,639 · **Reviewed at:** `5ea2ef7`

A full design and implementation review of the standalone fsqlite package: the `f1.0`
format specification, the design rationale and its supporting research, the Node
reference implementation, the CLI, the test suite, and the release machinery.

Findings are ordered design-first, then implementation.
Every claim below was reproduced against this branch; the reproduction is included
inline.

* * *

## Verdict

This is unusually strong work.
The format-first framing is correct, the correctness argument is sound, and the research
behind it is the best I have reviewed in a package of this size.
I checked the load-bearing external claims independently and they hold.

The design is not, however, closed over **caller-declared constraints other than the
primary key**. `UNIQUE`, `FOREIGN KEY`, and `CHECK` are enforced when a writer captures
its envelope and then silently discarded or violated when the reconciler merges it ,
including cases that publish a snapshot which `validate()` reports as `sealed`. That
directly contradicts invariant **R2 (no silent corruption)** for a class of schemas that
ordinary adopters will write on day one.
Three of the four blocking findings below are facets of this single gap.

Separately, the two commands in the root README (`pnpm install && pnpm verify`) both
fail on a clean clone, and one of the manual pre-publish QA gates validates nothing.

None of this is deep.
The architecture holds; the gaps are at its edges and are addressable inside the alpha
window.

**Recommendation: request changes**, gated on B1-B4 below.
Everything else is post-alpha-shaped.

### Blocking for 0.1.0

| # | Finding | Kind |
| --- | --- | --- |
| **B1** | `pnpm install` and `pnpm verify` both fail on a clean clone (placeholder left in `pnpm-workspace.yaml`) | Release |
| **B2** | `lww` silently drops rows on `UNIQUE`/`CONSTRAINT` conflicts; ledger and `validate()` both report success | Correctness (R2) |
| **B3** | Concurrent writers publish dangling foreign keys; `validate()` reports `sealed` | Correctness (R2) |
| **B4** | QA runbook step B7 injects no crash and cannot fail: a pre-publish gate that validates nothing | Process |

### Strongly recommended before wider adoption

D1 (write-amplification disclosure), D2c (policy pass order is JS-object-key-order
dependent), D3 (`repair` cannot clear a stale publish lock), I3 (suite fails as root),
I5 (no path to the `latest` dist-tag).

* * *

## What is right

Worth stating plainly, because it is the reason the rest is worth this much scrutiny.

- **The format-first framing is correct and well-defended.** “A format and coordination
  protocol, with a Node reference implementation” is the right primary artifact for the
  stated goal, and the Iceberg/Delta analogy is apt rather than decorative, both really
  do commit by atomic pointer swap over immutable files with multiple engines against
  one spec. `fsql-format-spec.md` is a genuine normative spec with RFC 2119 language,
  four conformance roles, and labelled invariants (M1-M5, S1-S6, P1-P3, W1-W4, F1-F6,
  L1-L5, RL1-RL2, G1-G3). Most projects at this stage ship a README and call it a
  format.
- **The core correctness argument is sound.** Immutable published heads + atomic pointer
  swap + a per-snapshot `applied_tx` ledger committed in the *same* transaction as the
  data + OCC on `current` genuinely does make exactly-once folding independent of lock
  perfection. §1’s claim that “the lock is not load-bearing for correctness” is true as
  specified, and the fault-injection and SIGKILL suites test it rather than assert it.
- **Choosing `mkdir` over `flock`/`fcntl` is right**, and Finding B’s “cross-host
  theorem” reaches the correct conclusion for the correct reason: fine-grained locking
  is an in-memory structure, so across hosts it must become a commit, not a lock.
- **The two-lane strategy is a genuinely good call.** `DirectStore` removing the session
  requirement for writers is the difference between “Node-only for now” and “any SQLite
  build,” and keeping it opt-in rather than auto-selected from filesystem detection is
  exactly right, detection is unreliable and the dangerous cases look local.
- **Recognition is properly separated from health.** `not-a-store` / `invalid` /
  `unsupported` / `corrupt` as distinct states, with `unsupported` explicitly not
  repairable, is a subtlety most implementations get wrong.
- **The honesty posture is real, not performative.** The visibility lag, the
  weaker-than-serializable isolation, the un-run cross-host gate, and the
  envelope-durability caveat are all disclosed in the README, the design doc, and the
  spec.

### Research corroboration

The user asked specifically that the research be checked rather than taken on trust.
I verified the load-bearing and drift-prone claims:

| Claim | Status |
| --- | --- |
| `node:sqlite` is Stability 1.2 (Release candidate), since v25.7.0 | **Confirmed** (current Node docs; Node is now at 26.x) |
| Bun still does not implement `node:sqlite`; not a writer runtime | **Confirmed** (oven-sh/bun discussion #27092) |
| `application_id` `0x4653514C` is unused in SQLite’s `magic.txt` | **Confirmed** against `sqlite/sqlite` master; the doc is also correctly honest that SQLite is not an allocation authority |
| Session extension is compiled into `node:sqlite`; `better-sqlite3` omits it | **Confirmed** by the capability probe and by `driver-capabilities.test.ts` |
| REPLACE is legal only for DATA/CONFLICT conflict types | **Confirmed**, and correctly implemented in `replaceable()` |

Three places where the research and the shipped code have quietly diverged:

1. **Finding I prescribes a pragma recipe** for the DirectStore transaction
   (`journal_mode=DELETE`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000`).
   **None of it is applied**, `driver.open()` is a bare `new DatabaseSync(path)`. In
   practice the behaviour is mostly right because SQLite and `node:sqlite` defaults
   happen to match (rollback journal by default; `enableForeignKeyConstraints` defaults
   to `true`, which I confirmed by observing an FK violation thrown during capture).
   But spec **S5** ("a published snapshot MUST NOT have live `-wal`/`-shm` side files")
   is currently an invariant *inherited from a default* rather than one the
   implementation asserts.
   Set the pragmas explicitly, or state in the spec that they are inherited and test the
   inheritance.
2. **The research’s R-THREAD requirement is satisfied by “a small in-process mutex that
   serializes this implementation’s own multi-step protocol actions.”** No such mutex
   exists. I believe it is genuinely unnecessary: the driver opens and closes a fresh
   connection per operation and never shares one, but the two documents should agree.
   The design doc already states the weaker, accurate position; the research should be
   reconciled to it rather than left describing a component that was never built.
3. **`docs/roadmap.md` and the research both list Worker Thread coordination as required
   work**, and it has no test.
   Fine as a disclosed gap; just noting the claim and the coverage do line up as “not
   done.”

* * *

## Design findings

### D1, Write amplification is the design’s binding constraint, and it is under-disclosed

**Severity: high (disclosure, not correctness).**

Every `write()` with the default `seed: 'snapshot'` copies the entire current snapshot
to build the writer’s working copy.
The cost is linear in store size, not in the size of the change.
Measured on this branch (2 KB rows, local disk):

```
rows=   500  snapshot=   2.0 MiB   write=  11.79 ms/op   reconcile(15 tx)=  100 ms
rows=  2000  snapshot=   7.9 MiB   write=  21.19 ms/op   reconcile(15 tx)=  113 ms
rows=  8000  snapshot=  31.6 MiB   write=  72.47 ms/op   reconcile(15 tx)=  150 ms
rows= 20000  snapshot=  78.8 MiB   write= 183.59 ms/op   reconcile(15 tx)=  297 ms
```

Cleanly linear at ~2.3 ms per MiB. Extrapolating, a 1 GiB store costs roughly **2.4
seconds per single-row write**, and writing one 2 KB row at 79 MiB moves ~79 MiB of I/O
, a write amplification around **40,000×**. `writeWithRetry` and the documented
“reconcile after write for a durability receipt” pattern each pay it **twice** (the
write copies, then the reconcile copies again).

This is the single most important number for the stated use case: a store embedded in
many tools with several agents writing concurrently, and it is currently disclosed only
in a JSDoc comment on `write()` and in research Finding J. It is **not** in the package
README’s Limitations, **not** in the design doc’s trade-off discussion, and **not** in
the format spec.

The research is aware of the crossover and measured it; the packaging simply does not
carry the finding forward to where an adopter will see it.

**Recommendation.** Put it in the README Limitations and the design doc’s trade section
with a concrete number and a sizing rule of thumb ("expect ~N ms per MiB per write;
above ~X MiB, use `schema-only` seeding for insert-heavy writers or shard the store").
Consider a soft warning above a configurable snapshot-size threshold.
The “shared read-only base plus overlay” idea already in the research is the real fix
and belongs on the roadmap explicitly rather than inside a bullet about seeding.

### D2, Merge semantics are not closed over caller-declared constraints

**Severity: high (correctness, violates R2).**

The format spec is precise about primary keys (S4 mandates a NON-NULL PK on every caller
table, enforced at `init`) and defines merge policy entirely in terms of same-PK
conflicts. It says **nothing** about `UNIQUE`, `FOREIGN KEY`, or `CHECK`, and the words
“foreign key” appear nowhere in `fsql-format-spec.md`, `fsqlite-design.md`, or the
package README.

But those constraints *are* enforced at capture time (the binding enables FK
constraints), so a writer builds an envelope believing them to hold, and the reconciler
then merges without preserving them.
Three distinct failures, all reproduced:

#### D2a, `lww` silently drops rows on a UNIQUE collision (blocking, **B2**)

A completely ordinary schema, surrogate PK plus a `UNIQUE` natural key:

```sql
CREATE TABLE url_index (
  id TEXT PRIMARY KEY NOT NULL,
  url TEXT NOT NULL UNIQUE,
  hits INTEGER NOT NULL
);
```

Two writers register the same URL under different surrogate ids, policy
`{ url_index: 'lww', '*': 'strict' }`:

```
reconcile: applied=2  quarantined=0   (both writers got a tx id back)
published rows: [{"id":"id-A","url":"https://example.com","hits":1}]
ledger says A applied=true, B applied=true
state=sealed  -> writer B's row vanished with no quarantine and no error
```

Writer B’s row is gone.
`reconcile()` reports it applied, `applied_tx` records it as applied, `validate()` says
`sealed`, and there is no counter, reason, or quarantine anywhere.
A UNIQUE violation surfaces as `SQLITE_CHANGESET_CONSTRAINT`, which `replaceable()`
correctly excludes from REPLACE (that part is right, REPLACE there would be
`SQLITE_MISUSE`) and which then falls through to **OMIT**, discarding the change in
silence.

The spec’s §6 table does say “other conflict types fall back to `omit`”, so the
*mechanism* is documented.
The *consequence*, accepted, ledgered, permanently lost data with no signal, is not, and
it contradicts R2 and the design doc’s “clashes are quarantined, not lost.”

The same shape applies to `NOTFOUND` (an UPDATE to a row another writer deleted is
silently dropped under both `lww` and `union`). `unit.test.ts:215` tests exactly that
case and asserts the OMIT: the behaviour was chosen deliberately; only its visibility is
missing.

**Recommendation.** Count omitted changes in the conflict handler and surface them in
`ReconcileResult` (e.g. `dropped: number`, ideally per table and conflict type).
That is a small change and it converts a silent loss into an observable one, which is
all R2 actually requires.
Then decide deliberately, and document, whether `CONSTRAINT` should quarantine instead
of omit. I would argue it should, since unlike a same-PK clash the writer had no way to
anticipate it.

#### D2b, Concurrent writers publish dangling foreign keys, and `validate()` says `sealed` (blocking, **B3**)

Writer A deletes a parent row; writer B adds a child referencing it.
Each is valid against the published base and valid at capture:

```
reconcile: applied=2 quarantined=0
published snapshot has 1 child row(s) with a dangling FK

validate() says          : sealed   <- R2 claims every inconsistency is surfaced
PRAGMA foreign_key_check : [{"table":"child","rowid":1,"parent":"parent","fkid":0}]
PRAGMA quick_check       : [{"quick_check":"ok"}]   <- what the publish gate actually runs
```

Neither `quick_check` (the reconcile publish gate, F4) nor `integrity_check`
(`validate`, `seal`, `repair`) verifies foreign keys, that requires
`PRAGMA foreign_key_check`, which fsqlite never runs.
So the store’s own definition of “integrity-clean” excludes a constraint the caller
declared and the writer honoured.

This one is genuinely inherent to row-level write-set merge, since it is the referential
analogue of the write skew Finding K already discusses honestly.
What is *not* acceptable is that it is undisclosed and undetected.

**Recommendation.** Pick one and state it normatively in the spec: either (a) declare
foreign keys unsupported for `SnapshotStore` and reject FK-bearing schemas at `init`
(consistent with how S4 handles primary keys), or (b) add `PRAGMA foreign_key_check` to
the publish gate and to `validate`, and define the resulting state.
(b) is more useful and costs one pragma per publish.
Either way the design doc needs a short “what merge does and does not preserve” section
covering `UNIQUE`, `FOREIGN KEY`, and `CHECK`.

#### D2c, Policy pass order depends on JS object key insertion order

The per-table policy is realised as one filtered `applyChangeset` pass per distinct
action: a sound response to the binding limitation, and correctly source-pinned in
`upstream-source-confirmations.md`. But the pass order comes from:

```ts
const used = new Set(Object.values(policy))
```

`Object.values` preserves insertion order, so **the order of the passes is the order the
caller happened to declare the tables in**. Same policy, same envelope, different
literal ordering:

```
One internally-consistent envelope (parent + its child), split across policy passes:

parent:lww  child:lww   (same pass)      applied=1 quar=0  parent=1 child=1
parent:lww  child:strict(2 passes)       applied=1 quar=0  parent=1 child=1
child:strict parent:lww (reordered)      applied=0 quar=1  parent=0 child=0   <-- !
```

Merely writing `{ child: 'strict', parent: 'lww' }` instead of
`{ parent: 'lww', child: 'strict' }` causes the `strict` pass to run first, apply the
child in isolation, hit a deferred FK violation because its parent has not been inserted
yet, ABORT, and quarantine an envelope that was internally consistent.

This matters beyond the FK case:

- It **violates the spec’s determinism requirement** (§6: “any two reconcilers folding
  the same tail build equivalent snapshots”). Two conforming implementations, or two
  call sites in the same program, can legitimately differ.
- It makes `strict`, which is the **default** `'*'` action, the most exposed: any
  FK-bearing schema where the child table is left on the deny-by-default and the parent
  is not is a coin flip on declaration order.
- The spec does not define pass ordering at all, so an independent implementer has
  nothing to conform to.

**Recommendation.** Define a deterministic pass order normatively in §6, sorting by
action name is sufficient and free, and add a regression test that runs the same policy
under permuted key orders and asserts identical outcomes.
Longer term, note in §6 that multi-pass apply cannot preserve cross-table constraints
within one envelope, which is the real root cause.

### D3, `repair` cannot clear the most likely piece of crash debris

**Severity: medium-high (design; the spec mandates the behaviour).**

A publisher SIGKILLed mid-publish leaves `publish.lock/` behind.
Nothing else is wrong with the store:

```
validate() -> state=in-flight-capture
             issues=["publish.lock present (reconcile in progress or crashed)"]
CLI would exit 2 (in-flight-capture) and docs say: run 'fsqlite doctor --fix'

repair() THREW: repair refused: publish.lock is present; wait for the publisher or
                clear it through normal lock recovery
```

`validate` diagnoses the state, the CLI exits 2, the README points the operator at
`doctor --fix`, and `repair()` refuses to run on exactly that state.
The error suggests “normal lock recovery,” which is neither a documented procedure nor a
CLI command.

This is not an implementation slip, spec §11 step 2 says repair “MUST refuse to begin
while any publisher lock is present; it never deletes or breaks that lock itself.”
The implementation is faithful; **the spec has the gap**, because it does not
distinguish a *live* holder (refuse, correctly) from a *stale lease* (reclaimable, and
already reclaimed automatically by any `withLock` caller after `staleMs`).

The store is not permanently wedged: the next reconcile or DirectStore write breaks the
stale lease, but a read-mostly store can sit in `in-flight-capture` indefinitely, and
the operator tool has no answer.

**Recommendation.** Amend §11 to permit repair to reclaim a lock whose mtime is past the
stale window, using the same fenced acquisition path as everything else, and refuse only
for a fresh one. Add `fsqlite unlock <dir>` for the explicit operator escape hatch.

### D4, Long critical sections against a 20 s stale window, with no heartbeat

**Severity: medium (liveness, not correctness).**

`heartbeat()` is implemented and exported but **never called by the engine**, not in
`reconcile`’s publish, not in `DirectStore.write`, not in `init`, not in `repair`.
Meanwhile:

- `DirectStore.write` holds the lock across `copyFileSync` → caller mutation →
  `quick_check` → `fsync` → rename.
  All O(snapshot size).
  At 79 MiB that is already ~200 ms of copy alone; at 1 GiB it is seconds.
- `repair` holds the lock across a full `integrity_check` of **every** snapshot in the
  store.

Defaults are `staleMs` 20 s and `timeoutMs` 30 s. Correctness survives, fencing (L3) and
OCC catch a stolen lease and turn it into a retry, but a critical section that exceeds
20 s gets its lock broken, retries the same expensive work, and can livelock, while
waiters hit `LockTimeoutError` at 30 s.

Spec L2 already says a live long holder **SHOULD** touch the lock dir.
Nothing does.

**Recommendation.** Heartbeat inside the long-running sections (a periodic `utimes` from
the copy loop, or before each snapshot’s `integrity_check` in repair), and/or make
`staleMs` scale with snapshot size.
At minimum, document a store-size ceiling for `DirectStore` at default lock settings.

### D5, Spec/implementation divergences worth closing

- **`init()` does not fence.** It calls `withLock(this.publishLock, () => {...})` with a
  callback that ignores the token and never revalidates ownership, yet it renames a
  snapshot into place and swaps the pointer.
  Spec **L3** requires *every* holder to re-verify its token immediately before the
  destructive publish step.
  Low practical risk (initializers converge on an equivalent snapshot 0, and
  `_verifyCompatible` catches divergent schemas), but a second initializer can rename
  over an already-published snapshot 0, which S6 forbids ("a published snapshot file
  MUST never be modified").
- **`repair()` has a TOCTOU against its own refusal.** It checks
  `existsSync(this.publishLock)` and then calls `withLock`, which is free to *break* a
  stale lock, so a publisher lock that appears between the two can be broken by repair,
  contradicting §11’s “never deletes or breaks that lock itself.”
- **Root-level transients are unswept and unreported.** `publishPointer` and
  `createStoreMarker` write `current.<hex>.tmp` / `fsqlite.json.<uuid>.tmp` in the store
  root. These match the spec’s transient grammar (§2, suffix `.tmp`), but `validate`
  scans only `snapshots/` and `tx/pending/`, and so does the GC sweep.
  A leaked root temp is invisible forever.
  Either add the root to both scans or exclude it explicitly in §2.
- **§14 skips O1 and O4** with no explanation, and neither is referenced anywhere in
  `docs/`. Renumber or add a one-line “resolved in review” note.

### D6, The caller-callback trust boundary is undefined

`WorkFn` receives a raw writable `DatabaseSync`. In `DirectStore` that handle points at
the **next published snapshot**. A caller can `DROP TABLE applied_tx`, rewrite
`fsqlite_meta`, or change `PRAGMA user_version`, and the only publish gate is
`quick_check`, which notices none of it.

The store is recoverable (the next open fails identity verification, and `repair` rolls
back to the prior snapshot), so this is a robustness rather than a durability issue, but
the failure mode is a bricked head until somebody runs repair, from an ordinary
programming mistake rather than malice.

**Recommendation.** Re-assert the identity invariants on the build immediately before
publish, `application_id`, `user_version`, the presence of `applied_tx`/`fsqlite_meta`,
and the stamped `store_id`/`format_version`. That is three pragmas and two selects on a
path that already fsyncs the whole file.
The research’s “cooperative writer boundary” is about *other processes*; this is about
the callback fsqlite itself invokes, and deserves its own sentence in the design doc.

### D7, `seed: 'schema-only'` is a silent-data-loss mode

The option is documented as “ONLY valid for inserts of NEW keys,” and the research
measured its value (flat ~16 ms/write vs.
snapshot-seed’s growth).
But nothing enforces it:

- An `UPDATE` or `DELETE` against the empty seed matches no rows, records nothing, and
  is silently lost, `write()` returns `null` as though the caller’s function was a
  no-op.
- An `INSERT` of a key that already exists is captured as an insert, collides at apply
  as `CONFLICT`, and under `lww` **REPLACE**s the existing row, clobbering columns the
  writer never read.

Both are silent, both contradict R2, and `writeWithRetry` accepts `seed` without comment
even though re-running a read-modify-write against an empty seed is exactly the unsafe
case.

**Recommendation.** Inspect the changeset before writing the envelope and reject
non-INSERT operations when `seed === 'schema-only'`; the changeset iterator makes this
cheap. At minimum, refuse the combination `writeWithRetry` + `schema-only`.

* * *

## Implementation findings

### I1, `pnpm install` and `pnpm verify` both fail on a clean clone (blocking, **B1**)

`pnpm-workspace.yaml` ships an unfilled placeholder:

```yaml
allowBuilds:
  lefthook: set this to true or false
```

Reproduced from a fresh clone of the PR head:

```
plain install exit=1                 # ERR_PNPM_IGNORED_BUILDS: lefthook@2.1.10
verify-after-plain-install exit=1    # runDepsStatusCheck re-runs install, same failure
```

The root README’s entire getting-started section is:

```bash
pnpm install
pnpm verify
```

Both fail. CI is green only because it passes `--ignore-scripts`, and `AGENTS.md`
documents the working incantation, so the README is the one artifact carrying the broken
command, and it is the first thing any adopter or contributor runs.

**Fix:** set `allowBuilds: { lefthook: false }` (nothing needs lefthook’s postinstall in
CI or for consumers), and make the README match `AGENTS.md`.

### I2, QA runbook B7 injects no crash and cannot fail (blocking, **B4**)

Step B7 “Crash recovery spot-check (R1)” instructs the reviewer to run
`s.reconcile({ crashAt: "after-snapshot" })`. `reconcile()` accepts only `maxRetries`
and `lockOpts`; crash injection is `setReconcileCrashForTest()`, which is **not exported
from the package entry point**. The unknown option is silently ignored:

```
NO CRASH INJECTED, reconcile returned: {"published":1,"applied":1,"quarantined":0,"attempts":1}
state after crash: sealed
```

The step’s stated expectation is that the store “validates as recoverable (not
`corrupt`)”, and `sealed` satisfies that reading.
A reviewer following the runbook ticks PASS on a gate that exercised nothing.
This is worse than a missing test, because it reports confidence it did not earn.

`crash.test.ts` does cover this properly via the real seam, so the automated coverage is
fine; it is the manual gate that is hollow.

**Fix:** rewrite B7 against `setReconcileCrashForTest` (exporting it under a clearly
internal name), or delete the step and point at `crash.test.ts`.

### I3, The suite fails when run as root (95/96)

`unit.test.ts:176` does `chmodSync(txDir, 0o500)` and asserts the quarantine write fails
with `/EACCES|permission denied/i`. Root bypasses DAC permission checks, so no error is
thrown:

```
ℹ tests 96
ℹ pass 95
ℹ fail 1
    expected: /EACCES|permission denied/i, operator: 'throws'
```

Running as root is normal in Docker images, devcontainers, and several CI runners.
The test is a good one, since it guards the “reason must be persisted before the move”
rule in F6, since it just needs
`{ skip: process.getuid?.() === 0 && 'requires non-root' }`.

### I4, CLI `process.exit()` immediately after `console.log` can truncate output

`stats`, `doctor`, `validate`, and `fsinspect` all `console.log(...)` and then
`process.exit(code)` on the next statement.
Node documents this exact hazard: “Calling `process.exit()` … forces the process to exit
*before* those additional writes to stdout can be performed,” and recommends setting
`process.exitCode` instead.
The risk is concentrated on piped stdout, which is precisely how `--json` output is
meant to be consumed (`fsqlite stats x --json | jq`). The CLI goldens run on Linux,
where this is least likely to reproduce.

**Fix:** set `process.exitCode` and return, rather than calling `process.exit()`.

### I5, The publish workflow has no path to the `latest` dist-tag

`publish.yml` hardcodes `npm publish --access public --tag alpha`, and `package.json`
sets `publishConfig.tag: "alpha"`. Every future tag, `v0.2.0`, `v1.0.0` , publishes to
`alpha`. Nothing ever sets `latest`, so a plain `npm install fsqlite` will not resolve
to a release. The `if: github.ref_name == 'v0.1.0'` / `!= 'v0.1.0'` bootstrap
special-case is also permanent dead weight after the first publish.

The rest of the release machinery is good: the tag/version equality guard, trusted
publishing with `id-token: write`, `contents: read`, the pinned `setup-uv` SHA, and the
frozen-lockfile `--ignore-scripts` install are all correct.

**Fix:** derive the dist-tag from the version (prerelease → `alpha`, otherwise `latest`)
before 1.0, and drop the bootstrap branches once `0.1.0` is out.

### I6, Redundant identity work on the hot read path

`read()` calls `readStoreMarker()`, then `currentVersion()`, which calls
`readStoreMarker()` again, then opens the snapshot and runs `_verifySnapshotIdentity`
(one pragma for `application_id` plus a `sqlite_master` probe and two `fsqlite_meta`
selects).
So a single `read()` costs two marker file reads plus four extra queries before
the caller’s function runs.
`write()` is worse: `readStoreMarker` + `currentVersion` (another) +
`assertStoreIdentity` (another, plus a whole extra read-only DB open/close) before the
snapshot copy.

Immutability makes almost all of this cacheable per handle: the marker never changes
during normal operation (§2), and a given snapshot version’s identity cannot change
because published snapshots are immutable (S6). Verify once per handle, and per version
on change.

### I7, `DirectStore` API gaps

`DirectStore` exposes
`init/read/currentVersion/validate/seal/gc/readLease/snapshotPath/write` but **no
`repair()`**. The “easy local” lane is the one most likely to be used by a single-binary
tool with no fsqlite expertise, and its recovery path requires the adopter to know they
must construct a `SnapshotStore` over the same directory.
`gc()` also drops the `transientStaleMs` option that `SnapshotStore.gc` accepts,
silently.

### I8, Smaller items

- `publishPointer` (`fsutil.ts`) leaks its temp file if `fsyncPath` or `renameSync`
  throws, no `try`/`rmSync`, unlike `readLease` and `createStoreMarker` which both do
  this correctly, and does not use `{ flag: 'wx' }`.
- `isNonEmptyStringArray` is a misnomer: it accepts an empty array (correctly, `[]` is a
  valid `required_features`) and actually checks “array of non-empty strings.”
  Rename.
- `INSERT INTO applied_tx VALUES (?, ?)` relies on column order; name the columns.
- `recognizeStore` returns hardcoded `format`/`format_version` constants rather than the
  parsed values. Equivalent today because equality was just checked, but it discards
  information a future minor-version compatibility path will want.
- `withLock` does not sleep after a failed stale-break, so a break that keeps failing
  (e.g. `EPERM`) spins tightly until the deadline.

### I9, Test coverage gaps

The suite is genuinely strong: 104 `node:test` cases (96 at review time, plus the
constraint-closure suite added when these findings were addressed), real multi-process
workers, SIGKILL, fault injection at all three publish steps, seeded chaos, 24 CLI
goldens, and a clean-room packed-tarball smoke.
`check-doc-claims.mjs` verifying that the documented test counts match reality is a nice
touch.

The gaps line up exactly with the findings above:

- **One conflict-type test only** (`NOTFOUND` → OMIT, `unit.test.ts:215`). No
  `CONSTRAINT`/UNIQUE test (D2a), no `FOREIGN_KEY` test (D2b).
- **No policy-ordering test** (D2c), permuted key order over the same policy.
- **No `foreign_key_check`** anywhere.
- **No Worker Thread test**, though the research lists it as required for R-THREAD.
- **No large-store test**, so the D4 lock-vs-`staleMs` interaction is unexercised.

* * *

## Suggested sequencing

1. **B1**, one-line fix in `pnpm-workspace.yaml` plus a README correction.
2. **B4**, fix or delete QA runbook B7.
3. **I3**, skip the permission test as root.
4. **B2/B3**: the minimum honest version is: count and report omitted changes in
   `ReconcileResult`, add `foreign_key_check` to the publish gate (or reject FK schemas
   at `init`), and add a “what merge does not preserve” section to the design doc.
   Tests for both conflict types.
5. **D2c**, sort the passes; add the permutation test.
6. **D1**, move the write-amplification numbers into the README Limitations and the
   design doc.
7. **D3/D5**, spec amendments (stale-lock reclaim in repair, `init` fencing, root
   transients, O1/O4 numbering), then implementation.
8. **I5**, dist-tag derivation before the second release.

D4, D6, D7, I6, I7 are good post-alpha issues.

* * *

## Reproduction

All findings above were reproduced against `5ea2ef7` on Node v22.22.2 (Linux).
Scripts used: a seeded write/reconcile benchmark at 500/2000/8000/20000 rows (D1); a
parent/child FK schema under permuted policy declarations (D2b, D2c); a surrogate-PK +
`UNIQUE` schema with two concurrent writers (D2a); a synthetic stale `publish.lock` with
an hour-old mtime (D3); a clean `git clone` followed by the README’s two commands (I1);
the QA runbook’s B7 snippet verbatim (I2); and
`pnpm install --frozen-lockfile --ignore-scripts && pnpm verify` as root (I3).

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
