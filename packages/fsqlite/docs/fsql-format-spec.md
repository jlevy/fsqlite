# fsqlite On-Disk Format and Coordination Protocol — Specification

**format_version: 1** · Status: Draft (normative for the v1 format; tracks the Node
reference implementation at `packages/fsqlite/`)

This is the normative definition of the fsqlite **store format** and **coordination
protocol** — the language-agnostic deliverable that the Node library and CLI merely
implement first. A conforming implementation in any language can read, write, reconcile,
or operate a store interoperably with every other conforming implementation.

The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are to be interpreted as
in RFC 2119. Requirements are stated against four conformance roles defined in §13:
**Reader**, **Writer**, **Reconciler**, and **Operator tool**.

Where this document and the Node implementation disagree, that is a bug in one of them;
file it.
Implementation *defaults* (timeouts, retry counts) are noted as such and are not
normative; protocol *invariants* are.

* * *

## 1. Design Invariants

Everything in this format serves two correctness invariants:

- **R1 (bounded loss).** A crash, stale-lock overlap, torn capture, or hot copy taken
  while live loses at most the *unpublished tail* — never a previously published
  snapshot. The **commit point of the store is snapshot publication** (§6); see §10 for
  what is durable before that point.
- **R2 (no silent corruption).** Every detectable inconsistency is surfaced by
  validation (§11), never silently accepted or repaired-over.

Three structural properties deliver them:

1. **Published snapshots are immutable.** Once a snapshot file is named by the `current`
   pointer (now or in the past), no process may modify it.
   All mutation happens in uniquely-named transient files, made visible only by atomic
   rename.
2. **The pointer swap is the only commit.** A snapshot exists but is not *the store*
   until `current` names it, and `current` is replaced atomically.
3. **The lock is not load-bearing for correctness.** The publish lock (§7) only reduces
   wasted work. Exactly-once application is guaranteed by the `applied_tx` ledger plus
   optimistic concurrency on `current` (§6), so overlapping lock holders — possible
   after a stale-lock break — cannot double-apply or corrupt.

The on-disk artifact never stops being ordinary SQLite: any SQLite binding in any
language can open a published snapshot with no fsqlite code at all.

## 2. Store Layout

A store is a directory tree rooted at the **catalog root**. All paths below are relative
to it.

> The Node implementation nests the catalog root at `<storeDir>/data/catalog/` (a layout
> inherited from its first consumer); the format is defined from the catalog root down.
> Whether to flatten that nesting before publish is Open Issue O1 (§14).

```
<catalog-root>/
  current                          # the pointer: ASCII decimal version (§4)
  publish.lock/                    # mkdir lease, present only while held (§7)
    owner.json                     #   {token, pid, host, at}
  snapshots/
    000000000000.fsqlite.sqlite    # immutable published snapshot, version 0 (§3)
    000000000001.fsqlite.sqlite
    .build-<hex10>.sqlite          # transient: reconcile build (§6)
    .direct-<hex10>.sqlite         # transient: DirectStore build (§9)
    *.tmp                          # transient: init's snapshot-0 build (§3)
  tx/
    pending/
      <txid>.txn/                  # transaction envelope (§5)
        manifest.json
        catalog.changeset
        COMMITTED                  #   zero-byte marker, written last
      .work-<writerId>-<hex10>.sqlite  # transient: writer working copy (§5)
    applied/<txid>.txn/            # envelopes folded into a published snapshot
    quarantine/<txid>.txn/         # rejected envelopes (+ QUARANTINE reason file)
  leases/
    <token>.lease                  # read lease: {version, pid, host, at} (§8)
```

Naming grammar:

- **Snapshot**: `<version>.fsqlite.sqlite` where `<version>` is the decimal version
  zero-padded to 12 digits.
  Files matching `^(\d+)\.fsqlite\.sqlite$` and nothing else are snapshots.
- **Transients** are exactly the files matching: prefix `.build-`, prefix `.direct-`,
  prefix `.work-` (under `tx/pending/`), or suffix `.tmp`. Transients are never part of
  store state; a *fresh* transient indicates work in flight, an *old* one indicates a
  crash (§11).
- **Envelope dir**: `<txid>.txn` (§5 defines `<txid>`).
- **Hex tokens** (`<hex10>` etc.)
  are lowercase hex from a cryptographically random source; their only requirement is
  uniqueness.

## 3. Snapshot Files

A snapshot is a complete, self-contained SQLite database file.
Requirements:

- **S1.** It MUST be a well-formed SQLite database passing `PRAGMA integrity_check`.

- **S2.** It MUST carry `PRAGMA application_id` = the store’s app id (caller-chosen; the
  Node default is `0x534E4C47`) and `PRAGMA user_version` = the store’s
  `schema_version`. These are the *foreign-readable* capability stamps: any tool can
  identify the store kind and schema generation without fsqlite code.

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
  SHA-256 of the caller’s schema DDL string, UTF-8), `tool_version` (informational),
  `format_version` (this document’s version, currently `'1'`). Implementations MUST
  ignore unknown keys, and MUST tolerate a missing `fsqlite_meta` table (stores created
  before format_version was stamped).

- **S4.** Every *caller* table (any table not named `sqlite_*`, `applied_tx`, or
  `fsqlite_meta`) MUST have a primary key, and unless it is a single-column
  `INTEGER PRIMARY KEY` (a non-null rowid alias), every PK column MUST be declared
  `NOT NULL`. Writers/initializers MUST reject schemas violating this — the merge policy
  (§6) is keyed on primary keys, and SQLite otherwise permits NULLs in non-integer PKs.

- **S5.** A published snapshot MUST NOT have live `-wal`/`-shm` side files.
  (Snapshots are built and committed in rollback-journal mode and are closed before
  publication; side files present next to snapshots are an in-flight/corruption tell,
  §11.)

- **S6.** A published snapshot file MUST never be modified.
  Repair (§11) may *delete* snapshots, never edit them.

Snapshot 0 is the schema-only initial snapshot created by `init` (empty caller tables,
both reserved tables, identity stamped).
First-open MUST be fenced: build under the publish lock through a uniquely-named
transient, rename into place, then publish the pointer — so concurrent initializers
converge on one snapshot 0. After init (and on every reopen), an implementation MUST
verify compatibility: `user_version` equals its `schema_version`, `application_id`
equals its app id, and — when the stamp is present — `fsqlite_meta.schema_hash` equals
the hash of its own DDL. The last check rejects a *divergent schema at the same
version*, which the integer alone cannot catch.

## 4. The `current` Pointer

`current` contains the published version as an ASCII decimal string (no padding
required; the Node implementation writes the bare number with no trailing newline).

- **P1.** Readers MUST parse strictly: after trimming ASCII whitespace, the content MUST
  match `^\d+$`. Anything else (including empty) is **corruption**, surfaced per R2 —
  never silently treated as version 0.
- **P2.** The pointer MUST be replaced atomically and durably: write the new content to
  a uniquely-named temp file in the same directory → fsync the temp file → `rename()` it
  over `current` → fsync the directory.
- **P3.** The snapshot a new pointer names MUST already be durable (fsynced and renamed
  into `snapshots/`, directory fsynced) *before* the pointer swap.
  The pointer must never name a snapshot that power loss could un-create.

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
| `writer_id` | The raw writer id (provenance) |
| `base_version` | The published version the working copy was seeded from (informational; the format is not base-pinned — see §6) |
| `schema_version` | Writer’s schema generation; reconcile quarantines a mismatch |
| `schema_hash` | Writer’s DDL hash; reconcile quarantines a mismatch **when present** (older envelopes omit it) |
| `created_at` | ISO-8601 timestamp (informational) |
| `changeset` | Payload filename, `catalog.changeset` |
| `changeset_sha256` | Full 64-hex SHA-256 of the payload; reconcile quarantines a digest mismatch |
| `seed` | `snapshot` or `schema-only` (how the working copy was built; informational) |
| `tool_version` | Producing implementation (provenance) |

**Writer protocol** (all steps lock-free):

1. **W1.** Validate the writer id against the regex above.
2. **W2.** Read `current` → base; build a private working copy as a `.work-*` transient
   under `tx/pending/`: either a file copy of the (immutable) base snapshot
   (`seed: snapshot` — correct for any mutation) or an empty database holding only the
   schema (`seed: schema-only` — O(1), valid **only** for inserts of new keys; same-key
   collisions then surface at reconcile under the table’s policy).
3. **W3.** Run the caller’s work inside one transaction while recording a session over
   all tables; extract the changeset; delete the working copy.
   An empty changeset means the write is a no-op: produce no envelope.
4. **W4.** Create `<txid>.txn/`, write `catalog.changeset`, write `manifest.json`, and
   **write the zero-byte `COMMITTED` marker last**. An envelope without `COMMITTED` MUST
   be ignored by reconcile (it is an aborted/in-progress capture) and is quarantined by
   repair (§11). The marker-last discipline makes envelope visibility atomic without any
   lock: unique names mean writers never contend, on local disk or NFS.

A writer MAY copy the base snapshot by plain file copy precisely because published
snapshots are immutable (S6). If the seed copy fails because aggressive GC removed the
base between the pointer read and the copy (possible only with `retain` near 0), the
writer MUST fail loudly or retry from a fresh pointer read — never proceed on a torn
copy.

> **Durability note.** The envelope files are *not* required to be fsynced; see §10 for
> exactly what that means and when an accepted write becomes power-loss-durable.

## 6. Reconcile: Fold and Publish

Reconcile folds the committed pending tail into the next snapshot and publishes it.
It MUST be **idempotent** (safe to crash anywhere and re-run; safe to race with other
reconcilers) and MUST apply envelopes in **deterministic order** (lexicographic id
order, §5), so any two reconcilers folding the same tail build equivalent snapshots.

Protocol:

1. **F1.** Read `current` → base.
   List committed envelopes (dirs `*.txn` containing `COMMITTED`), sorted
   lexicographically. If none: done.
2. **F2.** Copy the base snapshot to a `.build-*` transient.
   Load the ledger (`SELECT tx_id FROM applied_tx`) into a *seen* set.
3. **F3.** For each envelope in order:
   - already in *seen* → mark **archivable** (it is in this lineage; move to
     `tx/applied/` after publish);
   - payload missing/unreadable, payload larger than the configured cap (Node default 1
     GiB), digest ≠ `changeset_sha256`, `schema_version` ≠ the reconciler’s, or (when
     present) `schema_hash` ≠ the reconciler’s → **quarantine** with a reason; never
     abort the batch;
   - otherwise **apply** the changeset under the per-table merge policy (below) and
     record `tx_id` in `applied_tx` — both into the build snapshot, both before publish;
     if the apply aborts (strict conflict or any error) → **quarantine** with the
     reason; continue with the next envelope.
4. **F4.** Run an integrity gate (`PRAGMA quick_check`) on the build.
   A failure aborts the whole reconcile (the build is a discarded transient; nothing was
   published).
5. **F5.** If nothing applied: discard the build, perform the archive/quarantine moves,
   done. Otherwise **publish** under the lock (§7):
   - **F5a.** Re-read `current`; if ≠ base, a peer published first — discard the build
     and retry from F1 (**optimistic concurrency**).
   - **F5b.** Re-validate lock ownership by token (**fencing**, §7); on loss, discard
     and retry.
   - **F5c.** fsync the build → `rename()` it to `snapshots/<base+1>...` (the rename
     MUST replace any orphan left at that name by a previously crashed publish) → fsync
     the directory → swap the pointer per P2/P3.
6. **F6.** After publish (outside the lock), move applied and archivable envelopes to
   `tx/applied/` and quarantined ones to `tx/quarantine/`, writing each quarantined
   envelope a `QUARANTINE` file containing the reason.
   These moves are non-critical: if a crash skips them, the ledger makes the leftovers
   archivable on the next run.

**Why this is exactly-once.** The ledger row for every folded envelope is *inside* the
snapshot that publication makes current (F3), and publication itself is conditional on
`current` still naming the base the build started from (F5a). Two racing reconcilers can
both build, but only one can publish a given version; the loser rebuilds from the
winner’s snapshot, where the winner’s ledger makes already-folded envelopes no-ops.
A crash before F5c publishes nothing (the build is a transient); a crash after F5c loses
only the F6 moves, which are recovered by the ledger-skip.
**Note that `base_version` in the manifest is informational: an envelope seeded from
version N may legitimately be folded into version N+k** — cross-version merge is
resolved by the per-table policy, not by base pinning.

**Per-table merge policy.** A policy maps table name → action, with `'*'` as the default
for unlisted tables; the default `'*'` action MUST be `strict` (deny-by-default: an
unconfigured table never silently picks a winner).

| Action (aliases) | On a same-PK conflict |
| --- | --- |
| `replace` (`lww`) | Incoming row wins — but only where SQLite permits `REPLACE` (DATA and CONFLICT conflict types); other conflict types fall back to `omit` |
| `omit` (`union`) | Existing row wins (first-writer-wins / set-union); the conflicting incoming change is dropped |
| `strict` | The *entire envelope* is rejected (quarantined); none of its changes land |

All passes of one envelope MUST apply atomically (one transaction): an envelope either
lands in full (modulo `omit`-dropped rows) or not at all.
The Node implementation realizes per-table routing as one filtered
`sqlite3changeset_apply` pass per distinct action, all inside a single `BEGIN IMMEDIATE`
transaction, because the binding exposes the table name only to the filter callback (see
`upstream-source-confirmations.md`).

The **`writeWithRetry`** pattern (write → reconcile → if quarantined, re-seed and
re-run) is the sanctioned compare-and-retry loop for cross-row invariants over `strict`
tables; it is a client pattern, not a format feature.

## 7. The Publish Lock

The publish lock is a **`mkdir` lease**: `mkdir(catalog-root/publish.lock)` succeeds for
exactly one creator on local disk *and* on NFS/SMB (the same primitive git and npm use
cross-host). It is held only around the publish step (F5) — never around writer work or
the build.

- **L1.** Acquire by `mkdir`; on success write `owner.json` (`{token, pid, host, at}`)
  with a fresh random token *inside* the lock dir.
- **L2.** Liveness is the lock dir’s **mtime**; a live long holder SHOULD touch it
  (heartbeat). A waiter MAY break a lock whose mtime is older than the stale window, by
  removing the dir and retrying acquisition.
  (Node defaults: stale 20 s, acquire timeout 30 s, poll 25 ms.)
  An implementation MUST enforce **timeout > stale window** — otherwise it could break a
  lock it could simply have waited out.
- **L3 (fencing).** Because a paused holder can be stale-broken and later resume, every
  holder MUST re-read `owner.json` and verify its own token immediately before the
  destructive publish step (F5b), and MUST abandon the publish on a mismatch.
- **L4 (fenced release).** On release, a holder MUST remove the lock dir only if
  `owner.json` still carries its token — a stale-broken holder must not delete a
  successor’s live lock (which would admit a third concurrent holder).
- **L5.** Correctness MUST NOT depend on L1–L4 (see §1): even two overlapping holders
  cannot double-publish a version (F5a) or double-apply an envelope (the ledger).
  Clock skew between hosts makes mtime-based staleness approximate; that is why fencing
  and OCC, not staleness precision, carry correctness.
  (See Open issue O5.)

## 8. Read Leases and Garbage Collection

GC deletes superseded snapshots.
A **read lease** pins a version against GC while a packager/uploader reads it.

- **RL1.** To take a lease: read `current` → v; write `leases/<token>.lease` containing
  `{version: v, pid, host, at}`; **then verify the snapshot file still exists**. If it
  does not, the lease lost a race with GC: remove the lease file and retry from a fresh
  pointer read. (Publish-then-verify closes the check-then-act race from the reader’s
  side.)
- **RL2.** Lease liveness is the lease file’s mtime; holders of long leases SHOULD
  heartbeat by touching the file.
  GC MAY treat leases older than its staleness window (Node default 60 s) as abandoned
  and delete them.
- **G1.** GC MUST keep: the current version; every version `v ≥ current − retain` (i.e.
  `current` plus the `retain` versions preceding it); and every freshly-leased version.
- **G2.** GC MUST re-scan the lease directory **immediately before each individual
  snapshot unlink** — a lease may have been published after GC’s initial scan (this is
  the GC-side half of the race closure; RL1 is the reader-side half).
  The newest `retain` versions are never collected, which bounds RL1’s retries.
- **G3.** GC MAY also sweep *stale* transients (`.build-*`, `.direct-*`, `*.tmp`) — but
  MUST NOT sweep *fresh* ones, which may belong to a live reconcile or DirectStore write
  in another process. Staleness is mtime-based with a window comfortably above any
  plausible build duration.

## 9. The DirectStore Strategy

DirectStore is the easy-local single-writer strategy **over the identical format** — a
store written by either strategy is read by the other (and by plain `sqlite3`) with no
markers distinguishing them.

Protocol (per write): acquire the publish lock → read `current` → base → copy the base
snapshot to a `.direct-*` transient → mutate it in one transaction → integrity-gate
(`quick_check`) → re-check `current` == base (OCC) and lock token (fencing) → fsync,
rename to `snapshots/<base+1>`, fsync dir, pointer swap (P2/P3) → release.
On an OCC or fencing failure, discard and retry.

There are no envelopes, no reconcile, no merge policy — and **no session extension even
for the writer**, so the strategy runs on any SQLite build.
Because it performs OCC on `current` under the same lock, DirectStore composes safely
with SnapshotStore reconcilers publishing into the same store.

## 10. Durability Model

fsqlite distinguishes **process-crash safety** (the OS survives; ordering comes from
atomic rename) from **power-loss safety** (requires fsync barriers).
The required barriers:

| Step | Required barriers |
| --- | --- |
| Publish a snapshot (init, reconcile F5c, DirectStore) | fsync snapshot file → rename → fsync `snapshots/` dir → then pointer swap |
| Pointer swap (P2/P3) | fsync pointer temp → rename over `current` → fsync catalog dir |
| Envelope creation (W4) | **none required** (see below) |
| Archive/quarantine moves (F6) | none required (recovered via the ledger) |

**The store’s commit point is publication.** A successful `write()` (envelope dropped,
id returned) is *accepted*, and survives process crashes, but is **not power-loss
durable until a reconcile publishes a snapshot containing it** — the envelope files are
not fsynced. After a power loss, R1’s “unpublished tail” therefore includes accepted
envelopes that had not yet been folded.
Implementations MAY additionally fsync the envelope payload and dir to harden
accepted-but-unpublished writes (see Open issue O3); callers needing a hard durability
receipt run `reconcile()` after `write()`.

Published snapshots, once the pointer swap’s barriers complete, MUST survive power loss.
A torn publish (power loss between snapshot rename and pointer swap) leaves an orphan
snapshot ahead of a valid pointer — state `in-flight-capture`, restored by repair (§11);
the previous head is intact (R1).

## 11. Validation States and Repair

`validate` classifies a store from layout alone, trusting no single file:

| State | Meaning / detection |
| --- | --- |
| `sealed` | Pointer valid, head passes `integrity_check`, no committed pending envelopes, no in-flight tells |
| `live` | As `sealed`, but committed pending envelopes await reconcile |
| `in-flight-capture` | Head valid, but in-flight tells present: transients (§2), orphan snapshots ahead of the pointer, a held/leftover `publish.lock`, uncommitted envelopes (no `COMMITTED`), or SQLite `-wal`/`-shm` side files next to snapshots |
| `corrupt` | Pointer missing/torn/non-numeric, pointer names a missing snapshot, or the head fails `integrity_check` |

Operator exit-code convention (CLI): `sealed`/`live` → 0, `in-flight-capture` → 2,
`corrupt` → 3.

**Repair** restores the last consistent point, which is principled because every
published snapshot was integrity-gated at publish and never modified (S6):

1. If the pointer is valid and its snapshot passes `integrity_check`, keep it.
   Otherwise re-point at the **newest integrity-clean snapshot**, deleting corrupt ones
   encountered on the way down; fail loudly if none exists.
2. Delete snapshots **ahead** of the restored pointer (rolled-back orphans of a torn
   publish) and all transients.
3. Quarantine envelopes lacking `COMMITTED` (preserving evidence with a `QUARANTINE`
   reason file).
4. Remove a `publish.lock` older than the staleness window.

Repair MUST NOT delete committed pending envelopes (they are unpublished work — folded
by the next reconcile) and MUST NOT modify any snapshot in place.

## 12. Versioning and Evolution

- **`format_version`** (`fsqlite_meta`) versions *this layout and protocol*. It is
  bumped only for incompatible layout/protocol changes.
  Implementations MUST refuse to write a store whose `format_version` they do not
  support, SHOULD still read older versions they understand, and MUST tolerate its
  absence (pre-stamp stores are v1).
- **`schema_version`** (`PRAGMA user_version`) and **`schema_hash`** version the
  *caller’s* schema. Same version and same hash → compatible; same version and different
  hash → reject at open, quarantine at reconcile; different version → reject/quarantine
  (until schema migration, a planned v-next feature, defines an upgrade path).
- **Unknown manifest fields and unknown `fsqlite_meta` keys MUST be ignored** — they are
  the forward-compatibility channel.
- The changeset payload format is owned by SQLite’s session extension and versioned by
  SQLite itself; fsqlite inherits its compatibility guarantees.

## 13. Conformance Roles

**Reader** (no fsqlite code required beyond these rules):
- MUST parse `current` per P1 and open only `snapshots/<version>.fsqlite.sqlite`.
- MUST open snapshots read-only; MUST NOT modify any store file.
- MUST re-read the pointer to observe a newer publish (close-to-open: a fresh open per
  read batch); a snapshot already open stays consistent forever (immutability).
- SHOULD take a read lease (RL1/RL2) for any read longer than the GC retain horizon.

**Writer**: W1–W4, S4 schema validation at init, the compatibility check of §3, and a
session-capable SQLite build (or the DirectStore strategy, §9).

**Reconciler**: F1–F6, the policy semantics of §6, L1–L5, and the §12 quarantine rules.
A reconciler MUST NOT apply an envelope outside the deterministic order, MUST NOT
publish a build whose integrity gate failed, and MUST NOT mutate a published snapshot.

**Operator tool**: MUST implement `validate` per §11 before any destructive operation;
`repair` MUST follow §11’s rules; GC MUST follow G1–G3.

**Conformance fixtures** (planned): a directory of golden stores — sealed, live,
in-flight (orphan-ahead), corrupt-pointer, corrupt-head, quarantined-envelope — plus a
verifier script, so any implementation can be tested against the same artifacts.

## 14. Open Issues in Format v1

- **O1 — Catalog root nesting.** The Node implementation roots the catalog at
  `<storeDir>/data/catalog/` (first-consumer heritage).
  The format is defined from the catalog root, but the discovery rule ("where is the
  catalog root inside a store dir?") should be either flattened or made explicit before
  publish.
- **O2 — Windows rename-replace.** F5c and P2 require POSIX rename-over-existing
  semantics; Win32 `rename` fails on an existing target.
  A Windows implementation needs `ReplaceFile`/`MoveFileEx(MOVEFILE_REPLACE_EXISTING)`
  semantics. The cross-platform CI matrix gates the claim.
- **O3 — Envelope durability option.** §10 makes accepted-but-unpublished writes
  non-durable across power loss by design.
  An opt-in “fsync envelopes” mode (payload and dir) would harden the accepted state for
  callers that need it.
- **O4 — GC retain phrasing.** G1 keeps `retain + 1` snapshots (current plus `retain`
  predecessors). Earlier prose saying “the most recent `retain`” was ambiguous; G1 is the
  normative statement.
- **O5 — Clock skew and mtime staleness.** Lock staleness (L2), lease staleness (RL2),
  and transient staleness (G3) all compare a *local* clock against an mtime that may
  have been set by another host.
  Correctness never depends on these (L5), but liveness tuning on skewed clusters is
  undocumented; the planned real-NFS gate and protocol model both probe this.
- **O6 — `base_version` is unused.** Manifests record the seed base, but reconcile
  intentionally ignores it (cross-version merge is policy-resolved).
  Either document it as provenance-only (this spec does) or define semantics (e.g.
  staleness warnings) in a future version.

## 15. References

- The build plan and design rationale:
  [`plan-2026-06-06-fsqlite-standalone-sqlite-package.md`](fsqlite-design.md)
- Source-pinned binding findings:
  [`upstream-source-confirmations.md`](../upstream-source-confirmations.md)
- Test-to-guarantee map and manual QA: [`qa-runbook.md`](qa-runbook.md)
- SQLite session extension: https://sqlite.org/sessionintro.html · `VACUUM INTO`:
  https://sqlite.org/lang_vacuum.html

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
