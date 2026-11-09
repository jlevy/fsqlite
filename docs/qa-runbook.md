# fsqlite QA Runbook

The pre-publish quality gate for `fsqlite`: **Part A** maps every automated test to the
guarantee it protects, **Part B** is the step-by-step manual review a human runs before
publishing, and **Part C** lists what is deliberately *not* covered automatically (and
why) so the manual review can decide whether to accept the residual risk.

The two correctness invariants that every check supports are:

- **R1 (bounded loss):** a crash, paused publisher, torn capture, or interrupted
  protocol operation loses at most the unpublished tail and never a previously published
  snapshot. Live backup means a pinned immutable snapshot or a supported backup/seal
  operation, not an arbitrary recursive directory copy.
- **R2 (no silent corruption):** every inconsistency is detectable and surfaced by
  `validate`, never silently accepted.

Run the whole automated gate, the same one CI and the publish workflow run, with:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm verify
```

`pnpm verify` runs, in order: the Prettier and flowmark format checks, zero-warning
ESLint, `tsc --noEmit`, the project-hook tests, the supply-chain gate, and `test:all`
(doc and link checks, `node:test`, CLI goldens, the build with publint, and the
clean-room package smoke).
Run it from the repository root.
The JavaScript tools resolve from this workspace’s lockfile.
The flowmark check runs through `uvx` (pinned `flowmark-rs`), so it needs `uv` and, on
first use, a network download of that exact release; `CONTRIBUTING.md` lists the setup.

Current status: **220 `node:test` cases**, **78 CLI golden cases**, `tsc` clean,
zero-warning lint, `dist` build and clean-room package smoke green.

* * *

## Part A: Automated Coverage Map

### `node:test` Suites (`packages/fsqlite/test/*.test.ts`)

| Suite | Constraints | Guarantee it protects |
| --- | --- | --- |
| `unit.test.ts` | `C5-C8`, `C11` | Core round-trip; immutable heads; all merge policies; deny-by-default policy; idempotent reconcile; atomic data-and-ledger commit; digest, transaction identity, malformed-manifest, wrong-schema and manifest-field admission, quarantine-write, NOTFOUND quarantine, every corrupt and in-flight validation state, envelope-size handling, no-op writes, and seal/GC pinning; a reconcile that fails before publication removes its build |
| `merge-constraints.test.ts` | `C7` | Fixed filtered-pass order, UNIQUE and foreign-key closure at envelope and publication boundaries, foreign-key actions applied once from their recorded effects, a merge-created dangling reference quarantined, and policy routing by own keys only, so tables or actions named like `Object.prototype` members never drop changes |
| `init.test.ts` | `C5-C8` | Non-null primary-key contract, including the nullable `INTEGER PRIMARY KEY DESC` quirk; SnapshotStore trigger and key `ON CONFLICT REPLACE`/`IGNORE` rejection; schema-version, envelope-size, retry, and policy-table option validation; schema-hash compatibility before filesystem mutation; fenced racing first-open; refusal to re-create snapshot 0 for a lineage that lost `current` |
| `hardening.test.ts` | `C6`, `C11`, `C12` | Loud capability failure, integrity diagnostics, read-lease protection from concurrent GC, and a corrupt `current` read and quoted only up to a small bound |
| `concurrent.test.ts` | `C2-C5`, `C7`, `C10` | Real multiprocess SnapshotStore capture, exactly-once racing reconcile, readers that overlap many publishes without a failed, torn, or regressing read, and serialized DirectStore writers with zero loss |
| `crash.test.ts` | `C5`, `C6` | Fault injection at publication boundaries and recovery to a consistent point |
| `kill.test.ts` | `C5` | Hard `SIGKILL` during publication without loss of a published head |
| `fuzz.test.ts` | `C5-C7` | Reproducible interleaved writer, reconciler, reader, and fault chaos |
| `fencing.test.ts` | `C3`, `C5` | Exclusive acquisition, refusal to steal old locks, token checks, heartbeat loss, and owner-write cleanup |
| `publication.test.ts` | `C5` | Paused publishers retain exclusive ownership at the pointer swap; no-replace commits, unexplained snapshot preservation, defensive identity checks, and archiving only what the published ledger holds |
| `seal.test.ts` | `C5`, `C11` | Atomic, fsynced seal output that replaces a partial file, leaves the previous file on a failure before commit, refuses store-owned destinations, and reports a corrupt head as corrupt |
| `gc-lease.test.ts` | `C4`, `C6`, `C11` | Retention of current, recent, and leased snapshots; malformed lease failure; safe transient sweep; refusal on an integrity-corrupt head; publish-lock fencing; option validation; serialized lease acquisition against GC and two-phase tombstone failure recovery; a failed unlink, a pointer moved back during gc, and readLease retry exhaustion |
| `repair.test.ts` | `C5`, `C6`, `C11` | Non-destructive recovery-point selection, existing-lock refusal, quiescent abandoned-lock recovery, mutation revalidation, transient cleanup (including init journals and lease temps), never quarantining a live or just-committed envelope, lock loss at acquisition, and a `planRepair()` dry run that changes nothing |
| `retry.test.ts` | `C7`, `C10` | Strict point-row optimistic compare and retry without retrying permanent failures, and a write reconcile could not publish reported as pending rather than retryable |
| `nfs-sim.test.ts` | `C3` | Network-shaped close-to-open visibility plus rename and directory-creation semantics |
| `portability.test.ts` | `C1` | A published snapshot opens as plain SQLite across bindings |
| `direct.test.ts` | `C5`, `C8-C10` | DirectStore publication, format interoperability, trigger support that SnapshotStore refuses to open, schema admission before callbacks, retry fencing, callback boundary, and owned-metadata protection |
| `driver-capabilities.test.ts` | `C1`, `C12` | Session and backup capability probes, reconcile-build connection settings, defensive mode on every connection where the binding has it, and integrity-clean online backup |
| `adoption.test.ts` | `C7`, `C10` | A realistic multi-table schema and policy through the public API |
| `sqlite-facts.test.ts` | `C1`, `C11` | Schema-agnostic inspection and integrity reports for plain SQLite files |
| `store-format.test.ts` | `C6`, `C8`, `C9` | Self-identifying root, cross-file identity, recognition states including every invalid-marker rule, feature/version gating, marker fencing, and mixed-store quarantine |
| `fsinspect.test.ts` | `C3`, `C11` | Filesystem capability probes, including atomic rename, exclusive creation, visibility, mtime, required hard links and directory fsync, and WAL negative control; mountinfo parsing (escaped paths, network and volatile filesystems) and the verdict rules |
| `fsutil.test.ts` | `C3`, `C5` | Pointer-temp cleanup and fail-closed directory fsync behavior |
| `errors.test.ts` | `C6`, `C11` | Typed errors, retry flags, and machine-coded quarantine reasons. The GC and retry suites cover lease I/O and captured transactions. |
| `read-retry.test.ts` | `C4`, `C11` | A reader whose snapshot gc collects after the pointer read retries on the new head, within a bound, and a pointer to a missing snapshot stays corruption |
| `cli.test.ts` | `C11` | The importable CLI runs nothing on import, returns exit codes, maps every state and error code to its exit code, and prints cause chains |
| `examples.test.ts` | `C10`, `C11` | Both runnable examples complete and their own result checks pass |
| `cli-bin.test.ts` | `C11` | The bin keeps the exit code when stdout or stderr closes early and hides only node:sqlite’s experimental notice |

### Multiprocess Worker Harness (`workers/`)

Spawned as real child processes by the suites above, so the concurrency proofs are
cross-process, not in-thread: `writer.ts`, `reader.ts`, `reconciler.ts`,
`lock-holder.ts`, `direct-writer.ts`, `init-worker.ts`.

### CLI Golden Tests (`test/cli-golden/cli.tryscript.md`, 78 console cases)

Exercises the real CLI (`src/cli/bin.ts`) end to end with Node’s default warnings,
asserting stdout, stderr, and the exit code: global and per-command help, `--version`,
and every usage error (unknown command or option, missing or extra arguments, a flag
never taken as a path, invalid `--retain` values that delete nothing); text and `--json`
output of `info`, `validate`, `stats`, `gc`, and `doctor`; the exit codes of sealed,
live, in-flight, invalid, unsupported, corrupt, and not-a-store paths across commands,
including `info` and `stats` on a corrupt store; `repair --dry-run` changing nothing and
`repair`; `gc` refusing a corrupt head or a torn lease (with its cause) and deleting
nothing; `seal` with a stock-`sqlite3`-readable header and its refusals, including a
corrupt head; `doctor` on clean and corrupt plain SQLite files and `doctor --fix`; and
`fsinspect`, whose machine-dependent report is checked for its shape and for an exit
code that matches its verdict.

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
pnpm verify
```

- **Expect:** the format, lint, type, hook, and supply-chain stages exit 0; node:test
  reports `ℹ tests 220` and `ℹ fail 0` (as root, one test reports skipped because it
  needs a non-root process); goldens `78 passed`; build emits `dist/index.mjs`,
  `dist/index.d.mts`, `dist/cli/index.mjs`, `dist/cli/bin.mjs`; package smoke prints
  `package smoke test passed`.
- **PASS:** `pnpm verify` exits 0 with the counts above.

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
console.log("read", s.read(db => ({ ...db.prepare("SELECT v FROM kv WHERE k=?").get("a") })));
'
```

- **Expect:** `applied 1` then `read { v: '1' }`.
- **PASS:** the value round-trips through a reconcile.

### B3. CLI Walkthrough on a Real Store

```bash
node packages/fsqlite/test/cli-golden/seed.ts "$QA/cli"          # build a known store
node packages/fsqlite/src/cli/bin.ts info     "$QA/cli"
node packages/fsqlite/src/cli/bin.ts validate "$QA/cli"; echo "exit=$?"
node packages/fsqlite/src/cli/bin.ts stats    "$QA/cli"
node packages/fsqlite/src/cli/bin.ts gc       "$QA/cli" --retain 1
node packages/fsqlite/src/cli/bin.ts seal     "$QA/cli" "$QA/export.sqlite"
node packages/fsqlite/src/cli/bin.ts doctor   "$QA/cli"
```

- **Expect:** `$QA/cli/fsqlite.json` contains `format: "fsqlite"`,
  `format_version: "f1.0"`, and a UUID `store_id`; `info` prints `state: sealed` and
  `current: 1` (add `--json` for JSON); `validate` prints `sealed` and `exit=0`; `stats`
  reports `kind: fsqlite-store` with deterministic `application_id`/`user_version`/table
  counts; `gc` prints what it removed and kept; `seal` writes the export; `doctor`
  prints binding capabilities and `store: sealed`.
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
node packages/fsqlite/src/cli/bin.ts stats  "$QA/plain.db"
node packages/fsqlite/src/cli/bin.ts doctor "$QA/plain.db"; echo "exit=$?"
node packages/fsqlite/test/cli-golden/seed.ts "$QA/bad.db" corrupt-sqlite
node packages/fsqlite/src/cli/bin.ts doctor "$QA/bad.db"; echo "exit=$?"
```

- **Expect:** `stats` labels `kind: plain-sqlite (no fsqlite layer)` and reports
  `widgets=3`; `doctor` on the clean file prints `integrity: ok` with `exit=0`; `doctor`
  on the corrupt file reports a non-`ok` integrity line with `exit=3`.
- **PASS:** the tool works on any SQLite path and the corrupt file is caught (R2).

### B6. Damage Detection and Repair (R1 and R2)

```bash
node packages/fsqlite/test/cli-golden/seed.ts "$QA/inflight" orphan
node packages/fsqlite/src/cli/bin.ts validate "$QA/inflight"; echo "exit=$?" # in-flight
node packages/fsqlite/src/cli/bin.ts repair "$QA/inflight" --dry-run # plan only
node packages/fsqlite/src/cli/bin.ts doctor "$QA/inflight" --fix
node packages/fsqlite/src/cli/bin.ts validate "$QA/inflight"; echo "exit=$?" # repaired
node packages/fsqlite/test/cli-golden/seed.ts "$QA/corrupt" corrupt
node packages/fsqlite/src/cli/bin.ts validate "$QA/corrupt"; echo "exit=$?" # corrupt pointer
```

- **Expect:** the in-flight store validates with `exit=2`, `repair --dry-run` lists
  `remove orphan snapshot 2` and changes nothing, `doctor --fix` restores it, then
  `validate` is `sealed` with `exit=0`; the corrupt-pointer store validates with
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
node packages/fsqlite/src/cli/bin.ts fsinspect "$QA"; echo "exit=$?"
# If you have a network/cloud-sync mount, point fsinspect at it too:
# node packages/fsqlite/src/cli/bin.ts fsinspect /path/to/nfs-or-sync-dir
```

- **Expect:** a capability report; `fsqlite-safe` verdict on a normal local FS
  (`exit=0`, and `exit=5` when the filesystem cannot host a store).
  On a WAL-hostile filesystem the WAL negative control is expected to fail while the
  fsqlite primitives still pass: that is the intended signal, not a regression.
  A tmpfs, ramfs, or `volatile` overlayfs target fails `durableFsync`.
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
   Heartbeats report liveness; a stale timestamp never permits takeover.
   **Manual check:** pause a publisher beyond `staleMs` and verify contenders time out.
   For crash recovery, stop and prevent restart of every client on every host, verify
   none can resume, remove only the abandoned `publish.lock`, and run repair before
   restarting. Never use lock age or PID metadata alone as proof of quiescence.
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
