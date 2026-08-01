---
sandbox: true
path:
  - $TRYSCRIPT_TEST_DIR/bin
env:
  NO_COLOR: '1'
  NODE_NO_WARNINGS: '1'
timeout: 60000
---
# fsqlite CLI: schema-agnostic operator surface

The maintenance commands (`info`, `validate`, `gc`, `seal`, `repair`, `doctor`) operate
a store they did NOT create, knowing nothing of the caller’s schema or merge policy —
the self-describing-format property.
`fsqlite-seed` builds a deterministic store via the public API; everything else is the
real CLI (`src/cli/index.ts`). Runs in a sandbox temp dir, so all `store*` paths are
isolated and auto-cleaned.

* * *

## Help

# Test: bare invocation prints usage and exits non-zero

```console
$ fsqlite
usage: fsqlite <info|validate|stats|gc|seal|repair|fsinspect|doctor> <path> [args]
? 64
```

# Test: --help prints usage and exits 0

```console
$ fsqlite --help
usage: fsqlite <info|validate|stats|gc|seal|repair|fsinspect|doctor> <path> [args]
? 0
```

* * *

## Inspect a sealed store

# Test: seed a clean store, then info reports its state without knowing the schema

```console
$ fsqlite-seed store
seeded store (sealed v1)
? 0
```

```console
$ fsqlite info store
{
  "dir": "store",
  "current": 1,
  "state": "sealed",
  "snapshots": [
    0,
    1
  ],
  "pending": 0,
  "issues": []
}
? 0
```

# Test: validate exits 0 on a sealed store

```console
$ fsqlite validate store
sealed
? 0
```

# Test: doctor reports binding capabilities + store state

```console
$ fsqlite doctor store
fsqlite doctor: store
  binding: [..]
  store: sealed
? 0
```

* * *

## Validate exit codes on a damaged store

# Test: an in-flight (orphan-ahead) store exits 2

```console
$ fsqlite-seed inflight orphan
seeded inflight (in-flight: orphan v2)
? 0
```

```console
$ fsqlite validate inflight
...
? 2
```

# Test: repair restores it to sealed (exit 0)

```console
$ fsqlite repair inflight
...
? 0
```

```console
$ fsqlite validate inflight
sealed
? 0
```

# Test: a corrupt pointer exits 3

```console
$ fsqlite-seed bad corrupt
seeded bad (corrupt pointer)
? 0
```

```console
$ fsqlite validate bad
...
? 3
```

* * *

## Maintenance: gc and seal

# Test: gc on a fresh store reports a JSON result and exits 0

```console
$ fsqlite gc store --retain 1
...
? 0
```

# Test: seal writes a standalone single-file SQLite export

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

* * *

## stats and doctor over any SQLite path

`stats` and `doctor` work on both an fsqlite store directory and a plain SQLite file,
labeling which they are looking at and degrading gracefully on either.

# Test: stats on an fsqlite store reports the fsqlite layer + current-snapshot facts

```console
$ fsqlite-seed statroom
seeded statroom (sealed v1)
? 0
```

```console
$ fsqlite stats statroom
fsqlite stats: statroom
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
    application_id: 1413829460
    user_version: 1
    journal_mode: [..]
    tables: applied_tx=1 artifacts=1 fsqlite_meta=3 relationships=0 url_index=0
? 0
```

# Test: stats on a plain SQLite file labels it plain-sqlite

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
  journal_mode: [..]
  tables: widgets=3
? 0
```

# Test: doctor on a clean plain SQLite file reports ok (exit 0)

```console
$ fsqlite doctor plain.db
fsqlite doctor: plain.db
  kind: plain-sqlite (no fsqlite layer)
  integrity: ok
? 0
```

# Test: doctor on a corrupt plain SQLite file reports the failure (exit 3)

```console
$ fsqlite-seed badsql.db corrupt-sqlite
seeded badsql.db (corrupt sqlite)
? 0
```

```console
$ fsqlite doctor badsql.db
...
? 3
```

# Test: doctor --fix restores an in-flight store (exit 0)

```console
$ fsqlite-seed docinflight orphan
seeded docinflight (in-flight: orphan v2)
? 0
```

```console
$ fsqlite doctor docinflight --fix
...
? 0
```
