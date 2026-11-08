---
sandbox: true
path:
  - $TRYSCRIPT_TEST_DIR/bin
env:
  NO_COLOR: '1'
  NODE_NO_WARNINGS: '1'
timeout: 60000
---

# fsqlite CLI: Schema-Agnostic Operator Surface

The maintenance commands (`info`, `validate`, `gc`, `seal`, `repair`, `doctor`) operate
on a store they did not create and need no knowledge of the caller’s schema or merge
policy. This demonstrates the self-describing format.
`fsqlite-seed` builds a deterministic store through the public API. Every other command
uses the real CLI (`src/cli/index.ts`). The script runs in a temporary sandbox, so all
`store*` paths are isolated and removed automatically.

---

## Help

# Test: Bare Invocation Prints Usage and Exits Non-Zero

```console
$ fsqlite
usage: fsqlite <info|validate|stats|gc|seal|repair|fsinspect|doctor> <path> [args]
? 64
```

# Test: `--help` Prints Usage and Exits 0

```console
$ fsqlite --help
usage: fsqlite <info|validate|stats|gc|seal|repair|fsinspect|doctor> <path> [args]
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

# Test: Validate Exits 0 on a Sealed Store

```console
$ fsqlite validate store
sealed
? 0
```

# Test: Doctor Reports Binding Capabilities and Store State

```console
$ fsqlite doctor store
fsqlite doctor: store
  binding: [..]
  store: sealed
? 0
```

---

## Validate Exit Codes on a Damaged Store

# Test: An In-Flight (Orphan-Ahead) Store Exits 2

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

# Test: Repair Restores It to Sealed (Exit 0)

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

# Test: A Corrupt Pointer Exits 3

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

---

## Maintenance: GC and Seal

# Test: GC on a Fresh Store Reports a JSON Result and Exits 0

```console
$ fsqlite gc store --retain 1
...
? 0
```

# Test: GC Refuses a Store Whose Head Fails Integrity Validation (Exit 3)

```console
$ fsqlite-seed damaged corrupt-head
seeded damaged (corrupt head v2)
? 0
```

```console
$ fsqlite gc damaged --retain 0 2>&1
fsqlite: gc refused: store is corrupt: snapshot 2 failed integrity validation: [..]
? 3
```

```console
$ ls damaged/snapshots
000000000000.fsqlite.sqlite
000000000001.fsqlite.sqlite
000000000002.fsqlite.sqlite
? 0
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
    journal_mode: [..]
    tables: applied_tx=1 artifacts=1 fsqlite_meta=4 relationships=0 url_index=0
? 0
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
  journal_mode: [..]
  tables: widgets=3
? 0
```

# Test: Doctor on a Clean Plain SQLite File Reports OK (Exit 0)

```console
$ fsqlite doctor plain.db
fsqlite doctor: plain.db
  kind: plain-sqlite (no fsqlite layer)
  integrity: ok
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
...
? 3
```

# Test: Doctor `--fix` Restores an In-Flight Store (Exit 0)

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
