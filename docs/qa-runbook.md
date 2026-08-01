# fsqlite QA Runbook

The pre-publish quality gate for `fsqlite`: **Part A** maps every automated test to the
guarantee it protects, **Part B** is the step-by-step manual review a human runs before
publishing, and **Part C** lists what is deliberately *not* covered automatically (and
why) so the manual review can decide whether to accept the residual risk.

The two correctness invariants that every check supports are:

- **R1 (bounded loss):** a crash, stale-lock overlap, torn capture, or hot copy taken
  while live loses at most the unpublished tail and never a previously published
  snapshot.
- **R2 (no silent corruption):** every inconsistency is detectable and surfaced by
  `validate`, never silently accepted.

Run the whole automated gate with:

```bash
pnpm test:all      # node:test, CLI goldens, build, and clean-room package smoke
pnpm lint:check    # zero-warning eslint
pnpm typecheck     # tsc --noEmit
```

Run from the repository root after `pnpm install --frozen-lockfile`. Every command
resolves tools from this workspace’s lockfile; the gate performs no network-time tool
download.

Current status: **113 `node:test` cases**, **24 CLI golden cases**, `tsc` clean,
zero-warning lint, `dist` build and clean-room package smoke green.

* * *

## Part A: Automated Coverage Map

### `node:test` Suites (`test/*.test.ts`)

| Suite | Guarantee it protects |
| --- | --- |
| `unit.test.ts` | Core round-trip (write → reconcile → read); snapshot byte-immutability; the three merge policies (`lww`, `union`, and `strict`) and deny-by-default `*`; idempotent reconcile; atomic data-and-ledger commit; digest, transaction-identity, schema, and quarantine-write failure handling (R2); NOTFOUND→OMIT; `validate` state machine; `maxEnvelopeBytes` guard |
| `init.test.ts` | NON-NULL primary-key contract enforced at `init`; schema-version compatibility on reopen; **same-version divergent-DDL rejection** via the stamped `fsqlite_meta` schema hash (single-handle and racing mismatched first-opens); **fenced first-open**: concurrent processes converge on one clean snapshot 0 |
| `hardening.test.ts` | Writer fails loudly without the session extension; `integrity_check` diagnostics surfaced (R2); read-lease protects its snapshot from concurrent `gc` |
| `concurrent.test.ts` | Real multi-process writers: zero-loss under contention; exactly-once publish across racing reconcilers; torn-read-free readers |
| `crash.test.ts` | `crashAt` fault injection mid-publish → recovery to a consistent point (R1) |
| `kill.test.ts` | Hard `SIGKILL` mid-publish → recovery, no lost published snapshot (R1) |
| `fuzz.test.ts` | Randomized chaos run (interleaved writers/reconcilers/faults) holds both invariants |
| `fencing.test.ts` | `mkdir` lease acquisition, stale-lock break, fencing token, heartbeat loss, and owner-write cleanup: a superseded builder cannot publish |
| `gc-lease.test.ts` | GC retains current, recent, and leased snapshots; read-lease heartbeat/expiry/loss; malformed fresh leases fail closed; stale-transient sweep spares fresh builds |
| `repair.test.ts` | `repair` restores the last consistent point from in-flight/orphan states (R1), preserves all snapshots when none is clean, refuses a publisher race, revalidates fencing before each mutation, and removes orphan transients |
| `retry.test.ts` | `writeWithRetry` optimistic compare-and-retry for cross-row invariants on `strict` tables, without retrying permanent quarantine reasons |
| `nfs-sim.test.ts` | Close-to-open visibility and rename/mkdir semantics fsqlite relies on (NFS-shaped) |
| `portability.test.ts` | Zip-and-go: a published snapshot opens as a plain SQLite file across bindings |
| `direct.test.ts` | `DirectStore` single-writer copy→mutate→publish; identical on-disk format |
| `driver-capabilities.test.ts` | `capabilities()` truthfully probes session/backup support and online backup remains integrity-clean during writes |
| `adoption.test.ts` | A realistic multi-table consumer schema and policy stay green |
| `seed.test.ts` | Schema-only seeding (build a store from DDL, no data copy) |
| `sqlite-facts.test.ts` | `isSqliteFile`, `sqliteFacts`, and `integrityReport` over any plain SQLite file (backs `stats` and `doctor`) |
| `store-format.test.ts` | Flat self-identifying store root; `f1.0` marker, snapshot, envelope, and application-ID identity; unmarked-directory refusal; invalid versus unsupported recognition; feature and version gating; replaced-marker fencing; mixed-store quarantine |
| `fsinspect.test.ts` | Filesystem capability probes (mkdir exclusive-create, atomic rename, O_EXCL, close-to-open, mtime, WAL negative control) |

### Multiprocess Worker Harness (`workers/`)

Spawned as real child processes by the suites above, so the concurrency proofs are
cross-process, not in-thread: `writer.ts`, `reader.ts`, `reconciler.ts`,
`lock-holder.ts`, `direct-writer.ts`, `init-worker.ts`.

### CLI Golden Tests (`test/cli-golden/cli.tryscript.md`, 24 console cases)

Exercises the real CLI (`src/cli/index.ts`) end to end: `--help` and usage with their
exit codes; `info` and `validate` on a sealed store; `validate` exit codes 0, 2, and 3
for sealed, in-flight, and corrupt stores; `gc` and `seal` with a
stock-`sqlite3`-readable export header; `stats` on an fsqlite store and on a plain
SQLite file; `doctor` on clean and corrupt plain SQLite files; and `doctor --fix`
restoring an in-flight store.

### Clean-Room Package Smoke (`scripts/package-smoke.mjs`)

`npm pack` → install the tarball into an empty throwaway project → `import` the library
by its package name and run the installed CLI bin.
Proves the *published* contract (exports, bin, types, engines), not just the source
checkout.

* * *

## Part B: Manual Review Runbook

Run from the repository root.
Each step lists the command, the expected result, and the **PASS** criterion.
Use a scratch dir: `export QA=$(mktemp -d)`.

### B1. Full Automated Gate

```bash
pnpm test:all && pnpm lint:check && pnpm typecheck
```

- **Expect:** node:test reports `# pass 113` / `# fail 0`; goldens `24 passed`; build
  emits `dist/index.mjs`, `dist/index.d.mts`, `dist/cli/index.mjs`; package smoke prints
  `package smoke test passed`; lint and typecheck exit 0.
- **PASS:** every stage exits 0 with the counts above.

### B2. Library Round Trip by Hand

```bash
node --input-type=module -e '
import { SnapshotStore } from "./packages/fsqlite/src/index.ts";
const s = new SnapshotStore(process.env.QA + "/store", {
  schema: "CREATE TABLE kv (k TEXT PRIMARY KEY NOT NULL, v TEXT)",
  conflictPolicy: { kv: "lww", "*": "strict" },
}).init();
s.write("w1", db => db.prepare("INSERT INTO kv VALUES (?,?)").run("a","1"));
console.log("applied", s.reconcile().applied);
console.log("read", s.read(db => db.prepare("SELECT v FROM kv WHERE k=?").get("a")));
'
```

- **Expect:** `applied 1` then `read { v: '1' }`.
- **PASS:** the value round-trips through a reconcile.

### B3. CLI Walkthrough on a Real Store

```bash
node packages/fsqlite/test/cli-golden/seed.ts "$QA/cli"          # build a known store
node packages/fsqlite/src/cli/index.ts info     "$QA/cli"
node packages/fsqlite/src/cli/index.ts validate "$QA/cli"; echo "exit=$?"
node packages/fsqlite/src/cli/index.ts stats    "$QA/cli"
node packages/fsqlite/src/cli/index.ts gc       "$QA/cli" --retain 1
node packages/fsqlite/src/cli/index.ts seal     "$QA/cli" "$QA/export.sqlite"
node packages/fsqlite/src/cli/index.ts doctor   "$QA/cli"
```

- **Expect:** `$QA/cli/fsqlite.json` contains `format: "fsqlite"`,
  `format_version: "f1.0"`, and a UUID `store_id`; `info` prints JSON with
  `"state": "sealed"`, `current: 1`; `validate` prints `sealed` and `exit=0`; `stats`
  reports `kind: fsqlite-store` with deterministic `application_id`/`user_version`/table
  counts; `gc` prints a JSON result; `seal` writes the export; `doctor` prints binding
  capabilities and `store: sealed`.
- **PASS:** no errors; exit codes and states as above.

### B4. Cross-Tool Readback with Stock `sqlite3`

```bash
head -c 16 "$QA/export.sqlite"; echo
sqlite3 "$QA/export.sqlite" ".tables" "SELECT count(*) FROM artifacts;"   # if sqlite3 is installed
```

- **Expect:** the header reads `SQLite format 3`; `sqlite3` lists the caller tables and
  a row count, with no fsqlite tooling involved.
- **PASS:** a sealed export is an ordinary SQLite file any tool can open.
  (Skip the `sqlite3` line if the binary is not present, and note it.)

### B5. `stats` and `doctor` Over a Plain SQLite File

```bash
node packages/fsqlite/test/cli-golden/seed.ts "$QA/plain.db" plainfile
node packages/fsqlite/src/cli/index.ts stats  "$QA/plain.db"
node packages/fsqlite/src/cli/index.ts doctor "$QA/plain.db"; echo "exit=$?"
node packages/fsqlite/test/cli-golden/seed.ts "$QA/bad.db" corrupt-sqlite
node packages/fsqlite/src/cli/index.ts doctor "$QA/bad.db"; echo "exit=$?"
```

- **Expect:** `stats` labels `kind: plain-sqlite (no fsqlite layer)` and reports
  `widgets=3`; `doctor` on the clean file prints `integrity: ok` with `exit=0`; `doctor`
  on the corrupt file reports a non-`ok` integrity line with `exit=3`.
- **PASS:** the tool works on any SQLite path and the corrupt file is caught (R2).

### B6. Damage Detection and Repair (R1 and R2)

```bash
node packages/fsqlite/test/cli-golden/seed.ts "$QA/inflight" orphan
node packages/fsqlite/src/cli/index.ts validate "$QA/inflight"; echo "exit=$?" # in-flight
node packages/fsqlite/src/cli/index.ts doctor "$QA/inflight" --fix
node packages/fsqlite/src/cli/index.ts validate "$QA/inflight"; echo "exit=$?" # repaired
node packages/fsqlite/test/cli-golden/seed.ts "$QA/corrupt" corrupt
node packages/fsqlite/src/cli/index.ts validate "$QA/corrupt"; echo "exit=$?" # corrupt pointer
```

- **Expect:** the in-flight store validates with `exit=2`, `doctor --fix` restores it,
  then `validate` is `sealed` with `exit=0`; the corrupt-pointer store validates with
  `exit=3`.
- **PASS:** in-flight is recoverable and corruption is surfaced, never silently
  accepted.

### B7. Crash Recovery Spot Check (R1)

```bash
node --input-type=module -e '
import assert from "node:assert/strict";
import { SnapshotStore } from "./packages/fsqlite/src/index.ts";
import { setReconcileCrashForTest } from "./packages/fsqlite/src/snapshotStore.ts";
const dir = process.env.QA + "/crash";
const options = { schema: "CREATE TABLE kv (k TEXT PRIMARY KEY NOT NULL, v TEXT)", conflictPolicy:{kv:"lww","*":"strict"} };
const s = new SnapshotStore(dir, options).init();
s.write("w", db => db.prepare("INSERT INTO kv VALUES (?,?)").run("a","1"));
let crash;
try {
  setReconcileCrashForTest("after-snapshot");
  s.reconcile();
} catch (e) {
  crash = e;
} finally {
  setReconcileCrashForTest(null);
}
assert.match(crash?.message ?? "", /CRASH after-snapshot/);
const s2 = new SnapshotStore(dir, options);
assert.equal(s2.validate().state, "in-flight-capture");
assert.equal(s2.repair().state, "live");
assert.equal(s2.reconcile().applied, 1);
assert.deepEqual(s2.read(db => db.prepare("SELECT k, v FROM kv").all()).map(row => ({ ...row })), [{ k:"a", v:"1" }]);
assert.equal(s2.validate().state, "sealed");
console.log("PASS: crash detected, repaired, reconciled, and sealed");
'
```

- **Expect:** the injected crash is reported; the reopened store validates as
  recoverable (not `corrupt`), `repair` returns it to a consistent state, and the
  pending write still reconciles.
- **PASS:** a crash between snapshot rename and pointer swap loses nothing published.

### B8. Concurrency Demo

```bash
pnpm --filter fsqlite demo
```

- **Expect:** the walkthrough runs concurrent writers, a reconcile, and a seal with no
  error and a consistent final count.
- **PASS:** completes cleanly; the final row count equals the number of distinct writes.

### B9. Filesystem Capability Check (This Environment and Any Target)

```bash
node packages/fsqlite/src/cli/index.ts fsinspect "$QA"; echo "exit=$?"
# If you have a network/cloud-sync mount, point fsinspect at it too:
# node packages/fsqlite/src/cli/index.ts fsinspect /path/to/nfs-or-sync-dir
```

- **Expect:** a capability report; `fsqlite-safe` verdict on a normal local FS
  (`exit=0`). On a WAL-hostile filesystem the WAL negative control is expected to fail
  while the fsqlite primitives still pass: that is the intended signal, not a
  regression.
- **PASS:** the report matches the filesystem you are on; record the verdict for the
  target deploy environment.

* * *

## Part C: Known Gaps and Exclusions

Decide during manual review whether each residual risk is acceptable for the intended
use.

1. **Real NFS and Cross-Host Gate.** Concurrency is proven across *processes* on a local
   filesystem. `fsinspect` probes filesystem semantics in one process but is a heuristic,
   not a true cross-host race.
   A multi-host soak on a real NFS, SMB, or EFS mount is **deferred**. **Manual check:**
   run B9 against the target filesystem and confirm `fsqlite-safe`.
2. **Power-Loss Durability.** Publication uses fsync barriers for the snapshot, pointer,
   and their directories, but there is **no fault-injected block-device test**
   simulating real power loss in CI. **Manual check:** reason about B7 (process-crash)
   as the closest reproducible proxy.
3. **Cross-Language Writers.** Readers work across bindings; non-Node *writers*
   (Python/APSW and Rust/rusqlite) against the format are **future work**. **Manual
   check:** B4 confirms cross-tool *reads*; writers remain Node-only for now.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
