# fsqlite On-Disk Format and Coordination Protocol: Specification

**format_version: f1.0** · Status: Draft (normative for the f1.0 format; tracks the Node
reference implementation at `packages/fsqlite/`)

This document defines the fsqlite **store format** and **coordination protocol**. The
protocol is language-independent; the Node library and CLI are its first implementation.
A conforming implementation in any language can read, write, reconcile, or operate a
store interoperably with every other conforming implementation.

Any SQLite binding can open a published snapshot read-only.
Participating as a SnapshotStore Writer or Reconciler additionally requires SQLite
session and changeset support.
A DirectStore Writer instead follows the serialized strategy in section 9.

The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are to be interpreted as
in RFC 2119. Requirements are stated against four conformance roles defined in §13:
**Reader**, **Writer**, **Reconciler**, and **Operator tool**.

Where this document and the Node implementation disagree, that is a bug in one of them;
file it.
Implementation *defaults* (timeouts, retry counts) are noted as such and are not
normative; protocol *invariants* are.

* * *

## 1. Design Invariants

In plain terms, a **snapshot** is one complete published SQLite database, an
**envelope** is one captured proposal to change rows, and **reconciliation** folds
committed envelopes into the next snapshot.
The `current` file names the snapshot that readers should open.

Everything in this format serves two correctness invariants:

- **R1 (bounded loss).** A crash, stale-lock overlap, torn capture, or interrupted
  protocol operation loses at most the *unpublished tail* and never a previously
  published snapshot. The **commit point of the store is snapshot publication** (§6); see
  §10 for what is durable before that point.
  Safe backup means copying a pinned immutable snapshot or using a conforming
  backup/seal operation.
  This invariant does not cover an arbitrary recursive copy of a live directory.
- **R2 (no silent corruption).** Validation surfaces every detectable inconsistency
  (§11) rather than accepting or repairing it silently.

Three structural properties deliver them:

1. **Published snapshots are immutable.** Once a snapshot file is named by the `current`
   pointer (now or in the past), no process may modify it.
   All mutation happens in uniquely-named transient files, made visible only by atomic
   rename.
2. **The pointer swap is the only commit.** A snapshot exists but is not *the store*
   until `current` names it, and `current` is replaced atomically.
3. **Safety does not depend on exclusive lease ownership.** The publish lock (§7) only
   reduces wasted work.
   Exactly-once application is guaranteed by recording each applied transaction ID
   inside its snapshot and by publishing only from the still-current base (§6). Lock
   holders can overlap after a stale-lock break; L5 states exactly what overlap can and
   cannot do to a conforming store.

Each published snapshot remains an ordinary SQLite file: any SQLite binding in any
language can open it with no fsqlite code at all.
The store root is a directory and is not itself a SQLite database.

## 2. Store Layout

A store is a dedicated directory tree rooted at the caller-provided **store root**. All
paths below are relative to it.

```
<store-root>/
  fsqlite.json                    # immutable format and store identity marker
  current                          # the pointer: ASCII decimal version (§4)
  current.<hex>.tmp                # transient: pointer publication (§4)
  fsqlite.json.<uuid>.tmp          # transient: marker creation (§3)
  publish.lock/                    # mkdir lease, present only while held (§7)
    owner.json                     #   {token, pid, host, at}
  publish.lock.<hex10>.tmp/        # transient: lock moved aside by a break or release (§7)
  snapshots/
    000000000000.fsqlite.sqlite    # immutable published snapshot, version 0 (§3)
    000000000001.fsqlite.sqlite
    .build-<hex10>.sqlite          # transient: reconcile build (§6)
    .direct-<hex10>.sqlite         # transient: DirectStore build (§9)
    .gc-<version>-<hex10>.tmp      # transient: snapshot tombstoned by GC (§8 G2)
    *.tmp                          # transient: init's snapshot-0 build (§3)
  tx/
    pending/
      <txid>.txn/                  # transaction envelope (§5)
        manifest.json
        changeset.bin
        COMMITTED                  #   zero-byte marker, written last
      .work-<writerId>-<hex10>.sqlite  # transient: writer working copy (§5)
    applied/<txid>.txn/            # envelopes folded into a published snapshot
    quarantine/<txid>.txn/         # rejected envelopes (+ QUARANTINE reason file)
  leases/
    <token>.lease                  # read lease: {version, pid, host, at} (§8)
```

`fsqlite.json` makes the directory self-identifying.
Normal store operations never modify it; only an explicit format upgrade may replace it:

```json
{
  "format": "fsqlite",
  "format_version": "f1.0",
  "required_features": [],
  "store_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

- **M1.** `format` MUST be `"fsqlite"`; `format_version` MUST be a supported version
  string matching `^f(0|[1-9]\d*)\.(0|[1-9]\d*)$`; `required_features` MUST be an array
  of unique strings understood by the reader; and `store_id` MUST be a UUID.
- **M2.** Marker absence means **not an fsqlite store**. A marker that is malformed or
  names another format is **invalid**. A valid marker with an unsupported
  `format_version` or unknown required feature is **unsupported**, not corrupt.
  Implementations MUST NOT infer store identity from the presence of `current`,
  `snapshots/`, or other generic path names.
- **M3.** Initialization MUST create the marker atomically and durably.
  It MUST refuse to initialize an unmarked non-empty directory.
- **M4.** The marker’s `store_id` and `format_version` MUST match the corresponding
  values in every accepted snapshot and transaction envelope.
  A mismatch MUST fail validation and MUST block destructive operations.
- **M5.** Consumers MUST ignore unknown marker fields but MUST reject unknown values in
  `required_features`. Package versions, timestamps, application schema, and mutable
  operational state do not belong in the marker.

Naming grammar:

- **Snapshot**: `<version>.fsqlite.sqlite` where `<version>` is the decimal version
  zero-padded to 12 digits.
  Files matching `^(\d+)\.fsqlite\.sqlite$` and nothing else are snapshots.
- **Transients** are exactly the entries matching: prefix `.build-`, prefix `.direct-`,
  prefix `.work-` (under `tx/pending/`), or suffix `.tmp`. All are files except
  `publish.lock.<hex10>.tmp/`, a directory, so removing a transient MUST handle both.
  Transients are never part of store state; a *fresh* transient indicates work in
  flight, an *old* one indicates a crash (§11).
- **Envelope dir**: `<txid>.txn` (§5 defines `<txid>`).
- **Hex tokens** (`<hex10>` etc.)
  are lowercase hex from a cryptographically random source; their only requirement is
  uniqueness.

## 3. Snapshot Files

A snapshot is a complete, self-contained SQLite database file.
Requirements:

- **S1.** It MUST be a well-formed SQLite database passing `PRAGMA integrity_check` and
  returning no rows from `PRAGMA foreign_key_check`.

- **S2.** It MUST carry `PRAGMA application_id = 0x4653514C` (ASCII `FSQL`) and
  `PRAGMA user_version` = the caller’s `schema_version`. The application id belongs to
  the fsqlite format and MUST NOT be caller-configurable; it lets foreign tools identify
  an fsqlite snapshot.
  The user version remains caller-owned schema metadata.
  `schema_version` MUST be an integer from 0 through 2,147,483,647. An implementation
  MUST reject another value before creating a marker, directory, transient, or snapshot;
  it MUST NOT rely on SQLite to coerce the value.

- **S3.** It MUST contain the two reserved tables, copied forward into every successor
  snapshot:

  ```sql
  CREATE TABLE applied_tx (         -- the idempotency ledger (§6)
    tx_id      TEXT PRIMARY KEY NOT NULL,
    applied_at TEXT NOT NULL        -- ISO-8601, informational
  );
  CREATE TABLE fsqlite_meta (       -- the store identity stamp
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  );
  ```

  Defined `fsqlite_meta` keys: `schema_hash` (first 16 lowercase-hex characters of the
  SHA-256 of the exact UTF-8 bytes of the caller-supplied schema DDL string),
  `tool_version` (informational), `format_version` (this document’s version, currently
  `'f1.0'`), and `store_id` (matching `fsqlite.json`). Implementations MUST ignore
  unknown keys. `schema_hash` is a conservative identity token.
  Implementations MUST NOT canonicalize SQL before hashing it or treat the token as an
  independent proof of the effective `sqlite_schema` contents.
  The table and all defined keys are required.

  The reserved tables MUST have exactly the columns, declared types, non-null rules, and
  primary keys shown above.
  Application callbacks MUST NOT mutate their schema or rows.

- **S4.** Every *caller* table (any table not named `sqlite_*`, `applied_tx`, or
  `fsqlite_meta`) MUST have a primary key, and unless it is a single-column
  `INTEGER PRIMARY KEY` (a non-null rowid alias), every PK column MUST be declared
  `NOT NULL`. Writers/initializers MUST reject schemas violating this requirement
  because the merge policy (§6) is keyed on primary keys, and SQLite otherwise permits
  NULLs in non-integer PKs.
  The `f1.0` Writer role does not support virtual tables: SQLite sessions do not capture
  them, and their implementation-owned shadow tables do not satisfy this caller-table
  contract. Derived indexes that use virtual tables belong outside the envelope writer
  path and must be rebuildable from published data.

- **S5.** A published snapshot MUST NOT have live `-wal`/`-shm` side files.
  (Snapshots are built and committed in rollback-journal mode and are closed before
  publication; side files present next to snapshots are an in-flight/corruption tell,
  §11.)

- **S6.** A published snapshot file MUST never be modified.
  Repair (§11) may *delete* snapshots, never edit them.

Snapshot 0 is the empty initial snapshot created by `init` (empty caller tables, both
reserved tables, identity stamped).
First-open MUST be fenced: build under the publish lock through a uniquely-named
transient, commit it as snapshot 0 without replacing (as in F5c), and then publish the
pointer so concurrent initializers converge on one snapshot 0. When `fsqlite.json`
exists but `current` does not, initialization MUST refuse if `snapshots/` holds any
snapshot (including snapshot 0) and MUST direct the operator to repair (§11): the store
has a lineage whose pointer was lost, and building a new snapshot 0 would roll every
reader back to an empty store, after which repair would delete the newer snapshots as
orphans. Only a marked store with no snapshot (a first-open that crashed before its
commit) may be initialized again.
After init (and on every reopen), an implementation MUST verify compatibility: the
snapshot identity matches `fsqlite.json`, `user_version` equals its `schema_version`,
`application_id` equals `0x4653514C`, and `fsqlite_meta.schema_hash` equals the hash of
its exact supplied DDL string.
The last check rejects a *divergent schema at the same version*, which the integer alone
cannot catch.

An application using the caller schema MUST complete `init` before ordinary reads and
writes. Writer and reconciler implementations MUST also repeat the configured-schema
compatibility check before capturing, moving, quarantining, or publishing work, so a
handle that skipped `init` cannot mutate the store under the wrong schema identity.
Schema-agnostic readers and operator tools MAY inspect supported on-disk identity
without the caller DDL.

## 4. The `current` Pointer

`current` contains the published version as an ASCII decimal string (no padding
required; the Node implementation writes the bare number with no trailing newline).

- **P1.** Readers MUST parse strictly: after trimming ASCII whitespace, the content MUST
  match `^\d+$`. Anything else, including empty content, is **corruption** and MUST be
  surfaced per R2 rather than silently treated as version 0.
- **P2.** The pointer MUST be replaced atomically and durably: write the new content to
  a uniquely-named temp file in the same directory → fsync the temp file → `rename()` it
  over `current` → fsync the directory.
- **P3.** The snapshot a new pointer names MUST already be durable (fsynced and renamed
  into `snapshots/`, directory fsynced) *before* the pointer swap.
  The pointer must never name a snapshot that could disappear after power loss.

## 5. Transaction Envelopes (the Writer Protocol)

A write is captured as a **changeset envelope**: a directory under `tx/pending/` whose
payload is a SQLite **session-extension changeset** blob (the standard format produced
by `sqlite3session_changeset()` and consumed by `sqlite3changeset_apply()`).

**Envelope id** (`<txid>`): `<epoch-ms>-<seq>-<writerId>-<hex10>` where `<epoch-ms>` is
the creation time in decimal milliseconds zero-padded to at least 12 digits, `<seq>` is
a per-handle counter zero-padded to 12 digits, and `<writerId>` MUST match
`^[A-Za-z0-9._-]{1,64}$` (it is interpolated into paths; the regex makes it a safe
single path component).
Envelope ids MUST be unique; **lexicographic byte order of envelope ids defines the
deterministic apply order** (§6), which the timestamp prefix makes approximately
chronological.

**manifest.json** fields (consumers MUST ignore unknown fields):

| Field | Meaning |
| --- | --- |
| `tx_id` | The envelope id (equals the dir name minus `.txn`) |
| `format_version` | Store format version from `fsqlite.json`; reconcile quarantines a mismatch |
| `store_id` | Store identity from `fsqlite.json`; reconcile quarantines a mismatch |
| `writer_id` | The raw writer id (provenance) |
| `base_version` | The published version the working copy was seeded from (informational; the format is not base-pinned; see §6) |
| `schema_version` | Writer’s schema generation; reconcile quarantines a mismatch |
| `schema_hash` | Writer’s DDL hash; reconcile quarantines a mismatch |
| `created_at` | ISO-8601 timestamp (informational) |
| `changeset` | Payload filename, `changeset.bin` |
| `changeset_sha256` | Full 64-hex SHA-256 of the payload; reconcile quarantines a digest mismatch |
| `tool_version` | Producing implementation (provenance) |

**Writer protocol** (no step takes the publish lease):

1. **W1.** Validate the writer id against the regex above and verify the configured
   caller-schema identity against the published snapshot.
2. **W2.** Read `current` → base; copy the immutable base snapshot to a private
   `.work-*` transient under `tx/pending/`. The callback MUST observe the same data and
   declared constraints its changeset is based on.
   The `f1.0` writer protocol has no empty seed mode.
3. **W3.** Run the caller’s data work inside one transaction while recording a session
   over all caller tables; extract the changeset; delete the working copy.
   The callback MUST NOT change the persistent or temporary SQLite schema,
   `application_id`, `user_version`, or fsqlite-owned tables.
   Temporary schema objects include the callback-protection triggers installed by the
   implementation. A writer MUST reject such an attempt rather than silently discard or
   publish it. An empty changeset means the write is a no-op: produce no envelope.
4. **W4.** Create `<txid>.txn/`, write `changeset.bin`, write `manifest.json`, and
   **write the zero-byte `COMMITTED` marker last**. An envelope without `COMMITTED` MUST
   be ignored by reconcile (it is an aborted/in-progress capture) and is quarantined by
   repair (§11). The marker-last discipline makes envelope visibility atomic without any
   lock: unique names mean writers do not contend on a shared path.

A writer MAY copy the base snapshot by plain file copy precisely because published
snapshots are immutable (S6). If the copy fails because aggressive GC removed the base
between the pointer read and the copy (possible only with `retain` near 0), the writer
MUST fail loudly or retry from a fresh pointer read and MUST NOT proceed on a torn copy.

> **Durability note.** The envelope files are *not* required to be fsynced; see §10 for
> exactly what that means and when an accepted write becomes power-loss-durable.

## 6. Reconcile: Fold and Publish

Reconcile folds the committed pending tail into the next snapshot and publishes it.
It MUST be **idempotent** (safe to crash anywhere and re-run; safe to race with other
reconcilers) and MUST apply envelopes in **deterministic order** (lexicographic id
order, §5), so any two reconcilers folding the same tail build equivalent snapshots.

Protocol:

1. **F1.** Read `current` → base.
   Verify that the reconciler’s configured caller-schema identity matches the published
   snapshot before it moves or classifies any envelope.
   List committed envelopes (dirs `*.txn` containing `COMMITTED`), sorted
   lexicographically. If none: done.
2. **F2.** Copy the base snapshot to a `.build-*` transient.
   Load the ledger (`SELECT tx_id FROM applied_tx`) into a *seen* set.
3. **F3.** For each envelope in order:
   - already in *seen* → mark **archivable** (it is in this lineage; move to
     `tx/applied/` after publish);
   - payload missing/unreadable, payload larger than the configured cap (Node default 1
     GiB), digest ≠ `changeset_sha256`, manifest `tx_id` differs from the envelope
     directory, `format_version` or `store_id` differs from the marker, or
     `schema_version` or `schema_hash` differs from the reconciler’s → **quarantine**
     with a reason; never abort the batch;
   - otherwise **apply** the changeset under the per-table merge policy (below), with
     foreign-key enforcement deferred across filtered passes until the complete envelope
     has landed; an envelope that names `applied_tx` or `fsqlite_meta` MUST be
     quarantined; then run `PRAGMA foreign_key_check` and record `tx_id` in
     `applied_tx`; all three operations occur in one transaction in the build snapshot
     before publication; if the apply or foreign key check aborts → **quarantine** with
     the reason; continue with the next envelope.
     Since the prior transaction boundary passed the same check, any reported foreign
     key violation belongs to the current envelope.
4. **F4.** Reassert the build’s application ID, reserved-table shapes and metadata,
   marker identity, schema version, and schema hash.
   Then run the integrity gate (`PRAGMA quick_check` and `PRAGMA foreign_key_check`). A
   failure aborts the whole reconcile (the build is a discarded transient; nothing was
   published).
5. **F5.** If nothing was applied, discard the build, perform the archive/quarantine
   moves, and finish. Otherwise **publish** under the lock (§7):
   - **F5a.** Re-read `current`; if ≠ base, a peer published first, so discard the build
     and retry from F1 (**optimistic concurrency**).
   - **F5b.** Re-validate lock ownership by token (**fencing**, §7); on loss, discard
     and retry.
   - **F5c.** fsync the build (this MAY happen before the lock is taken), then **commit
     it without replacing** to `snapshots/<base+1>.fsqlite.sqlite`: touch the build’s
     mtime, record its identity (device, inode, size, and mtime), hard-link it to the
     snapshot name (`link(2)`, which fails with `EEXIST` rather than replace), remove
     the build name, and fsync `snapshots/`. A replacing `rename()` MUST NOT be used for
     this step, because an overlapping holder (L5) may already have committed or
     published that name.
     If the name exists: re-read `current`, and if it is ≥ base+1 a peer published
     first, so discard and retry from F1. Otherwise the entry is another holder’s commit
     in flight or an orphan of a crashed one.
     An entry whose mtime is older than the lock’s stale window (L2) is an orphan:
     remove it and link again.
     A younger entry MUST NOT be removed; wait, re-checking `current` and fencing, until
     it is published, removed, or stale, and fail loudly at the acquisition timeout.
     Immediately before the pointer swap, re-check `current` == base, fencing (L3), and
     that the snapshot name still has the recorded identity.
     On any mismatch, remove the entry only while it is still this holder’s build and
     `current` < base+1, then retry.
     Swap the pointer per P2/P3. Then re-check the identity once more: if the name no
     longer holds this build, `current` names another holder’s snapshot, so the attempt
     published nothing of its own and MUST retry rather than report success.
     A conforming target filesystem MUST support hard links with these semantics.
6. **F6.** After publish (outside the lock), or after a build that applied nothing, open
   the snapshot that `current` names *now* and read its ledger.
   Move to `tx/applied/` only envelopes whose `tx_id` that ledger contains.
   If it contains every envelope the build applied or found archivable, the published
   lineage is the build’s own: move the build’s quarantined envelopes that the ledger
   does not contain to `tx/quarantine/`, writing each a `QUARANTINE` file containing the
   reason. Otherwise an overlapping holder moved `current` to a lineage the build never
   saw (L5); every remaining envelope MUST stay in `tx/pending/` for the next reconcile
   to classify against that lineage.
   An implementation MUST NOT archive an envelope because its own build applied it.
   The reason MUST be written before the move; if it cannot be persisted, leave that
   envelope in place and fail loudly.
   A failure after the pointer swap (here, or a directory fsync after the pointer
   rename) MUST be reported as distinct from a failure before it, because a caller that
   reruns a write whose version is already published applies it twice.
   The Node implementation sets a numeric `published` property on such errors.
   These moves are non-critical: if a crash skips them, the ledger makes the leftovers
   archivable on the next run.

**Why this is exactly-once.** The ledger row for every folded envelope is *inside* the
snapshot that publication makes current (F3), and publication itself is conditional on
`current` still naming the base the build started from (F5a). Two racing reconcilers can
both build, but only one can publish a given version; the loser rebuilds from the
winner’s snapshot, where the winner’s ledger makes already-folded envelopes no-ops.
A crash before F5c publishes nothing (the build is a transient); a crash after F5c loses
only the F6 moves, which are recovered by the ledger-skip.
Because F6 consults the ledger of the head `current` names rather than the build’s own
belief, an envelope leaves `tx/pending/` only once it is in the published lineage.
**`base_version` in the manifest is informational.
An envelope seeded from version N may be folded into version N+k.** The per-table policy
resolves cross-version merges; the base does not pin them.

**Per-table merge policy.** A policy maps each table name to an action, with `'*'` as
the default for unlisted tables.
The default `'*'` action MUST be `strict`, so an unconfigured table never silently picks
a winner. Conflict policy is not stamped in the `f1.0` marker, snapshot, or envelope.
All reconcilers participating in one caller-schema epoch MUST use the same effective
policy. A future caller-schema migration that changes tables or constraints MUST define
the corresponding policy transition.

| Action (aliases) | On a replaceable DATA or CONFLICT conflict |
| --- | --- |
| `replace` (`lww`) | Incoming row wins |
| `omit` (`union`) | Existing row wins (first-writer-wins / set-union); the conflicting incoming change is dropped |
| `strict` | The *entire envelope* is rejected (quarantined); none of its changes land |

For multiple conflicting envelopes, `lww` therefore means the row from the later
byte-sorted envelope wins.
The timestamp prefix makes that order approximately chronological; it is not a causal or
globally clock-ordered guarantee across hosts.

NOTFOUND, CONSTRAINT, and FOREIGN_KEY conflicts are not replaceable.
Every action MUST reject and quarantine the entire envelope for those conflict types.
An implementation MUST NOT omit a nonreplaceable change and then record its envelope in
`applied_tx`.

All passes of one envelope MUST apply atomically in one transaction.
An envelope either lands in full, except for replaceable changes deliberately dropped by
`omit`, or not at all.
Implementations that require one filtered pass per action MUST run the passes in this
order: `replace`, `omit`, `strict`. Policy object or map insertion order MUST NOT affect
reconciliation. The Node implementation realizes per-table routing as one filtered
`sqlite3changeset_apply` pass per distinct action, all inside a single `BEGIN IMMEDIATE`
transaction, because the binding exposes the table name only to the filter callback (see
`upstream-source-confirmations.md`).

**Constraint closure.** An implementation MUST preserve caller-declared SQLite
constraints at each envelope boundary:

- PRIMARY KEY DATA and CONFLICT cases use the table policy when replaceable.
- NOT NULL, UNIQUE, and CHECK failures surface as nonreplaceable CONSTRAINT outcomes and
  quarantine the complete envelope.
- Foreign-key enforcement is deferred across all filtered passes for one envelope, then
  `foreign_key_check` runs before the ledger row is written.
  A persistent violation quarantines the complete envelope.
- The pre-publication integrity gate repeats `foreign_key_check` over the complete
  build.

This closure does not infer application invariants that SQLite does not declare.
Range, predicate, aggregate, and general cross-row rules require an application guard
row, compare-and-retry pattern, DirectStore, or a future read-set protocol.

The **`writeWithRetry`** pattern (write → reconcile → if quarantined, re-seed and
re-run) is the sanctioned compare-and-retry loop for cross-row invariants over `strict`
tables; it is a client pattern, not a format feature.

## 7. The Publish Lock

The publish lock is a **`mkdir` lease**. A conforming target filesystem MUST give
exclusive directory creation semantics, so `mkdir(store-root/publish.lock)` succeeds for
exactly one racing creator.
The environment must validate this capability rather than infer it from a filesystem
label.
The lease is held only around the publish step (F5), not around writer work or the
build.

- **L1.** Acquire by `mkdir`; on success write `owner.json` (`{token, pid, host, at}`)
  with a fresh random token *inside* the lock dir.

- **L2.** Liveness is the lock dir’s **mtime**. A holder whose critical section has
  several long steps (copying a head, running an application callback, an fsync,
  scanning snapshots) SHOULD heartbeat at each step boundary by touching the dir once
  its age reaches a fraction of the stale window (Node: a quarter), and SHOULD abandon
  the attempt as soon as a heartbeat finds that it lost ownership.
  A single step that outlasts the stale window can still be broken; the stale window
  MUST exceed the longest single step, not the whole section.
  A waiter MAY break a lock whose mtime is older than the stale window.
  It MUST break it in three steps, because two waiters can judge the same lock stale and
  a check-then-delete on `publish.lock` would remove a successor that re-acquired the
  name in between: (1) read `owner.json` and the mtime and judge the lock stale; (2)
  `rename()` the dir aside to `publish.lock.<hex10>.tmp`, which is atomic, so a second
  breaker gets `ENOENT` and the holder can no longer refresh the moved dir; (3) remove
  the moved dir only if it still carries the token read in step 1 and is still older
  than the stale window.
  Otherwise the moved dir is a successor’s live lock: the waiter MUST rename it back,
  or, if another acquirer has completed a new lock in the meantime, remove it (its
  former holder then fails every fencing check).
  Then retry acquisition.
  (Node defaults: stale 20 s, acquire timeout 30 s, poll 25 ms.)
  An implementation MUST enforce **timeout > stale window**. Otherwise, it could break a
  lock it could have waited for.

- **L3 (fencing).** Because a paused holder can be stale-broken and later resume, every
  holder MUST re-read `owner.json` and verify its own token immediately before each
  destructive step (F5b, every repair and GC deletion), and MUST abandon the step on a
  mismatch. The Node implementation fences by verify, touch, verify: it checks its token,
  refreshes the dir’s mtime, and checks the token again, so a fenced step begins with a
  full stale window in which no conforming breaker (L2 step 3) can remove the lock.

- **L4 (fenced release).** On release, a holder MUST remove the lock dir only if
  `owner.json` still carries its token, and MUST remove it through the same
  rename-aside-and-recheck step as L2, so a successor that acquires between the token
  check and the removal is restored rather than deleted.
  A stale-broken holder must not delete a successor’s live lock because doing so would
  admit a third concurrent holder.

- **L5.** Correctness MUST NOT depend on L1-L4 (see §1). Two holders can overlap after a
  stale-lock break, for example when a holder pauses past the stale window and later
  resumes mid-operation.
  With F5c and F6 as specified, overlapping holders cannot:
  - replace a snapshot another holder committed or published, because F5c commits
    without replacing and reclaims only an entry older than the stale window;
  - report another holder’s build as their own publication, because of the identity
    checks around the pointer swap, so a DirectStore write that returns names a snapshot
    that carries its callback;
  - publish a version from a superseded base (F5a, and fencing before each step);
  - apply an envelope twice (the ledger), or archive an envelope that the head `current`
    names does not contain (F6).

  Overlap can still waste work: a fenced-out attempt rebuilds, and a DirectStore attempt
  reruns its callback.
  One window remains in `f1.0`. The pointer swap is a blind `rename()`, so a holder that
  stalls longer than the stale window after its final pre-swap checks but before its
  pointer rename, while at least two later versions are published, can on resuming
  rename its older version over `current`. `current` then still names a complete,
  integrity-gated snapshot, and envelopes not yet settled stay pending (F6), but
  envelopes the newer versions’ publishers already archived, and DirectStore writes they
  already returned, are absent from the restored lineage, and a later publisher reclaims
  the newer snapshot as a stale orphan.
  Step-boundary heartbeats (L2) mean such a stall needs a frozen process, not a slow
  step. Open issue O6 tracks the structural fix.
  Clock skew between hosts makes mtime-based staleness approximate; that is why fencing
  and OCC, not staleness precision, carry correctness.
  (See Open issue O3.)

## 8. Read Leases and Garbage Collection

GC deletes superseded snapshots.
A **read lease** pins a version against GC while a packager/uploader reads it.

- **RL1.** To take a lease: read `current` → v; write `leases/<token>.lease` containing
  `{version: v, pid, host, at}`; **then verify the snapshot file still exists**. If it
  does not, the lease lost a race with GC: remove the lease file and retry from a fresh
  pointer read. (Publish-then-verify is the reader’s half of the race closure; G2’s
  tombstone is GC’s half.)
- **RL2.** Lease liveness is the lease file’s mtime; holders of long leases SHOULD
  heartbeat by touching the file.
  GC MAY treat leases older than its staleness window (Node default 60 s) as abandoned
  and delete them.
- A conforming `seal` or equivalent export that reads a selected snapshot while GC may
  run MUST hold a read lease for that version until the standalone artifact is complete
  and validated.
- **G0.** GC is destructive maintenance and MUST fail closed.
  It MUST reject invalid parameters before touching the store (Node: `retain` a
  non-negative integer; `leaseStaleMs` and `transientStaleMs` positive integers, so a
  zero or negative window cannot turn every live lease or fresh transient into debris).
  It MUST validate the store (§11) and refuse unless the head passed identity and
  integrity validation (`sealed`, `live`, or `in-flight-capture`, whose tells are
  routine on a live store and are never touched by GC): with a corrupt head, the older
  snapshots may be the only recovery points repair has (§11 step 1). It MUST then hold
  the publish lock (L1-L4) for every deletion, fence (L3) before each one, and re-read
  `current` under the lock; if `current` moved backward since validation, repair
  re-pointed the store and GC MUST refuse.
- **G1.** GC MUST keep: the current version; every version `v ≥ current − retain` (i.e.
  `current` plus the `retain` versions preceding it); and every freshly-leased version.
- **G2.** GC MUST delete each snapshot in two phases.
  It re-scans the lease directory, then `rename()`s the snapshot to a
  `snapshots/.gc-<version>-<hex10>.tmp` tombstone, then **re-scans the lease directory
  again**. If a live lease now names the version, GC MUST restore the tombstone to its
  snapshot name (without replacing) and keep it; otherwise it unlinks the tombstone.
  If the second scan fails (for example on an unreadable fresh lease), GC MUST restore
  the snapshot before failing.
  A single re-scan followed by an unlink does not close the race: a reader can publish
  its lease and pass its existence check between them.
  With the tombstone, every interleaving is safe: a reader whose existence check runs
  after the rename fails it and retries (RL1), and a lease published before the rename
  is visible to the second scan.
  A lease that lands just before the rename can see its snapshot vanish briefly, until
  the second scan restores it; the newest `retain` versions are never collected, which
  bounds RL1’s retries.
- **G3.** GC MAY also sweep *stale* transients at the store root, in `snapshots/`, and
  in `tx/pending/` (`.build-*`, `.direct-*`, `.work-*`, and `*.tmp`), but MUST NOT sweep
  *fresh* ones, which may belong to a live initializer, reconcile, DirectStore write, or
  envelope capture in another process.
  Staleness is mtime-based with a window comfortably above any plausible build duration.

## 9. The DirectStore Strategy

DirectStore is the serialized-writer strategy **over the same format**. Multiple
cooperative callers MAY contend for it, but the publish lease admits only one complete
copy, callback, validation, and publication path at a time.
Snapshots produced by either strategy share the same `fsqlite.json` identity marker and
can be read by the other strategy or plain `sqlite3`. No on-disk field records which
strategy produced a snapshot.

Protocol (per write): acquire the publish lock → read `current` → base → copy the base
snapshot to a `.direct-*` transient → mutate it in one transaction → reassert the
callback boundary from W3 and the candidate’s application ID, reserved tables, marker
identity, schema version, and schema hash → integrity-gate (`quick_check` and
`foreign_key_check`) → fsync → re-check `current` == base (OCC) and lock token (fencing)
→ commit to `snapshots/<base+1>` without replacing, with the identity checks and pointer
swap of F5c → release.
On an OCC, fencing, or identity failure, discard the build, removing a committed entry
only while it is still this writer’s build and ahead of `current`, then retry.
A retry MUST NOT leave its committed build behind: if the pointer were later torn,
repair could select that orphan as the newest clean snapshot and expose a write whose
caller saw it fail.
The post-swap identity check means a successful return always names a
snapshot that carries this writer’s callback.

There are no envelopes, reconcile step, or merge policy.
The writer **does not require the session extension**, so the strategy runs on any
SQLite build. Because it performs OCC on `current` under the same lock, DirectStore
composes safely with SnapshotStore reconcilers publishing into the same store.
Because a lost OCC or fencing race retries the complete operation, the application
callback MAY run more than once and MUST be safe to retry.

## 10. Durability Model

fsqlite distinguishes **process-crash safety** (the OS survives; ordering comes from
atomic rename) from **power-loss safety** (requires fsync barriers).
The required barriers:

| Step | Required barriers |
| --- | --- |
| Publish a snapshot (init, reconcile F5c, DirectStore) | fsync snapshot file → no-replace hard link → fsync `snapshots/` dir → then pointer swap |
| Pointer swap (P2/P3) | fsync pointer temp → rename over `current` → fsync store root |
| Envelope creation (W4) | **none required** (see below) |
| Archive/quarantine moves (F6) | none required (recovered via the ledger) |
| Store subdirectories (`snapshots/`, `tx/*`, `leases/`) | fsync the parent of each directory init creates, deepest first |

File and directory fsync barriers in this table are required, not best effort.
If opening or fsyncing a required directory fails, initialization or publication MUST
fail loudly and MUST NOT report a power-loss-durable success.
A capability probe used to declare a target safe MUST include directory fsync.
A file barrier MUST be issued through a handle that can flush on the platform: Windows
`FlushFileBuffers` fails on a read-only handle, so the Node implementation opens every
file it syncs read-write on every platform (POSIX `fsync` flushes the same either way).
Directory barriers open the directory read-only and are POSIX-only (O1). A platform or
filesystem without that capability is unsupported for `f1.0` mutation rather than
silently downgraded.

**Barrier mechanics.** Every barrier in the table is an fsync the implementation issues
itself, on the file or directory, after the SQLite connection that wrote the file has
closed. SQLite’s own syncs while it writes a transient build, working copy, or
`VACUUM INTO` output are not barriers in this protocol, so SQLite’s `synchronous` and
`fullfsync` settings do not affect publication durability.
On Apple platforms `fsync(2)` flushes only to the drive’s cache; an implementation there
MUST issue `fcntl(F_FULLFSYNC)` for each barrier, using the strongest weaker barrier
only where the filesystem rejects it.
Node’s `fs.fsyncSync` already does this: libuv’s `uv__fs_fsync` tries `F_FULLFSYNC`,
then `F_BARRIERFSYNC`, then `fsync`, so the Node implementation’s barriers are full
flushes on macOS without any SQLite pragma.

**The store’s commit point is publication.** A successful `write()` (envelope dropped,
id returned) is *accepted*, and survives process crashes, but is **not power-loss
durable until a reconcile publishes a snapshot containing it** because the envelope
files are not fsynced.
After a power loss, R1’s “unpublished tail” therefore includes accepted envelopes that
had not yet been folded.
Implementations MAY additionally fsync the envelope payload and dir to harden
accepted-but-unpublished writes (see Open issue O2); callers needing a hard durability
receipt run `reconcile()` after `write()`.

Published snapshots, once the pointer swap’s barriers complete, MUST survive power loss.
A torn publish (power loss between the snapshot commit and the pointer swap) leaves an
orphan snapshot ahead of a valid pointer.
Repair restores this `in-flight-capture` state (§11), and the previous head remains
intact (R1).

A conforming backup of a live store MUST pin or otherwise retain one published snapshot
and copy that immutable SQLite file, or use SQLite’s online backup or `VACUUM INTO`
facilities.
A `seal` or export MUST publish its output like a completed file: write it to
a uniquely-named temp in the destination directory, validate it, fsync it, `rename()` it
over the destination, and fsync that directory.
`VACUUM INTO` writes in place and does not fsync its output, so it MUST target the temp,
never the final path; a reader of the destination then sees the previous file or the
complete export, and an interrupted seal leaves only its temp.
The destination MUST NOT be a store-owned path (`current`, `fsqlite.json`,
`publish.lock`, or anything under the store’s subdirectories).
This specification makes no guarantee about an arbitrary recursive directory copy racing
publication, garbage collection, or interruption.

## 11. Validation States and Repair

Recognition happens before store-health validation:

| Result | Meaning / detection |
| --- | --- |
| `not-a-store` | `fsqlite.json` is absent; no other filename may establish identity |
| `invalid` | `fsqlite.json` exists but is malformed, has the wrong `format`, or violates the marker schema |
| `unsupported` | The marker is valid fsqlite metadata but its version or a required feature is not supported by this implementation |

All three results prohibit writes, repair, GC, and automatic metadata changes.
`unsupported` MUST remain distinct from `corrupt`: an older repair implementation does
not understand enough to diagnose or modify a newer valid store safely.

After recognizing a supported store, `validate` classifies its health from the full
layout, trusting no single file:

| State | Meaning / detection |
| --- | --- |
| `sealed` | Pointer valid, head passes `integrity_check` and `foreign_key_check`, no committed pending envelopes, no in-flight tells |
| `live` | As `sealed`, but committed pending envelopes await reconcile |
| `in-flight-capture` | Head valid, but in-flight tells present: transients (§2), orphan snapshots ahead of the pointer, a held/leftover `publish.lock`, uncommitted envelopes (no `COMMITTED`), or SQLite `-wal`/`-shm` side files next to snapshots |
| `corrupt` | Pointer missing/torn/non-numeric, pointer names a missing snapshot, head identity or required reserved schema/metadata mismatches the marker and format, or the head fails `integrity_check` or `foreign_key_check` |

Operator exit-code convention (CLI): `sealed`/`live` → 0, `in-flight-capture` → 2,
`invalid`/`corrupt` → 3, and `unsupported` → 4. A path that is `not-a-store` is an input
classification error rather than a store-health result.

**Repair** restores the last consistent point, which is principled because every
published snapshot was integrity-gated at publish and never modified (S6):

1. Scan snapshots without modifying any file.
   If the pointer is valid and its snapshot passes `integrity_check` and
   `foreign_key_check`, keep it.
   Otherwise identify the **newest integrity-clean snapshot**. If none exists, fail
   without deleting or rewriting anything so forensic recovery remains possible.
   Only after finding a clean destination may repair re-point and delete corrupt
   snapshots.
2. Acquire `publish.lock` through L1-L5 and revalidate its owner token immediately
   before every pointer write, snapshot deletion, transient deletion, and envelope move.
   A fresh publisher lock makes repair refuse without mutation.
   A stale lock MAY be reclaimed only through the normal fenced stale-break and
   acquisition path in L2-L4; repair MUST then act only while its acquired token remains
   valid. Repair MUST NOT delete a lock based on a separate pre-acquisition check.
3. Delete snapshots **ahead** of the restored pointer (rolled-back orphans of a torn
   publish) and all transients.
4. Quarantine envelopes lacking `COMMITTED` whose directory mtime is older than the
   transient stale window (G3), preserving evidence with a `QUARANTINE` reason file.
   A younger one may be a live capture and MUST be left in place.
   A writer’s `COMMITTED` write can land between repair’s check and its move, so repair
   MUST check for `COMMITTED` again after moving the envelope and, if it is there,
   remove the reason file and move the envelope back to `tx/pending/`. The writer’s
   write either lands in the moved dir, where that check sees it, or fails, so the
   writer never reports success for an envelope repair quarantined.

Repair MUST NOT delete committed pending envelopes because the next reconcile folds this
unpublished work. Repair also MUST NOT modify any snapshot in place.

## 12. Versioning and Evolution

- **`format_version`** versions *this layout and protocol*. It is stored in both
  `fsqlite.json` and each snapshot’s `fsqlite_meta` table as a string of the form
  `f<major>.<minor>`; this specification defines `f1.0`. The `f` prefix identifies the
  value as an fsqlite format version when it is encountered outside the marker.
  The major component changes for an incompatible layout or protocol.
  The minor component changes for an additive revision within the same major generation.
  Implementations MUST refuse to write a store whose exact `format_version` they do not
  support unless that implementation explicitly defines compatibility with the newer
  minor revision. They SHOULD still read older versions they understand.
- **Marker evolution** uses three channels.
  Unknown optional fields are ignored.
  Mandatory additive behavior is named in `required_features`; an implementation MUST
  reject any feature it does not understand.
  An incompatible layout or protocol increments the major component.
  Package versions and format versions never imply one another.
- **`schema_version`** (`PRAGMA user_version`) and **`schema_hash`** version the
  *caller’s* schema. Together they are one immutable `f1.0` schema identity.
  Same version and same hash → compatible; same version and different hash → reject at
  open, quarantine a foreign envelope at reconcile; different version → reject or
  quarantine. Incrementing `schema_version` does not migrate a store.
  No normal `f1.0` operation changes either token on an existing store.
  A future caller-schema migration protocol must define writer admission, treatment of
  old pending envelopes, deterministic DDL and data transformation, conflict-policy
  transition, validation, crash recovery, rollback, and cutover.
  This exact-identity rule applies even when SQLite could structurally apply a changeset
  after an additive schema change.
  A session changeset contains row operations rather than DDL, so `f1.0` does not infer
  a safe mixed-schema transition from structural compatibility.
- **Unknown manifest fields and unknown `fsqlite_meta` keys MUST be ignored.** They are
  the forward-compatibility channel.
- The changeset payload is produced and consumed by SQLite’s session extension.
  `f1.0` does not separately version or reinterpret that binary representation.
  Compatibility across SQLite releases and bindings is a conformance claim that an
  implementation MUST validate for every combination it supports; database-file
  compatibility alone does not prove changeset compatibility.

Normal open, read, write, reconcile, validation, GC, and repair operations MUST NOT
upgrade a store. A whole-format upgrade is an explicit operator action and is
side-by-side by default:

1. Fully validate the source and pin a stable source snapshot or require the source to
   be quiescent.
2. Build a new destination directory in the target format, preserving `store_id` because
   it is the same logical store.
   A clone or fork instead receives a new `store_id`.
3. Validate the complete destination before exposing it.
4. Leave the source untouched; operator cutover selects the destination.

An implementation MUST NOT offer an in-place major upgrade without a separately
specified crash-recoverable maintenance protocol.
An allowed metadata-only marker rewrite uses a temporary file in the store root, fsync,
atomic rename, and root-directory fsync, and preserves `store_id`. The first explicit
upgrade implementation is post-alpha work.

## 13. Conformance Roles

**Reader** (no fsqlite code required beyond these rules):

- MUST parse `current` per P1 and open only `snapshots/<version>.fsqlite.sqlite`.
- MUST open snapshots read-only; MUST NOT modify any store file.
- MUST re-read the pointer to observe a newer publish (close-to-open: a fresh open per
  read batch); a snapshot already open stays consistent forever (immutability).
- SHOULD take a read lease (RL1/RL2) for any read longer than the GC retain horizon.

**Writer**: W1-W4, S2-S4 callback and schema validation, the compatibility check of §3,
and a session-capable SQLite build (or the DirectStore strategy, §9).

**Reconciler**: F1-F6, the policy semantics of §6, L1-L5, and the §12 quarantine rules.
A reconciler MUST NOT apply an envelope outside the deterministic order, MUST NOT
publish a build whose integrity gate failed, and MUST NOT mutate a published snapshot.

**Operator tool**: MUST implement `validate` per §11 before any destructive operation;
`repair` MUST follow §11’s rules; GC MUST follow G0-G3.

**Conformance fixtures** (post-alpha): a directory of sealed, live, in-flight
(orphan-ahead), corrupt-pointer, corrupt-head, and quarantined-envelope golden stores,
plus a verifier script.
The same artifacts test every implementation.

## 14. Open Issues in Format v1

- **O1: Windows rename-replace.** P2 requires POSIX rename-over-existing semantics;
  Win32 `rename` fails on an existing target.
  A Windows implementation needs `ReplaceFile`/`MoveFileEx(MOVEFILE_REPLACE_EXISTING)`
  semantics for the pointer, and `CreateHardLink` for the F5c no-replace commit.
  The cross-platform CI matrix gates the claim.

- **O2: Envelope durability option.** §10 makes accepted-but-unpublished writes
  non-durable across power loss by design.
  An opt-in “fsync envelopes” mode (payload and dir) would harden the accepted state for
  callers that need it.

- **O3: Clock skew and mtime staleness.** Lock staleness (L2), lease staleness (RL2),
  and transient staleness (G3) all compare a *local* clock against an mtime that may
  have been set by another host.
  Correctness never depends on these (L5), but liveness tuning on skewed clusters is
  undocumented; the planned real-NFS gate and protocol model both probe this.

- **O4: `base_version` is unused.** Manifests record the seed base, but reconcile
  intentionally ignores it (cross-version merge is policy-resolved).
  This specification treats it only as provenance.
  A future version could instead define semantics such as staleness warnings.

- **O5: conflict-policy identity is not stamped.** All reconcilers in one caller-schema
  epoch must use the same effective policy, but `f1.0` relies on deployment
  configuration to enforce that rule.
  A future revision should bind the normalized policy to the store or schema epoch, or
  define an equivalent admission check and policy-transition protocol.

- **O6: Shared snapshot names and a blind pointer swap.** Every publisher of version N+1
  competes for the one path `snapshots/<N+1>`, and the pointer swap cannot fail on a
  changed `current`. F5c and F6 make overlapping holders safe except for the
  late-pointer window in L5. A future `f1.x` revision should publish builds under unique
  names (for example `<version>-<hex10>.fsqlite.sqlite`) with `current` naming the file,
  gated by a `required_features` entry, so builds never share a path and the pointer
  identifies the exact build.
  Closing the late-pointer window additionally needs a pointer protocol that cannot move
  `current` backward, such as a no-replace commit of a per-version pointer record.

## 15. References

- Design rationale: [`fsqlite-design.md`](fsqlite-design.md)
- Source-pinned binding findings:
  [`upstream-source-confirmations.md`](upstream-source-confirmations.md)
- Fixed SQLite file identity: [`application-id.md`](application-id.md)
- Test-to-guarantee map and manual QA: [`qa-runbook.md`](qa-runbook.md)
- [SQLite session extension](https://sqlite.org/sessionintro.html)
- [`VACUUM INTO`](https://sqlite.org/lang_vacuum.html)

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
