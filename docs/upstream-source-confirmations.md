# Upstream Source Confirmations

Every technical claim behind fsqlite — in this package, its [design](fsqlite-design.md),
and the [research](research/research-2026-06-06-portable-concurrent-sqlite.md) — is
first established empirically (the `fsinspect` probes / the test suite) and then
**corroborated against upstream source** at pinned commits.
Exact repo-relative file:line references are recorded here so a reviewer can clone each
repository at the listed commit and re-verify them in any scratch directory.

## Checkouts

| Repo | Commit / version | Why |
| --- | --- | --- |
| `sqlite/sqlite` | `002d33d` (2026-06-04) | Authoritative session/changeset and locking/WAL semantics |
| `nodejs/node` @ `v22.22.2` | `2645dc73` (bundles SQLite **3.51.2**) | The `node:sqlite` binding (`src/node_sqlite.cc`) |
| `WiseLibs/better-sqlite3` | `f93f490` (v12.10.0, bundles SQLite **3.53.2**) | Alternative Node binding: format and session availability |
| `moxystudio/node-proper-lockfile` | `9f8c303` (v4.1.2) | Prior art for the NFS-safe `mkdir` lease lock |

## A. SQLite Engine Semantics (`sqlite/sqlite`)

### A1. Conflict-handler return dispatch — ABORT, REPLACE-MISUSE, invalid→MISUSE

`ext/session/sqlite3session.c:4952-4978` (the authoritative C implementation, not just
the header):

```c
res = xConflict(pCtx, eType+1, pIter);
if( res==SQLITE_CHANGESET_REPLACE ) rc = SQLITE_MISUSE;   // REPLACE in a no-matching-row context
...
switch( res ){
  case SQLITE_CHANGESET_REPLACE: *pbReplace = 1; break;   // only valid where pbReplace != NULL (DATA/CONFLICT)
  case SQLITE_CHANGESET_OMIT:    break;
  case SQLITE_CHANGESET_ABORT:   rc = SQLITE_ABORT; break;
  default:                       rc = SQLITE_MISUSE; break; // ANY out-of-range return → MISUSE
}
```

Confirms: **ABORT → `SQLITE_ABORT`** (then node maps it to a `false` return — A-node1);
a **REPLACE where SQLite doesn’t allow it → `SQLITE_MISUSE`**; and an
**invalid/`undefined` return → `SQLITE_MISUSE`** (explains the empirical “returning
`undefined` throws”). Header prose: `ext/session/sqlite3session.h:1454-1481`.

### A2. Tables need an explicit PRIMARY KEY; NULL-PK rows are not recorded

`ext/session/sqlite3session.h:115-119, 192-202`:

> “Normally, tables with no explicit PRIMARY KEY are simply ignored.”
> / “Changes can only be recorded for tables that have a PRIMARY KEY explicitly...” /
> “Changes are not recorded for individual rows that have NULL values stored in one or
> more of their PRIMARY KEY columns.”

Confirms the schema rule: **every table needs a non-null explicit PK** or its rows
silently vanish from changesets.

### A3. The rebaser exists in the C API (the gap is purely the binding)

`ext/session/sqlite3session.h:1592-1622`: `sqlite3rebaser_create` / `_configure` /
`_rebase` are declared (EXPERIMENTAL). So a rebaser *exists* in SQLite — `node:sqlite`
just does not expose it (see B3).

### A4. WAL needs shared memory → not supported on a network filesystem

`src/wal.c:129-133` (SQLite’s own source comment):

> “Conceptually, the wal-index is shared memory … Because the wal-index is shared
> memory, **SQLite does not support journal_mode=WAL on a network filesystem.** All
> users of the database must be able to [share memory].”

This is the canonical, in-source confirmation that WAL is local-disk-only — the basis
for “writers/reconcile never rely on WAL on shared storage.”

### A5. POSIX advisory (`fcntl`) locks are unreliable, especially on NFS

`src/os_unix.c:1191`: *“POSIX advisory locks are broken by design.”* (with NFS-specific
retry handling at `:1036` and a BSD/macOS NFS `lockd` bug worked around at
`:2118-2172`). Confirms why the design avoids `fcntl`/`flock` and uses `mkdir`/`rename`
instead.

## B. The `node:sqlite` Binding (`nodejs/node`, v22.22.2 → SQLite 3.51.2)

### B0. node ships SQLite with SESSION enabled

`deps/sqlite/sqlite.gyp:24,27` defines `SQLITE_ENABLE_PREUPDATE_HOOK` and
`SQLITE_ENABLE_SESSION`. So `node:sqlite`’s session/changeset support is real and
compiled-in (contrast better-sqlite3, C0).

### B1. The conflict handler receives only the integer type (table name dropped)

`src/node_sqlite.cc`:

```cpp
static int xConflict(void* pCtx, int eConflict, sqlite3_changeset_iter* pIter) {
  ... return ctx->conflictCallback(eConflict);          // pIter (→ table name) is DROPPED
}
context.conflictCallback = [env, conflictFunc](int conflictType) -> int {
  Local<Value> argv[] = {Integer::New(env->isolate(), conflictType)};   // only the int reaches JS
  ...
};
```

The C `xConflict` has the iterator `pIter` (table name via `sqlite3changeset_op`), but
the binding forwards only `eConflict`. → per-table policy must use the
**`filter(tableName)`** callback instead.
(Clean upstream ask: forward the iterator/table name to `onConflict`.)

### B2. ABORT is surfaced as a `false` return value, not a throw

`src/node_sqlite.cc:1754` (the `applyChangeset` result handling):

```cpp
if (r == SQLITE_ABORT) {
  // this is not an error, return false
  args.GetReturnValue().Set(false);
  return;
}
```

Combined with A1: `applyChangeset(cs, { onConflict: () => SQLITE_CHANGESET_ABORT })`
rolls back the whole apply and returns **`false`** — the strict-conflict detection.

### B3. No rebaser exposed; backup API, URI, readOnly, busy_timeout are

`node_sqlite.cc` exposes the **online backup API** (`sqlite3_backup_init/step/finish`,
`:463-541`), enables **`SQLITE_OPEN_URI`** by default (`:709` — so `file:…?immutable=1`
/ `nolock=1` URIs work), maps `readOnly`→`SQLITE_OPEN_READONLY` (`:710-712`), sets
`sqlite3_busy_timeout` from a `timeout` option (`:739`), and gates extension loading off
by default (`allowExtension`/`enableLoadExtension`, `:934`/`:2730`). It exposes **no**
`sqlite3rebaser_*`. → v1 must not need a rebaser (it doesn’t).

Node’s public API history records the static `backup` export as added in v22.16.0 and
v23.8.0. Since fsqlite imports it by name, this is a package load-time floor rather than
an optional capability:
<https://nodejs.org/download/release/v25.4.0/docs/api/sqlite.html>.

## C. `better-sqlite3` (`WiseLibs/better-sqlite3`, v12.10.0 → SQLite 3.53.2)

### C0. Session is NOT compiled in (the decisive fact)

`deps/defines.gypi` (the actual compile flags) lists `SQLITE_ENABLE_FTS5`,
`SQLITE_ENABLE_JSON1`, `SQLITE_ENABLE_DESERIALIZE`, `SQLITE_THREADSAFE=2`,
`SQLITE_USE_URI=0`, … but **neither `SQLITE_ENABLE_SESSION` nor
`SQLITE_ENABLE_PREUPDATE_HOOK`.** The session code is present in the amalgamation behind
`#if defined(SQLITE_ENABLE_SESSION)` (`deps/sqlite3/sqlite3.c:11812`) but compiled out.
So a default better-sqlite3 **cannot record or apply changesets.**

### C1. No session/changeset JS API at all

`grep -rin "session|changeset|changegroup|rebaser" lib/ src/` → **nothing**. The surface
is
`prepare/transaction/pragma/backup/serialize/function/aggregate/table/loadExtension/ unsafeMode`
(`lib/database.js:76-87`). It has the **online backup** (`lib/methods/backup.js`) and
**serialize/deserialize** (`SQLITE_ENABLE_DESERIALIZE`).

### C2. Same on-disk format

better-sqlite3 compiles the standard SQLite amalgamation (`deps/sqlite3/sqlite3.c`,
3.53.2); its compile flags are feature toggles, none of which alter the page format.
→ a file written by better-sqlite3 is the **identical `SQLite format 3` file** readable
by `node:sqlite`, the `sqlite3` CLI, Python, Rust, etc.
(Note `SQLITE_USE_URI=0`: URI `nolock`/`immutable` are off by default here, unlike
node:sqlite.)

**Verdict (better-sqlite3):** not viable as the **changeset writer/reconcile** runtime
without a custom rebuild with `SQLITE_ENABLE_SESSION` (which re-introduces the native
prebuild burden `node:sqlite` avoids).
Fully viable as a **reader** and as the **`DirectStore`** writer (which needs no
session) — it is mature, fast, synchronous, and has the backup API. The driver
abstraction should therefore allow better-sqlite3 for reader/Direct paths and require
`node:sqlite` only for the changeset path.
Its API surface (`transaction()`, `pragma()`, `backup()`, `serialize()`) is a good
reference for the driver interface.

## D. `node-proper-lockfile` (`moxystudio/node-proper-lockfile`, v4.1.2)

### D1. It uses `mkdir` (atomic on any FS, incl. NFS) — same primitive as the fsqlite lock

`lib/lockfile.js:28-29`: *“Use mkdir to create the lockfile (atomic operation)”*;
release is `rmdir` (`:90`). No `flock`/`fcntl`/`O_EXCL`/`symlink` anywhere.
`README.md:29,39-41`:

> “utilizes the `mkdir` strategy which works **atomically on any kind of file system,
> even network based ones**.” / “`O_EXCL` is broken on NFS file systems …
> `proper-lockfile` uses `mkdir` which doesn’t have this issue.”

Direct external validation of the lock choice (and of *why* `flock`/`O_EXCL` are
avoided).

### D2. mtime-lease + heartbeat + compromise threshold (+ mtime-precision probing)

Stale detection by mtime (`isStale`, `:85`); a heartbeat that `utimes` the lockdir on an
interval and declares the lock **compromised** if it can’t refresh within the stale
window (`updateLock`, `:99-170`); and **mtime-precision probing**
(`lib/mtime-precision.js`) for filesystems with coarse mtime resolution.
Defaults: `stale ≥ 5000`, `update = stale/2` (`README.md:76-77`).

**Verdict (proper-lockfile):** confirms `mkdir` + mtime-lease + heartbeat is the
battle-tested correct pattern.
Not adopted as-is because it is **async/Promise-based** (the publish path is synchronous
via `node:sqlite`), pulls a `graceful-fs` dep (fsqlite is zero-dep), and has **no
owner-token fencing** (it uses an `onCompromised` notification, not a
revalidate-before-publish check).
**Draws from it:** (a) the **mtime-precision probing** (a real robustness gap to close),
(b) the **default constants** (`stale ≥ 5000`, `update = stale/2`), and (c) the
heartbeat/compromise loop — layered onto fsqlite’s **owner-token
revalidate-before-publish**. Note proper-lockfile alone does not make a *live* SQLite DB
NFS-safe; it only protects the lock — which is exactly why fsqlite also needs the
immutable-snapshot + idempotent-ledger model so correctness does not depend on the lock.

## Does the Design Still Hold Up?

Yes — the deeper source pass confirmed every load-bearing claim and surfaced no
contradiction:

- The changeset/conflict/PK/WAL/lock facts are exactly as the design assumes, now pinned
  to C source (A1–A5, B0–B3).
- The three binding constraints (no table name to the handler; ABORT-as-`false`; REPLACE
  only for DATA/CONFLICT) are confirmed as **binding-level**, with a clean upstream ask.
- better-sqlite3 reinforces the runtime choice (node:sqlite for the changeset path;
  either binding for readers/Direct) and confirms format identity — so adopting it for
  the reader/Direct lanes is a safe, low-cost option.
- proper-lockfile independently validates the lock design and offers two concrete
  robustness upgrades (mtime-precision; defaults) to fold into the production lock.

The one genuinely unsettled question remains **real-NFS behavior under contention**
(mkdir/rename atomicity, attribute-cache staleness, lease-break under partition, fsync
durability) — which no amount of source reading can settle and which the post-alpha
real-mount gate must cover.
