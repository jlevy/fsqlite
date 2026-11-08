---
sandbox: true
path:
  - $TRYSCRIPT_TEST_DIR/bin
env:
  NO_COLOR: '1'
patterns:
  VERSION: '\d+\.\d+\.\d+[-.0-9A-Za-z]*'
timeout: 60000
---

# fsqlite CLI: Schema-Agnostic Operator Surface

The maintenance commands (`info`, `validate`, `gc`, `seal`, `repair`, `doctor`) operate
on a store they did not create and need no knowledge of the caller’s schema or merge
policy. This demonstrates the self-describing format.
`fsqlite-seed` builds a deterministic store through the public API, optionally with a
planted fault. Every other command uses the real CLI (`src/cli/bin.ts`) with Node’s
default warnings. The script runs in a temporary sandbox, so all `store*` paths are
isolated and removed automatically.

Blocks that assert stderr list it in `!` lines; a block without them compares stdout and
stderr together, so it also proves the command printed no diagnostics.
Only values that differ between machines or SQLite versions are elided.

---

## Help and Usage Errors

# Test: Bare Invocation Prints Usage on Stderr and Exits 64

```console
$ fsqlite
! usage: fsqlite <command> [options]
! ...
? 64
```

# Test: `--help` Documents Every Command, Option, and Exit Code

```console
$ fsqlite --help
usage: fsqlite <command> [options]

Operate an fsqlite store from the shell, without application schema code.

Commands:
  info       <dir>               Show a store's state, head, snapshots, and pending tail
  validate   <dir>               Classify a store's health; the exit code is the state's
  stats      <path>              Facts about an fsqlite store or a plain SQLite file
  gc         <dir> [--retain N]  Delete superseded snapshots
  seal       <dir> <out.sqlite>  Export the head as a standalone SQLite file
  repair     <dir> [--dry-run]   Restore the last consistent point
  doctor     <path> [--fix]      Binding capabilities and store or SQLite file health
  fsinspect  <dir>               Probe whether a filesystem can host a store

Options:
  --json         Print JSON instead of text (every command)
  -h, --help     Show help; also `fsqlite <command> --help` or `fsqlite help <command>`
  -V, --version  Show the version

Exit codes:
  0   success; a reported store is sealed or live
  1   the operation failed
  2   in flight: a capture, publication, or maintenance step is mid-flight
  3   the store is invalid or corrupt
  4   the store needs a newer format version or feature
  5   fsinspect: the filesystem cannot host a store
  64  usage error, or the path is not an fsqlite store
? 0
```

# Test: Each Command Has Its Own Help

```console
$ fsqlite help gc
usage: fsqlite gc <dir> [--retain N] [--json]

Delete superseded snapshots

Options:
  --retain N    Predecessors of current to keep (default 3)
  --json        Print JSON instead of text
  -h, --help    Show this help

gc refuses a store whose head fails validation, exiting with that state's code.

Exit codes:
...
? 0
```

```console
$ fsqlite repair --help
usage: fsqlite repair <dir> [--dry-run] [--json]

Restore the last consistent point

Options:
  --dry-run     Print the steps repair would take, and change nothing
  --json        Print JSON instead of text
  -h, --help    Show this help

repair deletes every transient file, so run it only when no writer or reconciler is
active; it refuses while a live publisher holds publish.lock. Exits with the code of
the resulting state (the current state with --dry-run).

Exit codes:
...
? 0
```

`fsinspect --help` prints help; it is not taken as a directory to create and probe.

```console
$ fsqlite fsinspect --help
usage: fsqlite fsinspect <dir> [--json]
...
? 0
```

```console
$ test ! -e ./--help && echo 'no ./--help directory'
no ./--help directory
? 0
```

# Test: `--version` Prints the Package Version

```console
$ fsqlite --version
[VERSION]
? 0
```

# Test: An Unknown Command Is a Usage Error, Before Any Path Is Read

```console
$ fsqlite frobnicate /tmp
! fsqlite: unknown command 'frobnicate'
! Run `fsqlite --help` for usage.
? 64
```

```console
$ fsqlite help frobnicate
! fsqlite: unknown command 'frobnicate'
! Run `fsqlite --help` for usage.
? 64
```

# Test: Options Follow the Command

```console
$ fsqlite --json stats store
! fsqlite: unknown option '--json' before the command; options follow it, as in 'fsqlite <command> --json <path>'
! Run `fsqlite --help` for usage.
? 64
```

# Test: Missing and Extra Arguments Are Usage Errors

```console
$ fsqlite info
! fsqlite: 'info' needs <dir>
! Run `fsqlite info --help` for usage.
? 64
```

```console
$ fsqlite validate store extra
! fsqlite: 'validate' takes 1 argument(s); unexpected 'extra'
! Run `fsqlite validate --help` for usage.
? 64
```

A flag is never taken as a path: `seal` does not write a file named `--json`.

```console
$ fsqlite seal store --json
! fsqlite: 'seal' needs <out.sqlite>
! Run `fsqlite seal --help` for usage.
? 64
```

```console
$ test ! -e ./--json && echo 'no ./--json file'
no ./--json file
? 0
```

---

## Inspect a Sealed Store

# Test: Seed a Clean Store, Then Inspect Its State Without Schema Knowledge

```console
$ fsqlite-seed store
seeded store (sealed v1)
? 0
```

```console
$ fsqlite info store
fsqlite info: store
  state: sealed
  current: 1
  snapshots: 0 1
  pending: 0
? 0
```

```console
$ fsqlite info store --json
{
  "path": "store",
  "state": "sealed",
  "current": 1,
  "snapshots": [
    0,
    1
  ],
  "pending": 0,
  "issues": []
}
? 0
```

# Test: Validate Exits 0 on a Sealed Store

```console
$ fsqlite validate store
sealed
? 0
```

```console
$ fsqlite validate store --json
{
  "path": "store",
  "state": "sealed",
  "current": 1,
  "pending": 0,
  "issues": []
}
? 0
```

# Test: Doctor Reports Binding Capabilities and Store State

```console
$ fsqlite doctor store
fsqlite doctor: store
  binding: session=true backup=true rebaser=false
  store: sealed
? 0
```

```console
$ fsqlite doctor store --json
{
  "path": "store",
  "kind": "fsqlite-store",
  "capabilities": {
    "session": true,
    "applyChangeset": true,
    "backup": true,
    "rebaser": false
  },
  "store": {
    "state": "sealed",
    "current": 1,
    "pending": 0,
    "issues": []
  }
}
? 0
```

# Test: A Store With a Pending Envelope Is Live (Exit 0)

```console
$ fsqlite-seed livestore pending
seeded livestore (live: 1 pending envelope)
? 0
```

```console
$ fsqlite validate livestore
live
? 0
```

```console
$ fsqlite info livestore
fsqlite info: livestore
  state: live
  current: 1
  snapshots: 0 1
  pending: 1
? 0
```

---

## Recognition and Health Exit Codes

# Test: A Directory Without a Marker Is Not a Store (Exit 64)

```console
$ mkdir empty && fsqlite validate empty
! fsqlite: 'empty' is not an fsqlite store (missing fsqlite.json)
? 64
```

# Test: A Newer Format Version Is Unsupported (Exit 4), Not Corrupt

```console
$ fsqlite-seed newer unsupported
seeded newer (unsupported f2.0 marker)
? 0
```

```console
$ fsqlite validate newer
unsupported: unsupported fsqlite format version "f2.0"
? 4
```

```console
$ fsqlite info newer
fsqlite info: newer
  state: unsupported
  current: (unreadable)
  snapshots: 0 1
  pending: 0
  issue: unsupported fsqlite format version "f2.0"
? 4
```

```console
$ fsqlite gc newer
! fsqlite: gc refused: store is unsupported: unsupported fsqlite format version "f2.0"; run validate and repair before collecting snapshots
? 4
```

# Test: A Malformed Marker Is Invalid (Exit 3)

```console
$ fsqlite-seed malformed invalid-marker
seeded malformed (invalid marker)
? 0
```

```console
$ fsqlite validate malformed
invalid: invalid fsqlite.json: expected a JSON object
? 3
```

```console
$ fsqlite repair malformed
! fsqlite: invalid fsqlite.json: expected a JSON object
? 3
```

# Test: An In-Flight (Orphan-Ahead) Store Exits 2

```console
$ fsqlite-seed inflight orphan
seeded inflight (in-flight: orphan v2)
? 0
```

```console
$ fsqlite validate inflight
in-flight-capture: orphan snapshot(s) ahead of pointer: 2
? 2
```

# Test: `repair --dry-run` Prints the Plan and Changes Nothing

```console
$ fsqlite repair inflight --dry-run
repair plan for inflight (now in-flight-capture):
  remove orphan snapshot 2
? 2
```

```console
$ ls inflight/snapshots
000000000000.fsqlite.sqlite
000000000001.fsqlite.sqlite
000000000002.fsqlite.sqlite
? 0
```

# Test: Repair Restores It to Sealed (Exit 0)

```console
$ fsqlite repair inflight
repaired inflight: sealed
  removed orphan snapshot 2
? 0
```

```console
$ fsqlite validate inflight
sealed
? 0
```

# Test: A Corrupt Pointer Exits 3, and Info Still Describes the Store

```console
$ fsqlite-seed bad corrupt
seeded bad (corrupt pointer)
? 0
```

```console
$ fsqlite validate bad
corrupt: torn current pointer
? 3
```

```console
$ fsqlite info bad
fsqlite info: bad
  state: corrupt
  current: (unreadable)
  snapshots: 0 1
  pending: 0
  issue: torn current pointer
? 3
```

```console
$ fsqlite seal bad bad.sqlite
! fsqlite: corrupt current pointer: "xxx"
? 3
```

```console
$ fsqlite seal bad bad.sqlite --json
! {"error":{"code":"corrupt","message":"corrupt current pointer: \"xxx\"","causes":[]}}
? 3
```

---

## Maintenance: GC and Seal

# Test: A Non-Numeric or Negative `--retain` Is a Usage Error That Deletes Nothing

An unset shell variable (`--retain "$KEEP"`) must not mean “retain 0”.

```console
$ fsqlite gc store --retain ''
! fsqlite: --retain must be a non-negative integer; received ""
! Run `fsqlite gc --help` for usage.
? 64
```

```console
$ fsqlite gc store --retain abc
! fsqlite: --retain must be a non-negative integer; received "abc"
! Run `fsqlite gc --help` for usage.
? 64
```

```console
$ fsqlite gc store --retain=-1
! fsqlite: --retain must be a non-negative integer; received "-1"
! Run `fsqlite gc --help` for usage.
? 64
```

A value that starts with a dash is never taken for the next flag, or the reverse.

```console
$ fsqlite gc store --retain -1
! fsqlite: option '--retain' needs a value; write --retain=<value> for one that starts with '-'
! Run `fsqlite gc --help` for usage.
? 64
```

```console
$ fsqlite gc store --retian 4
! fsqlite: unknown option '--retian'
! Run `fsqlite gc --help` for usage.
? 64
```

```console
$ ls store/snapshots
000000000000.fsqlite.sqlite
000000000001.fsqlite.sqlite
? 0
```

# Test: GC Keeps Current and Its Retained Predecessors

```console
$ fsqlite gc store --retain 1
removed 0 snapshot(s); kept 2; leased: none
? 0
```

```console
$ fsqlite gc store --retain 0 --json
{
  "path": "store",
  "retain": 0,
  "removed": 1,
  "kept": 1,
  "leased": []
}
? 0
```

# Test: GC Refuses a Store Whose Head Fails Integrity Validation (Exit 3)

```console
$ fsqlite-seed damaged corrupt-head
seeded damaged (corrupt head v2)
? 0
```

```console
$ fsqlite gc damaged --retain 0
! fsqlite: gc refused: store is corrupt: snapshot 2 failed integrity validation: [..]
? 3
```

```console
$ ls damaged/snapshots
000000000000.fsqlite.sqlite
000000000001.fsqlite.sqlite
000000000002.fsqlite.sqlite
? 0
```

# Test: GC Fails Closed on a Torn Fresh Lease and Reports the Cause

```console
$ fsqlite-seed leased torn-lease
seeded leased (torn fresh lease)
? 0
```

```console
$ fsqlite gc leased --retain 0
! fsqlite: gc refused: fresh lease torn.lease is unreadable (in leased/leases)
!   caused by: [..]
? 1
```

# Test: Seal Writes a Standalone Single-File SQLite Export

```console
$ fsqlite seal store export.sqlite
sealed → export.sqlite
? 0
```

```console
$ test -f export.sqlite && head -c 15 export.sqlite && echo
SQLite format 3
? 0
```

# Test: Seal Refuses a Pending Tail

```console
$ fsqlite seal livestore live.sqlite
! fsqlite: cannot seal: 1 pending transaction(s) must be reconciled first
? 1
```

---

## Stats and Doctor Over Any SQLite Path

`stats` and `doctor` work on both an fsqlite store directory and a plain SQLite file,
labeling which they are looking at and degrading gracefully on either.

# Test: Stats on an fsqlite Store Reports the fsqlite Layer and Current-Snapshot Facts

```console
$ fsqlite-seed metrics-store
seeded metrics-store (sealed v1)
? 0
```

```console
$ fsqlite stats metrics-store
fsqlite stats: metrics-store
  kind: fsqlite-store
  current: 1
  snapshots: 2
  pending: 0  applied: 1  quarantine: 0
  leases: 0
  state: sealed
  current snapshot (SQLite):
    sqlite_version: [..]
    page_size: 4096
    page_count: [..]
    file_bytes: [..]
    application_id: 1179865420
    user_version: 1
    journal_mode: delete
    tables: applied_tx=1 artifacts=1 fsqlite_meta=4 relationships=0 url_index=0
? 0
```

```console
$ fsqlite stats metrics-store --json
{
  "path": "metrics-store",
  "kind": "fsqlite-store",
  "fsqlite": {
    "current": 1,
    "snapshots": 2,
    "pending": 0,
    "applied": 1,
    "quarantine": 0,
    "leases": 0,
    "state": "sealed"
  },
  "snapshot": {
    "sqliteVersion": [..],
    "pageSize": 4096,
    "pageCount": [..],
    "fileBytes": [..],
    "applicationId": 1179865420,
    "userVersion": 1,
    "journalMode": "delete",
    "tables": [
...
    ]
  }
}
? 0
```

# Test: Stats on a Corrupt Store Reports It and Exits 3

```console
$ fsqlite stats bad
fsqlite stats: bad
  kind: fsqlite-store
  current: (unreadable)
  snapshots: 2
  pending: 0  applied: 1  quarantine: 0
  leases: 0
  state: corrupt
? 3
```

# Test: Stats on a Plain SQLite File Labels It Plain SQLite

```console
$ fsqlite-seed plain.db plainfile
seeded plain.db (plain sqlite)
? 0
```

```console
$ fsqlite stats plain.db
fsqlite stats: plain.db
  kind: plain-sqlite (no fsqlite layer)
  sqlite_version: [..]
  page_size: 4096
  page_count: [..]
  file_bytes: [..]
  application_id: 305419896
  user_version: 7
  journal_mode: delete
  tables: widgets=3
? 0
```

# Test: A Path That Is Neither a Store Nor a SQLite File Exits 64

```console
$ echo 'not sqlite' > notes.txt && fsqlite stats notes.txt
! fsqlite: 'notes.txt' is neither an fsqlite store nor a SQLite file
? 64
```

# Test: Doctor on a Clean Plain SQLite File Reports OK (Exit 0)

```console
$ fsqlite doctor plain.db
fsqlite doctor: plain.db
  kind: plain-sqlite (no fsqlite layer)
  integrity: ok
? 0
```

```console
$ fsqlite doctor plain.db --json
{
  "path": "plain.db",
  "kind": "plain-sqlite",
  "integrity": {
    "ok": true,
    "problems": []
  }
}
? 0
```

# Test: Doctor on a Corrupt Plain SQLite File Reports the Failure (Exit 3)

```console
$ fsqlite-seed badsql.db corrupt-sqlite
seeded badsql.db (corrupt sqlite)
? 0
```

```console
$ fsqlite doctor badsql.db
fsqlite doctor: badsql.db
  kind: plain-sqlite (no fsqlite layer)
  integrity: [..]
? 3
```

# Test: Doctor `--fix` Restores an In-Flight Store and Reports What It Found (Exit 0)

```console
$ fsqlite-seed docinflight orphan
seeded docinflight (in-flight: orphan v2)
? 0
```

```console
$ fsqlite doctor docinflight --fix
fsqlite doctor: docinflight
  binding: session=true backup=true rebaser=false
  before: in-flight-capture: orphan snapshot(s) ahead of pointer: 2
  repaired: removed orphan snapshot 2
  store: sealed
? 0
```

---

## Filesystem Inspection

`fsinspect` probes a directory’s filesystem, which differs between machines, so these
tests assert the report’s shape and that the exit code matches the verdict.

# Test: Fsinspect Refuses a Path That Is Not an Existing Directory (Exit 64)

```console
$ fsqlite fsinspect no/such/dir
! fsqlite: 'no/such/dir' is not an existing directory
! Run `fsqlite fsinspect --help` for usage.
? 64
```

```console
$ test ! -e no && echo 'nothing was created'
nothing was created
? 0
```

# Test: Fsinspect Prints a Report Whose Exit Code Matches Its Verdict

```console
$ fsqlite fsinspect . > report.txt; head -2 report.txt; grep -c -E '^  (✓|✗) ' report.txt
fsinspect: .
  filesystem: [..]
10
? 0
```

```console
$ fsqlite fsinspect . --json > report.json; node -e "
> const r = require('./report.json');
> console.log(Object.keys(r).join(' '));
> console.log(Object.keys(r.probes).join(' '));
> console.log(Object.keys(r.verdict).join(' '));
> console.log('exit matches verdict:', (r.verdict.fsqliteSafe ? 0 : 5) === Number(process.argv[1]));
> " $?
dir fs probes verdict
mkdirAtomic renameReplace exclusiveCreate closeToOpen mtimeResolution symlink hardlink fsyncDir walViable durableFsync
fsqliteSafe missing walSafe recommendation warnings
exit matches verdict: true
? 0
```
