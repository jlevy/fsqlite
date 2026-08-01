# fsqlite QA Runbook

The pre-publish quality gate for `fsqlite`: **Part A** maps every automated test to the
guarantee it protects, **Part B** is the step-by-step manual review a human runs before
publishing, and **Part C** lists what is deliberately *not* covered automatically (and
why) so the manual review can decide whether to accept the residual risk.

The two correctness invariants everything ladders up to:

- **R1 (bounded loss):** a crash, stale-lock overlap, torn capture, or hot copy taken
  while live loses at most the uncommitted tail — never a previously-published snapshot.
- **R2 (no silent corruption):** every inconsistency is detectable and surfaced by
  `validate`, never silently accepted.

Run the whole automated gate with:

```bash
cd packages/fsqlite
npm run test:all      # node:test + CLI goldens + build + clean-room package smoke
npm run lint:check    # zero-warning eslint
npm run typecheck     # tsc --noEmit
```

> **Run from a full repo checkout after `pnpm install`.** `packages/fsqlite` is
> deliberately outside the pnpm workspace and has **no package-local install yet**
> (blocked by a supply-chain cool-off on a `tsdown`→`rolldown` transitive; see Part C
> item 1). So the `test` and `test:golden` stages run standalone (`node:test`;
> `tryscript` via `npx`), but the **`build` and `test:package` stages resolve `tsdown`
> and `tsc`/`@types/node` from the repo’s installed toolchain** (`../../node_modules`).
> From a bare `packages/fsqlite` dir with nothing installed, `npm run build` fails with
> `tsdown: command not found` — that is the known gap, not a regression.
> CI runs the same stages individually via the root toolchain
> (`.github/workflows/ci.yml`, `test-fsqlite`).

Current status: **75 `node:test` cases**, **24 CLI golden cases**, `tsc` clean,
zero-warning lint, `dist` build and clean-room package smoke green.

* * *

## Part A — Automated coverage map

### `node:test` suites (`test/*.test.ts`)

| Suite | Cases | Guarantee it protects |
| --- | --- | --- |
| `unit.test.ts` | 14 | Core round-trip (write → reconcile → read); snapshot byte-immutability; the three merge policies (`lww`/`union`/`strict`) and deny-by-default `*`; idempotent reconcile; digest-mismatch and schema-hash-divergence quarantine (R2); NOTFOUND→OMIT; `validate` state machine; `maxEnvelopeBytes` guard |
| `init.test.ts` | 5 | NON-NULL primary-key contract enforced at `init`; schema-version compatibility on reopen; **same-version divergent-DDL rejection** via the stamped `fsqlite_meta` schema hash (single-handle and racing mismatched first-opens); **fenced first-open** — 8 concurrent processes converge on one clean snapshot 0 |
| `hardening.test.ts` | 3 | Writer fails loudly without the session extension; `integrity_check` diagnostics surfaced (R2); read-lease protects its snapshot from concurrent `gc` |
| `concurrent.test.ts` | 4 | Real multi-process writers: zero-loss under contention; exactly-once publish across racing reconcilers; torn-read-free readers |
| `crash.test.ts` | 2 | `crashAt` fault injection mid-publish → recovery to a consistent point (R1) |
| `kill.test.ts` | 2 | Hard `SIGKILL` mid-publish → recovery, no lost published snapshot (R1) |
| `fuzz.test.ts` | 1 | Randomized chaos run (interleaved writers/reconcilers/faults) holds both invariants |
| `fencing.test.ts` | 4 | `mkdir` lease acquisition, stale-lock break, fencing token — a superseded builder cannot publish |
| `gc-lease.test.ts` | 4 | GC retains N and leased snapshots; read-lease heartbeat/expiry; no live snapshot collected; stale-transient sweep spares fresh (possibly live) builds |
| `repair.test.ts` | 4 | `repair` restores the last consistent point from in-flight/orphan states (R1); orphan `.direct-`/`.work-` transients surfaced by `validate` and removed by `repair` |
| `retry.test.ts` | 2 | `writeWithRetry` optimistic compare-and-retry for cross-row invariants on `strict` tables |
| `nfs-sim.test.ts` | 4 | Close-to-open visibility and rename/mkdir semantics fsqlite relies on (NFS-shaped) |
| `portability.test.ts` | 3 | Zip-and-go: a published snapshot opens as a plain SQLite file across bindings |
| `direct.test.ts` | 3 | `DirectStore` single-writer copy→mutate→publish; identical on-disk format |
| `driver-capabilities.test.ts` | 2 | `capabilities()` truthfully probes session/backup support |
| `adoption.test.ts` | 3 | The document-catalog adoption example stays green (a realistic consumer shape) |
| `seed.test.ts` | 3 | Schema-only seeding (build a store from DDL, no data copy) |
| `sqlite-facts.test.ts` | 3 | `isSqliteFile` / `sqliteFacts` / `integrityReport` over any plain SQLite file (backs `stats`/`doctor`) |
| `fsinspect.test.ts` | 7 | Filesystem capability probes (mkdir exclusive-create, atomic rename, O_EXCL, close-to-open, mtime, WAL negative control) |

### Multi-process worker harness (`workers/`)

Spawned as real child processes by the suites above, so the concurrency proofs are
cross-process, not in-thread: `writer.ts`, `reader.ts`, `reconciler.ts`,
`lock-holder.ts`, `direct-writer.ts`, `init-worker.ts`.

### CLI golden tests (`test/cli-golden/cli.tryscript.md`, 24 console cases)

Exercises the real CLI (`src/cli/index.ts`) end to end: `--help`/usage and exit codes;
`info`/`validate` on a sealed store; `validate` exit codes 0/2/3 across
sealed/in-flight/ corrupt; `gc`/`seal` and a stock-`sqlite3`-readable export header;
`stats` on an fsqlite store and on a plain SQLite file; `doctor` on a clean and a
corrupt plain SQLite file; and `doctor --fix` restoring an in-flight store.

### Clean-room package smoke (`scripts/package-smoke.mjs`)

`npm pack` → install the tarball into an empty throwaway project → `import` the library
by its package name and run the installed CLI bin.
Proves the *published* contract (exports, bin, types, engines), not just the source
checkout.

* * *

## Part B — Manual review runbook

Run from `packages/fsqlite/`. Each step lists the command, the expected result, and the
**PASS** criterion. Use a scratch dir: `export QA=$(mktemp -d)`.

### B1. Full automated gate

```bash
npm run test:all && npm run lint:check && npm run typecheck
```

- **Expect:** node:test reports `# pass 75` / `# fail 0`; goldens `24 passed`; build
  emits `dist/index.mjs`, `dist/index.d.mts`, `dist/cli/index.mjs`; package smoke prints
  `package smoke test passed`; lint and typecheck exit 0.
- **PASS:** every stage exits 0 with the counts above.

### B2. Library round-trip by hand

```bash
node --input-type=module -e '
import { SnapshotStore } from "./src/index.ts";
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

### B3. CLI walkthrough on a real store

```bash
node test/cli-golden/seed.ts "$QA/cli"          # build a known store
node src/cli/index.ts info     "$QA/cli"
node src/cli/index.ts validate "$QA/cli"; echo "exit=$?"
node src/cli/index.ts stats    "$QA/cli"
node src/cli/index.ts gc       "$QA/cli" --retain 1
node src/cli/index.ts seal     "$QA/cli" "$QA/export.sqlite"
node src/cli/index.ts doctor   "$QA/cli"
```

- **Expect:** `info` prints JSON with `"state": "sealed"`, `current: 1`; `validate`
  prints `sealed` and `exit=0`; `stats` reports `kind: fsqlite-store` with deterministic
  `application_id`/`user_version`/table counts; `gc` prints a JSON result; `seal` writes
  the export; `doctor` prints binding capabilities and `store: sealed`.
- **PASS:** no errors; exit codes and states as above.

### B4. Cross-tool readback with stock `sqlite3`

```bash
head -c 16 "$QA/export.sqlite"; echo
sqlite3 "$QA/export.sqlite" ".tables" "SELECT count(*) FROM artifacts;"   # if sqlite3 is installed
```

- **Expect:** the header reads `SQLite format 3`; `sqlite3` lists the caller tables and
  a row count, with no fsqlite tooling involved.
- **PASS:** a sealed export is an ordinary SQLite file any tool can open.
  (Skip the `sqlite3` line if the binary is not present, and note it.)

### B5. `stats`/`doctor` over a plain SQLite file

```bash
node test/cli-golden/seed.ts "$QA/plain.db" plainfile
node src/cli/index.ts stats  "$QA/plain.db"
node src/cli/index.ts doctor "$QA/plain.db"; echo "exit=$?"
node test/cli-golden/seed.ts "$QA/bad.db" corrupt-sqlite
node src/cli/index.ts doctor "$QA/bad.db"; echo "exit=$?"
```

- **Expect:** `stats` labels `kind: plain-sqlite (no fsqlite layer)` and reports
  `widgets=3`; `doctor` on the clean file prints `integrity: ok` with `exit=0`; `doctor`
  on the corrupt file reports a non-`ok` integrity line with `exit=3`.
- **PASS:** the tool works on any SQLite path and the corrupt file is caught (R2).

### B6. Damage → detect → repair (R1/R2)

```bash
node test/cli-golden/seed.ts "$QA/inflight" orphan
node src/cli/index.ts validate "$QA/inflight"; echo "exit=$?"      # in-flight
node src/cli/index.ts doctor "$QA/inflight" --fix
node src/cli/index.ts validate "$QA/inflight"; echo "exit=$?"      # repaired
node test/cli-golden/seed.ts "$QA/corrupt" corrupt
node src/cli/index.ts validate "$QA/corrupt"; echo "exit=$?"       # corrupt pointer
```

- **Expect:** the in-flight store validates with `exit=2`, `doctor --fix` restores it,
  then `validate` is `sealed`/`exit=0`; the corrupt-pointer store validates `exit=3`.
- **PASS:** in-flight is recoverable and corruption is surfaced, never silently
  accepted.

### B7. Crash recovery spot-check (R1)

```bash
node --input-type=module -e '
import { SnapshotStore } from "./src/index.ts";
const dir = process.env.QA + "/crash";
const s = new SnapshotStore(dir, { schema: "CREATE TABLE kv (k TEXT PRIMARY KEY NOT NULL, v TEXT)", conflictPolicy:{kv:"lww","*":"strict"} }).init();
s.write("w", db => db.prepare("INSERT INTO kv VALUES (?,?)").run("a","1"));
try { s.reconcile({ crashAt: "after-snapshot" }); } catch (e) { console.log("injected crash:", e.message); }
const s2 = new SnapshotStore(dir, { schema:"CREATE TABLE kv (k TEXT PRIMARY KEY NOT NULL, v TEXT)", conflictPolicy:{kv:"lww","*":"strict"} });
console.log("state after crash:", s2.validate().state);
console.log("repair:", s2.repair().state, "-> applied", s2.reconcile().applied);
'
```

- **Expect:** the injected crash is reported; the reopened store validates as
  recoverable (not `corrupt`), `repair` returns it to a consistent state, and the
  pending write still reconciles.
- **PASS:** a crash between snapshot rename and pointer swap loses nothing published.

### B8. Concurrency demo

```bash
npm run demo
```

- **Expect:** the walkthrough runs concurrent writers, a reconcile, and a seal with no
  error and a consistent final count.
- **PASS:** completes cleanly; the final row count equals the number of distinct writes.

### B9. Filesystem capability check (this environment, and any target)

```bash
node src/cli/index.ts fsinspect "$QA"; echo "exit=$?"
# If you have a network/cloud-sync mount, point fsinspect at it too:
# node src/cli/index.ts fsinspect /path/to/nfs-or-sync-dir
```

- **Expect:** a capability report; `fsqlite-safe` verdict on a normal local FS
  (`exit=0`). On a WAL-hostile filesystem the WAL negative control is expected to fail
  while the fsqlite primitives still pass — that is the intended signal, not a
  regression.
- **PASS:** the report matches the filesystem you are on; record the verdict for the
  target deploy environment.

* * *

## Part C — Known gaps / not covered automatically

Decide during manual review whether each residual risk is acceptable for the intended
use.

1. **Package-local frozen install.** CI builds and smoke-tests the tarball using the
   **root** toolchain. A package-local `pnpm install --frozen-lockfile` is **blocked** by
   a 14-day supply-chain cool-off on a `rolldown` transitive of `tsdown`. Until fsqlite
   moves to its own repo, the clean-room `package-smoke.mjs` is the standalone
   guarantee. **Manual check:** run `npm run test:package` and confirm it installs and
   runs from the packed tarball.
2. **Real-NFS / cross-host gate.** Concurrency is proven cross-*process* on a local FS;
   `fsinspect` probes filesystem semantics in one process but is a heuristic, not a true
   cross-host race. A real NFS/SMB/EFS multi-host soak is **deferred**. **Manual check:**
   run B9 against the actual target filesystem and confirm `fsqlite-safe`.
3. **Power-loss durability.** Publishing `fsync`s the snapshot, the pointer, and their
   directories, so the design is power-loss-safe by construction, but there is **no
   fault-injected block-device test** simulating real power loss in CI. **Manual
   check:** reason about B7 (process-crash) as the closest reproducible proxy.
4. **Cross-language writers.** Readers are validated as binding-agnostic; non-Node
   *writers* (Python/APSW, Rust/rusqlite) against the format are **future work**
   **Manual check:** B4 confirms cross-tool *reads*; writers remain Node-only for now.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
