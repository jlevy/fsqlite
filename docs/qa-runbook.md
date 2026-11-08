# fsqlite QA Runbook

The pre-publish quality gate for `fsqlite`: **Part A** maps every automated test to the
guarantee it protects, **Part B** is the step-by-step manual review a human runs before
publishing, and **Part C** lists what is deliberately *not* covered automatically (and
why) so the manual review can decide whether to accept the residual risk.

The two correctness invariants that every check supports are:

- **R1 (bounded loss):** a crash, stale-lock overlap, torn capture, or interrupted
  protocol operation loses at most the unpublished tail and never a previously published
  snapshot. Live backup means a pinned immutable snapshot or a supported backup/seal
  operation, not an arbitrary recursive directory copy.
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

Current status: **184 `node:test` cases**, **27 CLI golden cases**, `tsc` clean,
zero-warning lint, `dist` build and clean-room package smoke green.

* * *

## Part A: Automated Coverage Map

### `node:test` Suites (`test/*.test.ts`)

| Suite | Constraints | Guarantee it protects |
| --- | --- | --- |
| `unit.test.ts` | `C5-C8`, `C11` | Core round-trip; immutable heads; all merge policies; deny-by-default policy; idempotent reconcile; atomic data-and-ledger commit; digest, transaction identity, malformed-manifest, wrong-schema admission, quarantine-write, NOTFOUND quarantine, validation-state, envelope-size handling, and seal/GC pinning; a reconcile that fails before publication removes its build |
| `merge-constraints.test.ts` | `C7` | Fixed filtered-pass order, UNIQUE and foreign-key closure at envelope and publication boundaries, foreign-key actions applied once from their recorded effects, a merge-created dangling reference quarantined, and policy routing by own keys only, so tables or actions named like `Object.prototype` members never drop changes |
| `init.test.ts` | `C5-C8` | Non-null primary-key contract, including the nullable `INTEGER PRIMARY KEY DESC` quirk; SnapshotStore trigger rejection; schema-version range and schema-hash compatibility before filesystem mutation; fenced racing first-open; refusal to re-create snapshot 0 for a lineage that lost `current` |
| `hardening.test.ts` | `C6`, `C11`, `C12` | Loud capability failure, integrity diagnostics, and read-lease protection from concurrent GC |
| `concurrent.test.ts` | `C2-C5`, `C7`, `C10` | Real multiprocess SnapshotStore capture, exactly-once racing reconcile, torn-read-free readers, and serialized DirectStore writers with zero loss |
| `crash.test.ts` | `C5`, `C6` | Fault injection at publication boundaries and recovery to a consistent point |
| `kill.test.ts` | `C5` | Hard `SIGKILL` during publication without loss of a published head |
| `fuzz.test.ts` | `C5-C7` | Reproducible interleaved writer, reconciler, reader, and fault chaos |
| `fencing.test.ts` | `C3`, `C5` | Lease acquisition, stale break, token fencing, heartbeat loss, and owner-write cleanup |
| `publication.test.ts` | `C5` | Overlapping publishers after a stale break: no-replace snapshot commit, identity checks around the pointer swap, waiting on a fresh entry, no orphan after a DirectStore retry, and archiving only what the published ledger holds |
| `seal.test.ts` | `C5`, `C11` | Atomic, fsynced seal output that replaces a partial file, leaves the previous file on a failure before commit, and refuses store-owned destinations |
| `gc-lease.test.ts` | `C4`, `C6`, `C11` | Retention of current, recent, and leased snapshots; malformed lease failure; safe transient sweep; refusal on an integrity-corrupt head; publish-lock fencing; option validation; two-phase tombstone unlink against every lease interleaving |
| `repair.test.ts` | `C5`, `C6`, `C11` | Non-destructive recovery-point selection, live-lock refusal, stale-lock fencing, mutation revalidation, transient cleanup (including init journals and lease temps), and never quarantining a live or just-committed envelope |
| `retry.test.ts` | `C7`, `C10` | Strict point-row optimistic compare and retry without retrying permanent failures |
| `nfs-sim.test.ts` | `C3` | Network-shaped close-to-open visibility plus rename and directory-creation semantics |
| `portability.test.ts` | `C1` | A published snapshot opens as plain SQLite across bindings |
| `direct.test.ts` | `C5`, `C8-C10` | DirectStore publication, format interoperability, trigger support that SnapshotStore refuses to open, schema admission before callbacks, retry fencing, callback boundary, and owned-metadata protection |
| `driver-capabilities.test.ts` | `C1`, `C12` | Session and backup capability probes, reconcile-build connection settings, defensive mode on every connection where the binding has it, and integrity-clean online backup |
| `adoption.test.ts` | `C7`, `C10` | A realistic multi-table schema and policy through the public API |
| `sqlite-facts.test.ts` | `C1`, `C11` | Schema-agnostic inspection and integrity reports for plain SQLite files |
| `store-format.test.ts` | `C6`, `C8`, `C9` | Self-identifying root, cross-file identity, recognition states, feature/version gating, marker fencing, and mixed-store quarantine |
| `fsinspect.test.ts` | `C3`, `C11` | Filesystem capability probes, including atomic rename, exclusive creation, visibility, mtime, required hard links and directory fsync, and WAL negative control; mountinfo parsing (escaped paths, network and volatile filesystems) and the verdict rules |
| `fsutil.test.ts` | `C3`, `C5` | Pointer-temp cleanup and fail-closed directory fsync behavior |

### Multiprocess Worker Harness (`workers/`)

Spawned as real child processes by the suites above, so the concurrency proofs are
cross-process, not in-thread: `writer.ts`, `reader.ts`, `reconciler.ts`,
`lock-holder.ts`, `direct-writer.ts`, `init-worker.ts`.

### CLI Golden Tests (`test/cli-golden/cli.tryscript.md`, 27 console cases)

Exercises the real CLI (`src/cli/index.ts`) end to end: `--help` and usage with their
exit codes; `info` and `validate` on a sealed store; `validate` exit codes 0, 2, and 3
for sealed, in-flight, and corrupt stores; `gc` and `seal` with a
stock-`sqlite3`-readable export header; `gc` refusing an integrity-corrupt head with
exit 3 and deleting nothing; `stats` on an fsqlite store and on a plain SQLite file;
`doctor` on clean and corrupt plain SQLite files; and `doctor --fix` restoring an
in-flight store.

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

- **Expect:** node:test reports `# pass 184` / `# fail 0`; goldens `27 passed`; build
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
  regression. A tmpfs, ramfs, or `volatile` overlayfs target fails `durableFsync`.
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
   and their directories, and a missing directory fsync capability fails closed.
   fsqlite issues each barrier through Node after SQLite closes the file; on macOS that
   is `F_FULLFSYNC` (via libuv), not a cache-only `fsync(2)`. There is **no
   fault-injected block-device test** simulating real power loss in CI. **Manual
   check:** reason about B7 (process-crash) as the closest reproducible proxy.
3. **Cross-Language Writers.** Readers work across bindings; non-Node *writers*
   (Python/APSW and Rust/rusqlite) against the format are **future work**. **Manual
   check:** B4 confirms cross-tool *reads*; writers remain Node-only for now.
4. **Long Publish Leases.** DirectStore and repair can hold the publish lease across
   synchronous O(snapshot size) work.
   They renew the lease at step boundaries and fence before each destructive step, but a
   single synchronous step (one head copy, one callback, one fsync) cannot be renewed
   while it runs. **Manual check:** set `staleMs` above the measured worst-case single
   step and keep `timeoutMs > staleMs`.
5. **Platform and Thread Matrix.** POSIX publication is covered on macOS and Linux.
   Windows rename-replace races and the formal Worker Thread coordination contract are
   future gates. **Manual check:** do not extend the support claim beyond the published
   package runtime and platform statement.
6. **Large Stores.** SnapshotStore capture copies the complete head for every write.
   **Manual check:** benchmark snapshot bytes, pending count and bytes, writer
   concurrency, reconciliation cadence, retained and leased bytes, free space, and
   lifetime `applied_tx` count for the target workload.
   Start with `pnpm -F fsqlite benchmark:seed` and
   `pnpm -F fsqlite benchmark:workload-fit`; both emit their method, environment, and
   measurements as JSON and intentionally remain outside the correctness gate.
   Any alternative seed protocol must preserve the callback’s read base and reject
   unsupported mutations.
7. **Caller-Schema Migration.** `f1.0` rejects a different schema identity but does not
   migrate it. **Manual check:** deploy one exact schema and conflict policy per store
   epoch. Do not increment `schemaVersion` expecting an automatic upgrade.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
