# Upstream Source Confirmations

This document records upstream evidence for design claims cited in this package, its
[design](fsqlite-design.md), and its
[research](research/research-2026-06-06-portable-concurrent-sqlite.md).
The claims are also exercised by `fsinspect` probes and the test suite.
Exact repo-relative file:line references are recorded here so a reviewer can clone each
repository at the listed commit and re-verify them in any scratch directory.

## Checkouts

| Repo | Commit or Version | Why |
| --- | --- | --- |
| `sqlite/sqlite` | `002d33d` (2026-06-04) | SQLite session, changeset, locking, and WAL semantics |
| `nodejs/node` @ `v22.22.2` | `2645dc73` (bundles SQLite **3.51.2**) | The `node:sqlite` binding (`src/node_sqlite.cc`) |
| `WiseLibs/better-sqlite3` | `f93f490` (v12.10.0, bundles SQLite **3.53.2**) | Alternative Node binding: format and session availability |
| `moxystudio/node-proper-lockfile` | `9f8c303` (v4.1.2) | Prior art for a `mkdir` lease intended for network filesystems |

The file:line references below belong to these pinned checkouts.
Current releases as of 2026-11-08: SQLite 3.54.1; Node 22.23.4 (bundling SQLite 3.53.4),
24.22.2 (3.53.4), and 26.13.0 (3.54.0), with `main` at v28-pre (3.54.1); better-sqlite3
v13.0.3 (3.53.4); proper-lockfile still v4.1.2. The v22.22.2 baseline bundled SQLite
3.51.2, which predates the WAL-reset corruption fix (3.51.3) and the 2026 FTS5 CVE fixes
(3.53.2); neither affects fsqlite’s `DELETE`-journal store files.

## A. SQLite Engine Semantics (`sqlite/sqlite`)

### A1. Conflict-Handler Return Dispatch

`ext/session/sqlite3session.c:4952-4978` (the C implementation, not just the header):

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

Confirms: **ABORT produces `SQLITE_ABORT`** (then node maps it to a `false` return; see
B2); a **REPLACE where SQLite does not allow it produces `SQLITE_MISUSE`**; and an
**invalid or `undefined` return produces `SQLITE_MISUSE`**. The latter explains the
empirical result that returning `undefined` throws.
Header prose: `ext/session/sqlite3session.h:1454-1481`.

### A2. Tables Need an Explicit Primary Key; NULL-PK Rows Are Not Recorded

`ext/session/sqlite3session.h:115-119, 192-202`:

> “Normally, tables with no explicit PRIMARY KEY are simply ignored.”
> / “Changes can only be recorded for tables that have a PRIMARY KEY explicitly...” /
> “Changes are not recorded for individual rows that have NULL values stored in one or
> more of their PRIMARY KEY columns.”

Confirms the schema rule: **every table needs a non-null explicit PK** or its rows
silently vanish from changesets.

### A3. The Rebaser Exists in the C API but Not the Node Binding

`ext/session/sqlite3session.h:1592-1622`: `sqlite3rebaser_create` / `_configure` /
`_rebase` are declared (EXPERIMENTAL). So a rebaser *exists* in SQLite: `node:sqlite`
does not expose it (see B3). The rebaser APIs remain marked EXPERIMENTAL on `master` as
of 2026-11-08.

SQLite 3.51.0 added `sqlite3changeset_apply_v3()`, whose per-change `xFilter` receives
the changeset iterator (table, operation, and values); 3.53.0 added per-change
changegroup builders (`sqlite3changegroup_change_begin()` and related calls).
Neither changes the changeset blob format.
Node’s binding still calls v1 `sqlite3changeset_apply()` on `main` (2026-11-08);
exposing `_v3`’s per-change filter is the smallest upstream change that would give
fsqlite the table name without touching `onConflict`. Sources:
[`sqlite3changeset_apply`](https://www.sqlite.org/session/sqlite3changeset_apply.html),
[3.51.0 release notes](https://sqlite.org/releaselog/3_51_0.html), and
[3.53.0 release notes](https://sqlite.org/releaselog/3_53_0.html).

### A4. WAL Requires Shared Memory and Does Not Support Network Filesystems

[`src/wal.c:129-133`](https://github.com/sqlite/sqlite/blob/002d33d8c569ce25f5001ae627a4e73dd52bf98d/src/wal.c#L129-L133)
(SQLite’s own source comment):

> “Conceptually, the wal-index is shared memory … Because the wal-index is shared
> memory, **SQLite does not support journal_mode=WAL on a network filesystem.** All
> users of the database must be able to [share memory].”

This confirms that WAL does not support network filesystems.
It supports the design rule that writers and reconciliation never rely on WAL on shared
storage.

### A5. POSIX Advisory Locks Can Be Unreliable, Especially on NFS

[`src/os_unix.c:1188-1210`](https://github.com/sqlite/sqlite/blob/002d33d8c569ce25f5001ae627a4e73dd52bf98d/src/os_unix.c#L1188-L1210)
calls POSIX advisory locks “broken by design.”
The same file documents a BSD/macOS NFS `lockd` bug and its workaround at
[`src/os_unix.c:2118-2172`](https://github.com/sqlite/sqlite/blob/002d33d8c569ce25f5001ae627a4e73dd52bf98d/src/os_unix.c#L2118-L2172).
SQLite’s default Unix VFS normally uses `fcntl()` byte-range advisory locks; `flock()`
is an alternative locking style, not the default mechanism.
This confirms why fsqlite does not depend on either style as its cross-client
coordination primitive and instead specifies `mkdir`, no-replace `link`, and `rename`
publication semantics.

The NFS-to-error path is explicit in the source:

- [`src/os_unix.c:1014-1038`](https://github.com/sqlite/sqlite/blob/002d33d8c569ce25f5001ae627a4e73dd52bf98d/src/os_unix.c#L1014-L1038)
  maps retryable POSIX lock errors to `SQLITE_BUSY`, including `ENOLCK`, which its
  comment calls a “random NFS retry error.”
- [`src/os_unix.c:1973-1986`](https://github.com/sqlite/sqlite/blob/002d33d8c569ce25f5001ae627a4e73dd52bf98d/src/os_unix.c#L1973-L1986)
  shows the Unix lock call passing its `errno` through that mapping.
- [`src/sqlite.h.in:449-456`](https://github.com/sqlite/sqlite/blob/002d33d8c569ce25f5001ae627a4e73dd52bf98d/src/sqlite.h.in#L449-L456)
  defines `SQLITE_BUSY` as result code 5, and
  [`src/main.c:1649-1657`](https://github.com/sqlite/sqlite/blob/002d33d8c569ce25f5001ae627a4e73dd52bf98d/src/main.c#L1649-L1657)
  maps it to `database is locked`.
- [`src/main.c:1710-1769`](https://github.com/sqlite/sqlite/blob/002d33d8c569ce25f5001ae627a4e73dd52bf98d/src/main.c#L1710-L1769)
  and
  [`src/main.c:1840-1857`](https://github.com/sqlite/sqlite/blob/002d33d8c569ce25f5001ae627a4e73dd52bf98d/src/main.c#L1840-L1857)
  implement the busy timeout by sleeping and retrying the same lock until the timeout,
  then returning `SQLITE_BUSY`.

A two-connection `node:sqlite` probe on Node v24.13.0 with SQLite 3.50.4 surfaced
`database is locked` with result code 5. SQLite’s
[result-code documentation](https://sqlite.org/rescode.html#busy) and
[network-filesystem guidance](https://sqlite.org/useovernet.html) support the same
interpretation. A busy timeout can wait for a working lock; it cannot supply missing
filesystem semantics.
Some broken network locks instead appear to work and risk corruption, so the explicit
error is a typical symptom rather than a complete NFS diagnostic.

## B. The `node:sqlite` Binding (`nodejs/node` v22.22.2, SQLite 3.51.2)

### B0. Node Ships SQLite with SESSION and PREUPDATE_HOOK Enabled

`deps/sqlite/sqlite.gyp:24,27` defines `SQLITE_ENABLE_PREUPDATE_HOOK` and
`SQLITE_ENABLE_SESSION`. So `node:sqlite`’s session and changeset support is compiled-in
(contrast better-sqlite3, C0). `packages/fsqlite/src/driver.ts` imports `node:sqlite`
directly, so the reference package and application calls to `node:sqlite` use the same
SQLite library embedded in the running Node binary.
Node supplies that database engine as part of the runtime.
Installing the npm package adds the TypeScript protocol implementation and CLI, with no
separate SQLite installation or native build.

### B1. The Conflict Handler Receives Only the Integer Type

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
the binding forwards only `eConflict`. Per-table policy therefore uses the
**`filter(tableName)`** callback.
(Potential upstream improvement: forward the iterator and table name to `onConflict`.)

### B2. ABORT Is a `false` Return Value, Not an Exception

`src/node_sqlite.cc:1754` (the `applyChangeset` result handling):

```cpp
if (r == SQLITE_ABORT) {
  // this is not an error, return false
  args.GetReturnValue().Set(false);
  return;
}
```

Combined with A1, `applyChangeset(cs, { onConflict: () => SQLITE_CHANGESET_ABORT })`
rolls back the whole apply and returns **`false`** to report a strict conflict.

### B3. Backup, URI, Read-Only, and Timeout APIs

`node_sqlite.cc` exposes the **online backup API** (`sqlite3_backup_init/step/finish`,
`:463-541`) and enables **`SQLITE_OPEN_URI`** by default (`:709`), allowing
`file:…?immutable=1` and `nolock=1` URIs.
It maps `readOnly` to `SQLITE_OPEN_READONLY` (`:710-712`), sets `sqlite3_busy_timeout`
from a `timeout` option (`:739`), and gates extension loading off by default
(`allowExtension` and `enableLoadExtension`, `:934` and `:2730`). It exposes no
`sqlite3rebaser_*`, so the `f1.0` format does not require a rebaser.

Node’s public API history records the static `backup` export as added in v22.16.0 and
v23.8.0. Because fsqlite imports it by name, this is a package load-time floor rather
than an optional capability:
<https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html>.

### B4. Later API Changes (Checked 2026-11-08)

These postdate the v22.22.2 baseline and are absent from the v22 line:

- **`defensive` option:** added in v24.12.0 and v25.1.0; **default `true` since v24.14.0
  and v25.5.0**. It sets `SQLITE_DBCONFIG_DEFENSIVE`, which blocks
  `PRAGMA writable_schema=ON`, `PRAGMA journal_mode=OFF`, `PRAGMA schema_version=N`,
  writes to `sqlite_dbpage`, and direct shadow-table writes.
  These are blocked by default on ≥ 24.14 but not on 22.
- **`setAuthorizer()`:** added in v24.10.0; v24.22.0 and v26.8.0 reject connection
  access from inside the callback.
- **`limits` property:** added in v24.15.0 and v25.8.0.
- **Release-candidate stability:** PR #61262 (v24.15.0 and v25.7.0) marked the module
  Stability 1.2 and removed the `ExperimentalWarning`; v22 docs still say Stability 1.1
  and v22 `lib/sqlite.js` still emits the warning.
- **Rename:** v26.11.0 renamed `DatabaseSync` to `Database` and `StatementSync` to
  `Statement`, keeping the old names as aliases under documentation-only deprecations
  DEP0210 and DEP0211 (no runtime warning).

Sources: the v24, v25, and v26 changelogs,
[Node deprecations](https://nodejs.org/api/deprecations.html), and `src/node_sqlite.cc`
on `v22.x` versus `v24.x` (`SQLITE_DBCONFIG_DEFENSIVE` and `sqlite3_set_authorizer`
appear only on 24 and later).

## C. `better-sqlite3` (`WiseLibs/better-sqlite3` v12.10.0, SQLite 3.53.2)

As of 2026-11-08 the current release is v13.0.3 (2026-08-05, bundling SQLite 3.53.4).
v13.0.0 moved to N-API and ships prebuilt binaries inside the package; `defines.gypi` is
unchanged on SESSION, PREUPDATE, `USE_URI=0`, and `THREADSAFE=2`.

### C0. Session Is Not Compiled In

`deps/defines.gypi` (the actual compile flags) lists `SQLITE_ENABLE_FTS5`,
`SQLITE_ENABLE_JSON1`, `SQLITE_ENABLE_DESERIALIZE`, `SQLITE_THREADSAFE=2`,
`SQLITE_USE_URI=0`, … but **neither `SQLITE_ENABLE_SESSION` nor
`SQLITE_ENABLE_PREUPDATE_HOOK`.** The session code is present in the amalgamation behind
`#if defined(SQLITE_ENABLE_SESSION)` (`deps/sqlite3/sqlite3.c:11812`) but compiled out.
So a default better-sqlite3 **cannot record or apply changesets.**

### C1. No Session or Changeset JavaScript API

A search of `lib/` and `src/` for `session`, `changeset`, `changegroup`, and `rebaser`
finds no results. The JavaScript surface includes `prepare`, `transaction`, `pragma`,
`backup`, `serialize`, `function`, `aggregate`, `table`, `loadExtension`, and
`unsafeMode` (`lib/database.js:76-87`). It includes online backup
(`lib/methods/backup.js`) and serialize/deserialize support
(`SQLITE_ENABLE_DESERIALIZE`).

### C2. Same On-Disk Format

better-sqlite3 compiles the standard SQLite amalgamation (`deps/sqlite3/sqlite3.c`,
3.53.2). Its compile flags are feature toggles that do not alter the page format.
A file written by better-sqlite3 is a standard **`SQLite format 3` file** readable by
`node:sqlite`, the `sqlite3` CLI, Python, Rust, and other SQLite bindings.
`SQLITE_USE_URI=0` means `nolock` and `immutable` URI options are off by default there,
unlike in `node:sqlite`.

Without `SQLITE_ENABLE_SESSION`, better-sqlite3 cannot write or reconcile fsqlite
changesets. The capabilities examined here are sufficient to read fsqlite snapshot files
and to support `DirectStore` operations, which do not use sessions.
Its current API surface includes `transaction()`, `pragma()`, `backup()`, and
`serialize()`.

## D. `node-proper-lockfile` (`moxystudio/node-proper-lockfile`, v4.1.2)

### D1. The Lock Uses `mkdir`, Including on NFS

`lib/lockfile.js:28-29`: *“Use mkdir to create the lockfile (atomic operation)”*;
release is `rmdir` (`:90`). No `flock`/`fcntl`/`O_EXCL`/`symlink` anywhere.
`README.md:29,39-41`:

> “utilizes the `mkdir` strategy which works **atomically on any kind of file system,
> even network based ones**.” / “`O_EXCL` is broken on NFS file systems …
> `proper-lockfile` uses `mkdir` which doesn’t have this issue.”

This source supports using `mkdir` rather than `flock` or `O_EXCL` for fsqlite’s store
lease. The mount-specific validation limits in the design still apply.
The README’s absolute claim is dated: Linux
[`open(2)`](https://man7.org/linux/man-pages/man2/open.2.html) says `O_EXCL` on NFS “is
supported only when using NFSv3 or later on kernel 2.6 or later,” and that programs
relying on it race only where that support is absent.
`mkdir` remains the more portable primitive.

### D2. mtime Lease, Heartbeat, and Compromise Threshold

Stale detection by mtime (`isStale`, `:85`); a heartbeat that `utimes` the lockdir on an
interval and declares the lock **compromised** if it can’t refresh within the stale
window (`updateLock`, `:99-170`); and **mtime-precision probing**
(`lib/mtime-precision.js`) for filesystems with coarse mtime resolution.
Defaults: `stale ≥ 5000`, `update = stale/2` (`README.md:76-77`).

proper-lockfile uses a `mkdir` lock with an mtime lease and heartbeat.
fsqlite does not adopt it because it is **async/Promise-based** while the publish path
is synchronous via `node:sqlite`, it adds a `graceful-fs` dependency, and it has no
owner-token fencing.
It uses an `onCompromised` notification instead of a revalidate-before-publish check.
Its mtime-precision probe, default constants (`stale ≥ 5000`, `update = stale/2`), and
heartbeat behavior provide relevant comparison points.
proper-lockfile protects only the lock.
fsqlite also uses immutable snapshots and an idempotent ledger, so correctness does not
depend on the lock alone.

## Source Support for the Design

The reviewed sources support these design assumptions:

- The changeset, conflict, primary-key, WAL, and lock behavior cited by the design is
  recorded in C source (A1-A5, B0-B3).
- The three binding constraints (no table name to the handler; ABORT-as-`false`; REPLACE
  only for DATA/CONFLICT) are binding-level limitations.
  An upstream improvement could forward the iterator and table name to `onConflict`.
- better-sqlite3 confirms the format identity and the runtime distinction: `node:sqlite`
  is needed for changesets, while either binding can serve reader and DirectStore paths.
- proper-lockfile illustrates the lock design and identifies two possible robustness
  upgrades: mtime precision probing and its default constants.

The remaining unsettled question is **real-NFS behavior under contention**: mkdir/rename
atomicity, attribute-cache staleness, lease break under partition, and `fsync`
durability. Source reading cannot settle this question; the post-alpha real-mount gate
must cover it.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
