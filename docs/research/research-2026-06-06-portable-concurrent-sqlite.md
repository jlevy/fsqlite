---
title: Portable, Server-Free, Concurrent SQLite for Local Applications
description: A domain-agnostic reference on building a locally-friendly, portable,
  thread-safe, shared-filesystem-oriented, data-loss-safe usage pattern around
  SQLite: covering the locking/journaling/filesystem background, the session/changeset
  extension, source-grounded node:sqlite findings, the prior-art landscape, and a
  validated snapshot-publish and transaction-envelope design with a reference implementation.
author: Joshua Levy, with LLM assistance
related:
  - ../fsqlite-design.md
  - ../fsql-format-spec.md
---
# Research: Portable, Server-Free, Concurrent SQLite for Local Applications

**Date:** 2026-06-06 (last updated 2026-08-01)

**Author:** Joshua Levy, with LLM assistance

**Status:** Complete as background research.
The current implementation and `f1.0` decisions are governed by the
[`fsqlite` design](../fsqlite-design.md), the normative
[`fsql-format-spec.md`](../fsql-format-spec.md), and the
[`QA runbook`](../qa-runbook.md).
This report preserves the evidence and alternatives; it does not override those current
documents. The focused
[schema and workload assessment](research-2026-08-01-schema-evolution-and-workload-fit.md)
contains the current ordinary-SQLite comparison, schema-maintenance procedure,
measurements, severity, and adoption boundary.

## Overview

A domain-agnostic reference that asks:

> How can a **SQLite database** support safe, convenient **concurrent** use from **local
> applications**, with **no database server**, on local storage and capability-validated
> shared filesystems, while keeping the file a **portable, durable, tool-compatible
> artifact**, never damaging a previously published state, and making any unpublished
> loss boundary explicit?

NFS and SMB are targets that require mount-specific evidence.
Consumer synchronization folders have a different replication model and are not assumed
to satisfy the protocol.

SQLite is a strong archival and interchange format: a single public-domain file readable
by nearly every language and tool.
But its built-in concurrency story (one writer at a time; WAL needing shared memory;
`fcntl`/`flock` locks unreliable on network mounts) is a poor fit for “many local agents
and processes write one file, sometimes on a network drive, with no daemon.”
The gap between *“great file format”* and *“safe concurrent local access with no
server”* motivates this research.
It ends with a concrete, test-validated design for closing it: **`fsqlite`**
(Filesystem-Friendly SQLite), delivered as **two things**: a language-independent
**format and commit protocol** over ordinary SQLite files (the primary, durable
artifact), and a **Node reference implementation** (library and CLI) that serves as its
first proving ground.

Ordinary local SQLite remains the simpler and more efficient default when writers can
take turns on one reliable local filesystem.
The design below is justified only when independent file-native capture and immutable
publication solve a requirement that ordinary SQLite does not.

`fsqlite` supports **many concurrent writer captures without letting two of them touch
one *live* SQLite file.** Each writer records its change as its own uniquely-named
changeset *file*; published snapshots are **immutable**; the only serialized step is an
out-of-band merge. Capture remains bounded by snapshot-copy bandwidth, transient disk
capacity, write rate, and the serialized publication step.
So the familiar maxim *“one SQLite file means one writer”* is true and **left
untouched** here: the protocol never shares a live file.
The flip side, equally important and stated up front: those guarantees hold **only for
cooperative writers** that go through the protocol; a rogue process writing directly
into the store can still corrupt it, as it could corrupt any SQLite file.
Readers, by contrast, need nothing: they open the standard published snapshot with any
tool, in any language.

The use cases are deliberately generic: durable local agent state, local data tools,
offline-first caches, content-addressed metadata catalogs, build/CI artifacts,
“zip-and-go” datasets.
(A multi-writer document catalog is *one* such consumer, but nothing here is specific to
it; the design takes a caller-supplied schema and merge policy and knows nothing about
the domain.)

The design was validated with a dependency-free `node:sqlite` implementation and
source-level review of SQLite, Node, alternative bindings, and filesystem-locking prior
art. Current test counts and validation status live in the QA runbook so they have one
maintained source.

## What Kind of Artifact This Is

The deliverable is **a storage format and commit protocol: conventions over standard
SQLite files, with per-language reference libraries.** It is neither a wrapper nor a new
engine. Concretely, the durable core is (a) an on-disk **layout** (immutable versioned
snapshots, a `current` pointer, changeset transaction envelopes, an `applied_tx` ledger,
and a `mkdir` lease) and (b) the **protocol** for writing, reconciling, and reading it.
The library code is one *implementation* of that protocol, not the thing itself.
The closest precedents are **Apache Iceberg and Delta Lake**: table formats and commit
protocols layered over Parquet files, with multiple engine implementations: nobody calls
them “Parquet wrappers.”
This is the same shape, over SQLite.

Why the alternative framings mislead:

- **“A wrapper around SQLite”** undersells *and* misdescribes it.
  A wrapper implies intercepting or replacing the SQLite API (a custom VFS, or a drop-in
  connection object). This design never touches the SQL surface: you still query with
  plain SQLite: it **orchestrates files around** SQLite.
  It is an overlay/coordination layer, not an API wrapper.
- **“A complete repackaging as a file-based database that uses SQLite”** oversells it.
  There is no new query language and no new file format; the published snapshots *are*
  ordinary SQLite. To a consumer it *behaves* like a small embeddable multi-writer
  database, but it is not a new engine.
- **“A set of formats and conventions”** is the **core truth**: that is the durable,
  standardize-and-version deliverable; the libraries follow from it.

**Is it Node-specific?
No.** The **format and reader path are language-independent**: a reader opens the
standard SQLite file named by `current` without special support in any language or tool.
Even the writer’s changeset envelope is a SQLite-defined binary blob that any
*session-capable* binding can produce or consume.
Only the **writer/reconcile** role needs such a binding: Node `node:sqlite` is the
natural **first reference implementation** (it ships sessions with zero native deps;
Finding G2), with Python (APSW) and Rust (`rusqlite`) able to implement the *same*
format later. The format and reader path are language-independent, with writer libraries
wherever a session-capable binding exists and Node as the first implementation.

The practical consequence for the rest of this document: the **format/protocol is the
primary artifact**. Its root `fsqlite.json`, `f1.0` version, fixed fsqlite
`application_id`, caller-owned `user_version`, manifest schema, and reconcile/conflict
rules are what must be precise, stable, and versioned.
Any package in any language is a reference implementation of it.

## SQLite Sessions: A Mature but Underused Primitive

Almost every approach in this document leans on one specific SQLite feature: the
**session/changeset extension**. It is worth explaining what it is, why you have
probably never used it, and why it is the key that makes the rest possible.
(The mechanism in detail is Finding F; this is the orientation.)

**What it is.** The session extension lets a connection *record* the exact row-level
changes (`INSERT`/`UPDATE`/`DELETE`) made during a unit of work and serialize them into
a **changeset**: an ordinary binary blob you can write to a file.
A changeset can later be **applied** to another database, with a per-change **conflict
handler** deciding `OMIT`/`REPLACE`/`ABORT`. In effect it is **logical, row-level
replication built into SQLite**, where the unit of replication is just a file.

**History.** The extension has been in SQLite since **version 3.13.0 (2016)**: it is not
new or experimental at the engine level; it is a decade-old, stable part of the codebase
maintained by the core SQLite team, with a documented C API
([sessionintro](https://sqlite.org/sessionintro.html)) and an accompanying **rebaser**
(for merging divergent changesets) and **changegroup** (for concatenating them).
It was built for the natural “session” use case: capture what changed here, carry it
elsewhere, merge it: i.e. database sync.

**Why you have probably never used it.** It is **disabled by default**. The feature only
compiles in when SQLite is built with
`-DSQLITE_ENABLE_SESSION -DSQLITE_ENABLE_PREUPDATE_HOOK`, and most distributions and
bindings ship without those flags, as confirmed by the source review: **macOS system
SQLite, the default `better-sqlite3` build (`deps/defines.gypi`), Python’s stdlib
`sqlite3`, and Go’s `mattn/go-sqlite3`** all omit it.
So for years the feature was *present in the amalgamation but invisible at the
application layer*. Compounding this, the famous “distributed SQLite” projects chose
**other** mechanisms: LiteFS and Litestream replicate the **WAL byte stream**; rqlite
and dqlite use **Raft over SQL statements**. The changeset (logical, row-level) lane
stayed in the **mobile / offline-first sync** corner (e.g. `SQLiteChangesetSync`,
`sqlite-sync`, Tencent WCDB, Bloomberg comdb2), out of the server-infrastructure
conversation. The net effect: a powerful, mature primitive that very few people reach
for.

**Why it is newly relevant.** Its visibility is rising because a first-class runtime
finally exposes it by default: **Node’s built-in `node:sqlite` ships with SESSION
compiled in** (confirmed: `node/deps/sqlite/sqlite.gyp:24,27`), and **Python’s APSW**
and **Rust’s `rusqlite` (`session` feature)** expose it too.
That matters here because a changeset is the file-native, server-free, optimistic
commit-log this problem needs: writers each emit a uniquely-named changeset **file**
(free of shared-path contention when the target filesystem provides the required create
and visibility semantics), a merge step folds them with a domain conflict policy, and,
the key property, **readers never need the extension at all**, since they just open the
resulting standard SQLite file.
In other words, the primitive that makes concurrent, server-free, per-session optimistic
SQLite tractable has been sitting in the engine for ~10 years; what changed is that it
is finally reachable from a zero-dependency local runtime.
The rest of this document is, in large part, an argument that this underused primitive
is a suitable foundation, subject to the binding-level limits in Findings G and G2.

## Requirements

The target properties (the “contours”), restated as testable requirements:

- **R-FORMAT: durable, portable, tool-compatible archival format.** The at-rest artifact
  is a standard SQLite file (or a directory of plain files and standard SQLite files)
  that any SQLite tool/binding/language can open, today and in years.
  No engine-specific or proprietary container as the interchange surface.
- **R-LOCAL: direct local access via in-process APIs.** First-class **Node**, with a
  path to **Python** and **Rust** (and the `sqlite3` CLI) for at least the *reader*
  role. No network client required to read or write.
- **R-XPLAT: cross-platform.** macOS, Linux, Windows; common CPU architectures.
- **R-NOSERVER: no traditional server/daemon.** Any process just opens files.
  A *minimal, ephemeral, auto-managed* coordinator is acceptable only as an optional
  optimization, never required: cross-platform daemon lifecycle management is itself a
  liability.
- **R-FS: capability-defined rather than filesystem-label-defined.** Target local and
  shared filesystems where the required atomic create, rename, visibility, and
  durability primitives are validated.
  NFS, SMB, FUSE, and synchronization products require separate evidence; a product name
  alone proves nothing.
- **R-DURABLE: bounded loss and safe snapshot backup.** A crash or interrupted protocol
  operation loses at most the current unpublished tail: never a previously committed
  state, never the whole dataset.
  A published immutable snapshot can be pinned and copied safely.
  Arbitrary recursive copying of a live directory is not a required guarantee.
  A **repair** path exists for protocol anomalies and interrupted operations.
- **R-CONCURRENCY: wrapper-managed, session/optimistic, not one-big-lock.** A thin
  wrapper API may manage concurrency, but the goal is **optimistic,
  session-/transaction-grained** concurrency (worst-case loss = one session), not a
  single coarse whole-DB mutex held across work.
- **R-THREAD: thread-safe in-process, not just cross-process.** The reference bindings
  build SQLite in **multi-thread** mode (`SQLITE_THREADSAFE=2`: `better-sqlite3`
  `deps/defines.gypi:38`; `node:sqlite` opens without `FULLMUTEX`/`NOMUTEX` and confines
  a connection to its creating thread), which guarantees safety *only* when no single
  connection (or object derived from it) is used by two threads at once.
  So a connection is **never shared across Worker Threads**: one connection per thread.
  The reference implementation opens fresh connections for operations and does not
  provide a process-local mutex.
  Its filesystem protocol coordinates processes at a shared store root; an explicit
  Worker Thread coordination contract and tests remain on the roadmap.
  (Finding G2.)

**Requirement review.** These are sound and mutually achievable, with three notes:

1. **R-CONCURRENCY “optimistic, per-session” and R-NOSERVER together force a
   commit-log/MVCC-style design, not a lock-wrapper.** A pure wrapper-lock (even a good
   one) is still one-writer-at-a-time; true per-session optimism on a single file with
   no server is achieved by **logical row-level changesets merged optimistically**, not
   by finer file locks (see Findings B). Here, “wrapper-based locking” means
   “wrapper-managed *concurrency*,” implemented as a changeset commit-log.
2. **R-FS and R-CONCURRENCY mean the live multi-writer working directory is a *directory
   of files*, even though the archival artifact is a *single* SQLite file.** These are
   not in tension: the live form has a tail of pending change-files that a finalize/seal
   step folds into one clean file.
   Worth stating explicitly as part of R-FORMAT.
3. **Add R-DETECT: no silent corruption.** Implied by R-DURABLE but worth elevating:
   every inconsistency (torn copy, partial write, bit-rot, dangling reference) must be
   *detectable and surfaced loudly*, not silently accepted.
   Content hashing, integrity checks, and structural “in-flight tells” make this cheap.

## Questions to Answer

1. Is SQLite the right at-rest format, and what makes a SQLite file portable/archival?
2. What *exactly* breaks when you use SQLite concurrently, and on NFS/SMB/sync folders?
3. Why is there “no magic file lock,” and what does that imply for the design?
4. What does the existing landscape (LiteFS, rqlite, dqlite, mvSQLite, Litestream,
   libSQL/Turso, CRDT layers, mobile sync) actually do, and what’s the gap?
5. How does SQLite’s **session/changeset** extension work, and is it the right
   primitive?
6. What are the concrete **binding** constraints (Node `node:sqlite` vs `better-sqlite3`
   vs `bun:sqlite`; Python; Rust)?
7. What design satisfies all the requirements, and does the reference implementation
   validate it?

## Scope

**In scope:** in-process/local concurrent access to a single logical SQLite store with
no required server; locking/journaling/filesystem behavior; the session/changeset
extension; the snapshot/commit-log pattern; crash safety and immutable-snapshot backup;
cross-language reader portability; a generic format, protocol, and implementation.

**Out of scope:** analytical/columnar engines (DuckDB/Parquet) and full-text/vector
search; choosing a specific application schema; remote sync/replication and
object-storage transport (a separable layer); and any single application’s domain model.

## Findings

### A. SQLite is the right at-rest format; what makes it portable

SQLite is the strongest *database* archival format in wide use: a single file, **public
domain**, a documented and decades-stable on-disk format, a **US Library of Congress
recommended storage format**, and readable by ubiquitous tooling (`sqlite3` CLI,
Datasette, every major language’s stdlib or a maintained binding).
It also bundles FTS5 and JSON1, so metadata, key/value (a trivial
`kv(key PRIMARY KEY, value)` table), and lexical search can live in one inspectable
file. The on-disk format is cross-platform and endianness-independent.

Portability is mostly a discipline, not luck:

- Store **store-relative, slash-separated UTF-8 paths** in any path columns; never
  absolute or platform-specific paths.
- Keep the **authoritative tables on core SQLite features only.** FTS5 is broadly
  available; loadable extensions (e.g. `sqlite-vec`’s `vec0` virtual table), custom
  collations, and compile-time options are **not** guaranteed.
  A database that *embeds* a `vec0` table is no longer openable by a stock reader
  (touching the table throws `no such module: vec0`). Vectors/large indexes belong in
  *separate, rebuildable* files.
- macOS system SQLite ships `SQLITE_OMIT_LOAD_EXTENSION`, so never *assume* extension
  loading: probe it.
- A **packaged/sealed** file must be finalized (no `-wal`/`-shm` side files) via
  checkpoint, the backup API, or `VACUUM INTO`, and pass `PRAGMA integrity_check`.
- Stamp the fixed fsqlite `PRAGMA application_id = 0x4653514C` and the caller-owned
  `PRAGMA user_version` so foreign readers can recognize the file and version-gate the
  caller schema.

**Conclusion:** keep the *content/bytes* and the *interchange artifact* as standard
SQLite (and plain files for large blobs); never hand an outside consumer an
engine-specific KV store (LMDB/RocksDB/redb): those are fine only as a rebuildable local
cache.

### B. “Locking” is three different things; the fine-grained part is never the filesystem

Most confusion comes from one word spanning three independent layers:

1. **File/OS ownership**: *which process may write the file*: `flock` / `fcntl` /
   `LockFileEx` / `mkdir` / dotfile.
   Coarse, whole-file.
2. **In-engine concurrency control**: *how concurrent transactions isolate*: MVCC,
   two-phase locking, a lock manager with table/page/row granularity.
   This is the “per-row / per-section” part.
3. **Durability / commit**: WAL / rollback journal.

The key realization: **layer 2, the fine-grained part, is an in-memory data structure
owned by one process.
It is not, and never has been, a filesystem feature.** No database does per-row locking
by taking a filesystem lock per row.
Every engine that allows concurrent local writers uses a **shared-memory lock table**
(Postgres' lock table in shared memory; InnoDB’s in the buffer pool; Berkeley DB’s lock
subsystem in a shared-memory environment; LMDB’s reader table and write mutex in
`lock.mdb`; SQLite’s WAL-index in `-shm`). Shared memory is **same-host only**: it does
not cross machines.

This yields **the cross-host theorem:** fine-grained locking requires a per-lock
acquisition; across hosts “acquire lock” is a network round-trip, and a service that
answers network lock requests *is a database server*. Therefore **you cannot have
fine-grained, cross-host locking without a server.** Across hosts you stop *holding*
locks and turn the lock into a **commit**: an atomic-create lease to elect a writer or a
compare-and-swap pointer update to commit a change.
The commit primitive is held for milliseconds, not throughout the work.

Better-than-`flock` *local* primitives exist (mmap atomic-CAS slots; Linux robust
futexes/mutexes with `EOWNERDEAD` recovery; Windows named mutexes with `WAIT_ABANDONED`;
OFD byte-range locks `F_OFD_SETLK`) but they all inherit the network wall, and robust
mutexes have a **macOS gap** (historically unimplemented), so a *portable* shared-memory
locker can’t rely on them.
The consequence for these requirements is to place serialization at a millisecond-scale
commit or election. Idempotency, not lock perfection, establishes the safety property.

**The coordination triangle.** Where the cross-host theorem says fine-grained cross-host
locking needs a server, the triangle frames the design choice that follows.
You can have at most **two** of:

1. **Direct file access:** clients open the SQLite files directly, with no server or
   broker.
2. **Strong coordinated writes on weak/shared filesystems:** concurrent participants
   cannot double-write, skip the commit protocol, or depend on WAL/`-shm`/`fcntl` the
   filesystem does not provide.
3. **Arbitrary, unmodified writers:** any SQLite-capable process can write the live file
   without knowing the protocol.

A server-free design keeps (1) and (2) and **gives up (3)**, which is exactly the
cooperative-writer boundary stated in the Overview: all writers must use the protocol;
readers need nothing.
This is not the CAP theorem and makes no consensus claim; it is a statement about
**where enforcement lives**. The one nuance versus a plain cooperative lock, which also
surrenders vertex 3, is that the changeset commit-log buys more of vertex 2: many
lock-free row-level writers rather than one writer at a time.

### C. SQLite’s own locking and journaling, precisely

- **Default (rollback journal) mode** uses `fcntl` **byte-range locks** at fixed offsets
  ("lock bytes") and a `-journal` file for crash atomicity.
  One writer at a time; readers blocked during the brief write commit.
- **WAL mode** adds a `-wal` file and a **`-shm` shared-memory wal-index**, giving
  concurrent readers and one writer with much less blocking.
  Per SQLite’s own WAL docs, the **`-shm` wal-index does not work on a network
  filesystem**, so **WAL is local-disk-only**.
- **`busy_timeout`, `BEGIN IMMEDIATE`, and retry** let multiple *local* processes write
  one WAL DB safely with brief contention.
  On local disk, this usually works with brief contention.
- **URI flags:** `nolock=1` disables SQLite’s file locking entirely (safe only when
  *you* guarantee a single writer / own an external mutex); `immutable=1` opens a file
  promised not to change (fast, safe reads of a finalized snapshot).
- **Never treat copying an open `.db` as a backup.** Use the **online backup API**
  (`src/backup.c`), **`VACUUM INTO`**, or **`sqlite3_rsync`** (the official remote-copy
  tool, **first shipped in SQLite 3.47.0**, 2024-10-21; it opens a read transaction so
  the replica is a *consistent snapshot* of a *live* origin; 3.50.0+ drops the
  WAL/page-size match requirement and is more bandwidth-efficient for small diffs), then
  `integrity_check`/`quick_check`. A naive `cp`/`rsync`/`tar`/sync of a live WAL DB can
  capture a torn page state and is oblivious to `-wal`/`-shm`: the exact reason
  replication tools (Litestream) exist instead of file copy.

> **Backup is a contract, not a hope.** The reference implementation exposes
> `backup()`/`vacuumInto()`/`copyUnderLock()` and **never** documents “copy the live
> `.sqlite` and hope.”
> Every backup helper runs `PRAGMA integrity_check` in tests.
> A pinned immutable fsqlite snapshot is safe to copy while publication continues, but
> the sanctioned backup surface still matters for retention, the `DirectStore` floor,
> and sealing. (Review B2; Finding R6 detail.)

**SQLite-native VFS / locking options: adopt or dismiss.** SQLite already ships several
locking strategies; the cross-host theorem (Finding B) says none of the “cleverer” ones
buys us anything, so we **decline** them deliberately rather than from ignorance:

| Option (`src/os_unix.c`, `uri.html`) | Verdict | Why |
| --- | --- | --- |
| `unix` posix advisory locks (default VFS) | **Adopt** | Standard, robust per-process advisory locks; the basis of our cross-process lock. |
| `immutable=1` URI | **Adopt (readers)** | Declares the file (and `-wal`/`-shm`) cannot change → skips all locking; ideal for sealed read-only snapshots. (Needs URI enabled: not the `better-sqlite3` default; see G2.) |
| `nolock=1` URI | **Conditional** | Disables file locking entirely; safe **only** under our own exclusive protocol (sealed/single-writer), never for shared live access. |
| `unix-dotfile` (a lock *directory*) | **Dismiss** | Coarse, stale-lock hazards, zero concurrency; no advantage over our explicit `mkdir` lease. |
| `unix-flock` | **Dismiss** | `flock()` is per-open-file-description, unreliable on NFS, and build-gated (`SQLITE_ENABLE_LOCKING_STYLE`, off in `better-sqlite3`). |
| `unix-excl` | **Dismiss** | Holds locks for the connection’s whole life; conflicts with our copy/reconcile windows. |
| Apple `afp`/`nfs`/proxy locking | **Dismiss** | Apple-network-FS specific; gated off in stock builds; single-host-at-a-time (Finding D). |
| Shared-cache mode | **Dismiss** | SQLite calls it obsolete; connection-scoped; still one write transaction per cache; `SQLITE_OMIT_SHARED_CACHE` is set in `better-sqlite3`. |

### D. Why NFS/SMB/FUSE/sync folders break SQLite: a proven pitfall

Two layers fail on network/sync storage.
First, **WAL is unsupported on a network filesystem because the `-shm` wal-index is
shared *memory***: SQLite’s own source is explicit (“all users of the database must be
able to share memory”; `src/wal.c:129-133`). The precise failure is a
**cache-coherency** one, not data loss: the `-shm` file is rebuildable by rescanning the
WAL, but multiple hosts cannot share a coherent view of it, and NFS/AFP only offer
*close-to-open* coherency, which `src/os_unix.c:7298-7312` notes “does not effectively
[satisfy] concurrent database access by multiple readers and writers.”
Second, **`fcntl`/`flock` byte-range locks are unreliable** on network mounts
(`src/os_unix.c:1191` calls POSIX advisory locks “broken by design”; `flock`-on-NFS is
notably flaky on macOS, and `O_EXCL` over NFS has a documented race: see
[LWN](https://lwn.net/Articles/251004/) and `open(2)`). Consumer cloud-sync folders
(Dropbox, iCloud Drive, OneDrive, Google Drive) can be particularly hazardous: the sync
client copies the `.sqlite` mid-write and ignores `-wal`/`-shm`, corrupting it (concrete
reports on the SQLite and mORMot forums).
The one-line authority for the *fix*: NFSv4 specifies an atomic exclusive create (the
`EXCLUSIVE4` verifier) and atomic `RENAME`
([RFC 7530](https://datatracker.ietf.org/doc/html/rfc7530) /
[RFC 8881](https://www.rfc-editor.org/info/rfc8881/)), which is why the design leans on
`mkdir`/`rename` and not on byte-range locks (and treats lease *staleness* as
[Kleppmann](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)
warns: a heuristic, not a true fencing token; see G2).

The primitives used across local disk and NFS are **atomic directory creation**
(`mkdir(2)`) and **atomic rename**. The Git and npm ecosystems use `mkdir` lock
directories rather than `flock`; this design uses the same primitives.

### E. The prior-art landscape and the gap

Existing “distributed/concurrent SQLite” efforts cluster into a few shapes, none of
which is a thin, packaged, portable wrapper for the local, NFS, no-server case:

| Project / approach | What it is | Where it sits |
| --- | --- | --- |
| **WAL with `busy_timeout` and retry** | SQLite’s built-in local concurrency | local-disk only; no NFS; one writer |
| **libSQL `BEGIN CONCURRENT`** | **page-level** OCC multi-writer, still a SQLite file | same `-shm` limit; experimental; local-disk only |
| **Turso / limbo** (Rust rewrite) | **row-level MVCC** (`journal_mode=mvcc`), in-memory version index | beta (v0.5.0); in-process/local; a new engine, not a SQLite-file format |
| **LiteFS** (Fly.io) | FUSE FS replicating SQLite; **lease-based single primary** | ephemeral elected coordinator (a server, productized) |
| **rqlite / dqlite** | HTTP/Raft (rqlite) or embeddable C Raft (dqlite) over SQLite | long-lived consensus server |
| **mvSQLite** | SQLite storage swapped onto FoundationDB; distributed MVCC | replace the storage layer (a cluster) |
| **Litestream** | single local writer and streaming WAL replication to object store | durability/replication, not concurrency |
| **cr-sqlite (Vlcn)** | CRDT loadable extension on SQLite | slowed since ~2024-10; a merge layer (reader needs the extension), not a store |
| **Mobile changeset sync** (`SQLiteChangesetSync`, `sqlite-sync`, WCDB) | offline-first device sync via the session extension | closest analogue, but app/device-specific and without conflict resolution |
| **DIY `proper-lockfile` and write queue** | a generic cross-process lock around a SQLite file | the thin end; folk knowledge, not a marquee package |

The serious multi-node efforts all **centralize the writer** (LiteFS lease,
rqlite/dqlite Raft) or **replace the storage layer** (mvSQLite).
The thin “external lock around a shared/NFS SQLite file” is **DIY folk knowledge: there
is no marquee packaged library**, partly because the SQLite project actively discourages
SQLite-on-NFS. The file-native row-level mechanism (the **session/changeset extension**)
lived in the mobile-offline-sync corner, out of the “distributed SQLite” spotlight,
because it was compile-time-disabled in most builds: until `node:sqlite` exposed it
first-class.

**The gap:** a small, dependency-light, cross-platform package that gives optimistic,
session-grained, no-server concurrency designed for shared-filesystem primitives, with
safe immutable-snapshot backup and a standard SQLite artifact.
That is the thing worth building.

### F. The SQLite session / changeset extension: the file-native primitive

The session extension (in SQLite since 3.13.0, behind
`-DSQLITE_ENABLE_SESSION -DSQLITE_ENABLE_PREUPDATE_HOOK`) records the row changes a
connection makes and packages them into a **changeset** (or smaller **patchset**): a
binary blob that can be stored as a file.

- `sqlite3session_create` and `sqlite3session_attach(NULL)` → record all tables.
- run normal `INSERT`/`UPDATE`/`DELETE`.
- `sqlite3session_changeset` → extract the changes as a blob.
- `sqlite3changeset_apply(target, blob, xFilter, xConflict, …)` → apply to another DB,
  with a **filter** (per-table include/exclude) and a **conflict handler** returning
  `OMIT` / `REPLACE` / `ABORT` per change.
- `sqlite3changegroup` / `changeset_concat` combine; `changeset_invert` undoes; the
  **rebaser** (`sqlite3rebaser_*`, EXPERIMENTAL) rebases one writer’s changeset onto
  another’s already-resolved conflicts.

**Conflict types** the handler sees: `DATA` (target row changed out from under the
writer), `NOTFOUND` (no row with that PK), `CONFLICT` (PK/UNIQUE violation on insert),
`CONSTRAINT`, `FOREIGN_KEY`. This is where merge policy lives (e.g. cache = last-writer-
wins by timestamp; edges = set-union; events = append).

**Changeset vs patchset:** a *changeset* carries old and new values, so it can detect
**DATA conflicts**; a *patchset* is smaller (PK and new values) but cannot.
**Measured** (update 1 of 4 columns × 500 rows): changeset 15009 B vs patchset 10009 B
(~33% smaller). For a metadata store where big bytes live as files (so changesets are
already small), the conflict detection is worth more than the size: **use changesets**.

**Documented limitations, and why they fit a clean design:**

- **Every table needs a non-null `PRIMARY KEY`**: rows with NULL PK are silently
  ignored. (So: declare explicit PKs everywhere.)
- **Virtual tables are not captured** (FTS5/`sqlite-vec`). (So: those are rebuildable
  projections, excluded from the merge and rebuilt after: exactly where they belong.)
- **DDL/schema changes are not captured.** (So: migrations are a separate deterministic
  step; all writers must share a schema version.)
- **Big values are embedded in the changeset.** (So: keep large bytes as files; catalog
  rows stay small and so do changesets.)
- **One narrow PK-less exception:** `sqlite_stat1` is captured specially even though it
  has no declared PK (since SQLite 3.22, `ext/session/sqlite3session.h:207-235`). This
  is relevant only if you `ANALYZE`; user tables still need explicit non-null PKs.

**Changeset blob portability (strong evidence, but not an explicit guarantee).** The
design’s multi-language story assumes a changeset written by one binding applies under
another (and across SQLite versions).
No SQLite doc *states* the blob is endian-/version- stable, but the evidence is strong
and convergent: the documented Alice→Bob “carry a changeset to another machine”
workflow; the in-header legacy-compatibility handling (patchsets require up-to-date
`sqlite3changeset_*` and old versions provoke `SQLITE_CORRUPT`; the `sqlite_stat1`
encoding exists so “changesets can be manipulated by legacy implementations,”
`sqlite3session.h:217-235`); and `sqlite3changeset_apply` accepting a target with a
*superset* of columns (`:1146-1155`). This is inference, not a quoted promise.
A cross-version, cross-binding round-trip test gates the interoperability claim before
it is treated as settled.

**Binding availability (the practical crux):** because a changeset is just a file,
**readers never need the extension**: they open the SQLite file normally with any
binding. Only the *writer* (to record) and the *merge step* (to apply) need it.
The cross-language **writer-parity matrix** is in the next sub-section.

#### F1. Cross-language session writer-parity matrix

Source-verified at the commits recorded in [Source Map](#source-map).
Columns: does the build compile SESSION in by default; does it expose a
changeset/patchset API; does its apply **conflict handler expose the table name** (via
the changeset iterator: the capability `node:sqlite` lacks); does it expose the
**rebaser**.

| Binding / runtime | SESSION by default | Changeset API | Table name in conflict handler | Rebaser | Notes |
| --- | --- | --- | --- | --- | --- |
| **`node:sqlite`** (Node ≥ 22.5) | ✓ | ✓ | ✗ (only the integer type) | ✗ | The first-class zero-native-dep host; constraints are the binding’s, not SQLite’s (Finding G). |
| **Bun 1.3.13** (`node:sqlite`) | ✗ | ✗ | , | , | Cannot resolve `node:sqlite`; not a writer runtime for this release. |
| **Deno** (`node:sqlite`, ≥ 2.2) | ✓ | ✓ | ✗ | ✗ | Same surface and limits as Node. |
| **`better-sqlite3`** | ✗ | ✗ | , | , | SESSION `#if`-compiled-out; usable only as a **reader** / `DirectStore` writer. |
| **APSW** (Python) | ✓ | ✓ | **✓** | **✓** | Fullest surface: table name *and* a `Rebaser` class. |
| **`sqlite-wasm`** (official) | ✓ | ✓ | **✓** | **✓** | Raw C session API compiled in; a browser-side writer is feasible. |
| **`rusqlite`** (Rust, `session`) | ✓ (bundled) | ✓ | **✓** (`Operation::table_name`) | ✗ (raw FFI only) | Richer than Node, but no *safe* rebaser. |
| **`zombiezen.com/go/sqlite`** | ✓ | ✓ | **✓** | ✗ | Go *can* host the writer, with table name; no rebaser. |
| Python stdlib `sqlite3`, `mattn/go-sqlite3`, `sqlite-jdbc`, .NET `e_sqlite3` | ✗ | ✗ | , | , | SESSION not compiled in; readers only without a custom build. |

So a **richer** writer (in-handler per-table policy) is achievable in Python/Rust/Go
today, and a **rebaser-capable** writer is APSW/wasm-only.
`node:sqlite` on Node and Deno gives the zero-dependency convenience but neither the
table name nor the rebaser.
Node is the reference and test runtime; the package does not claim Bun compatibility.
These limits shape `f1.0` (filter-pass-per-policy; constrained writable surface so no
rebaser is needed). The full ecosystem context: who uses sessions at all versus the
WAL/Raft/CRDT/MVCC workarounds: is in [Related Work](#related-work).

### G. Source-grounded `node:sqlite` findings (the binding, not SQLite, is the limit)

Verified empirically and confirmed against checkouts of `sqlite/sqlite` (`002d33d`,
`ext/session/sqlite3session.h`) and `nodejs/node` @ `v22.22.2` (`src/node_sqlite.cc`):

1. **`node:sqlite`’s conflict handler receives only the integer conflict type: not the
   table name or row values.** The C `xConflict(pCtx, eConflict, pIter)` has the
   iterator `pIter` (from which `sqlite3changeset_op` yields the table name), but the
   binding passes JS only `eConflict` (`node_sqlite.cc`: `conflictCallback(eConflict)`).
   So **per-table policy cannot be routed inside the conflict handler**: you must use
   the `applyChangeset` **`filter(tableName)`** callback, which *does* receive the table
   name, running one filtered apply pass per policy action.
   *(This is a binding limitation; an upstream feature request to forward the
   iterator/table name is the clean fix.)*
2. **`SQLITE_CHANGESET_ABORT` works and `node:sqlite` signals it as a `false` return
   value, not a throw.** Per the C docs, ABORT “rolls back any changes applied so far
   and returns `SQLITE_ABORT`”; the binding maps that to `applyChangeset(...) === false`
   (`node_sqlite.cc`: “this is not an error, return false”). Verified: a two-insert
   changeset where one row conflicts, under ABORT, returns `false` and rolls back
   **both**; under OMIT, returns `true` and keeps the non-conflicting row.
   So a strict/quarantine policy is detected by the boolean, then the whole transaction
   is rolled back.
3. **`REPLACE` is only legal for `DATA`/`CONFLICT` conflicts**: returning it for
   `NOTFOUND`/`CONSTRAINT`/`FOREIGN_KEY` is `SQLITE_MISUSE` (a throw).
   So last-writer-wins must be **conflict-type-aware** (REPLACE on DATA/CONFLICT, OMIT
   otherwise). (A latent bug caught by reading the header; covered by a NOTFOUND test.)
4. **No `sqlite3_rebaser` in the binding** (the C API has it; `node_sqlite.cc` does not
   expose it). So a v1 design must avoid *needing* a rebaser.
5. **The session API works on the repo’s Node v22 baseline** (v22.22.2), and
   **`node:sqlite` is not flag-gated**: `--experimental-sqlite` was removed in
   **v22.13.0 / v23.4.0** (so even the v22.22.2 baseline is past it), and the module is
   **Stability 1.2 (Release candidate)** as of v25.7.0 and in current docs (it still
   prints an `ExperimentalWarning`). A *conservative* public release should still gate
   on it reaching Stable, but it is not behind a flag.

The package has a higher load-time floor than the session API alone: Node’s static
`backup` named export was added in v22.16.0 and v23.8.0. Because fsqlite imports it at
ESM link time, older releases cannot load the package and no runtime capability guard
can intercept the failure.
The alpha declares `>=22.18.0 <23 || >=24.0.0`; 22.18 is also the unflagged TypeScript
type-stripping floor used by the source test loop.

> **Re-verified against current Node.** All five constraints above hold on `nodejs/node`
> `main` (v27-pre): the conflict handler drops the iterator, ABORT is `false`, `REPLACE`
> is DATA/CONFLICT-only, and there is no rebaser.
> Deno (≥ 2.2) exposes the same `node:sqlite` surface; Bun 1.3.13 cannot resolve the
> module and is not a supported runtime.
> One caveat to track: Node issue **#63180** (a segfault when `db.close()` is called
> from inside a user-defined-function callback) reproduces on our v22.22.2 baseline;
> `fsqlite`’s hot path uses no UDFs, but confirm before adding any.
> The two clean upstream fixes: forward the changeset iterator/table name into the
> conflict handler, and expose the rebaser: remain **un-filed** and are tracked as
> research follow-ups.

All five are pinned to C source in
[`upstream-source-confirmations.md`](../upstream-source-confirmations.md) (SQLite
`ext/session/sqlite3session.c:4952-4978` for the conflict dispatch and MISUSE rules;
`sqlite3session.h:192-202` for the PK/NULL-PK rules and `:1592-1622` for the rebaser;
`src/wal.c:129-133` for “WAL is not supported on a network filesystem”;
`src/os_unix.c:1191` “POSIX advisory locks are broken by design”; and
`node/src/node_sqlite.cc` for the binding behavior, with
`node/deps/sqlite/sqlite.gyp:24,27` confirming SESSION/PREUPDATE are compiled in).

### G2. Bindings compared, and the lock prior art (source-grounded)

A second source pass checked two other relevant building blocks:

**`better-sqlite3` (v12.10.0, bundles SQLite 3.53.2).** Its actual compile flags
(`deps/defines.gypi`) enable FTS5/JSON1/`DESERIALIZE`/`THREADSAFE=2`/`USE_URI=0` but
**neither `SQLITE_ENABLE_SESSION` nor `SQLITE_ENABLE_PREUPDATE_HOOK`**: the session code
is `#if`-compiled out, and it exposes **no** session/changeset/rebaser JS API (only
`prepare/transaction/pragma/backup/serialize/function/aggregate/loadExtension`). It
compiles the standard amalgamation, so its **on-disk file is the identical
`SQLite format 3`**, cross-readable with `node:sqlite`/CLI/Python/Rust.
**Verdict:** not usable as the changeset *writer/reconcile* runtime without a custom
native rebuild (re-introducing the prebuild burden `node:sqlite` avoids), but fully
usable as a **reader** and as the **direct-mode** writer (which needs no session), and a
good reference for the driver API shape.
A store-driver abstraction should require `node:sqlite` only for the changeset path and
allow either binding elsewhere.
**One URI gotcha:** `better-sqlite3` compiles `SQLITE_USE_URI=0`
(`deps/defines.gypi:40`), so per-database URI options (`immutable=1`, `nolock=1`,
`vfs=…`) are **not** honored unless URI parsing is force-enabled *globally*: whereas
`node:sqlite` opens with `SQLITE_OPEN_URI` set, so they work there per-open.
So the `immutable=1` fast-reader path (Finding C) is native on `node:sqlite` but awkward
on `better-sqlite3`. **Capability detection over assumption:** the driver exposes a
`capabilities()` probe (session support, URI handling) and a `SnapshotStore` write fails
*loudly* on a session-less runtime rather than silently degrading.

**`node-proper-lockfile` (v4.1.2).** It locks with **`mkdir`** ("atomic on any kind of
file system, even network based ones") and explicitly avoids `O_EXCL`/`flock` because
“`O_EXCL` is broken on NFS”; it uses an **mtime lease and heartbeat** with a
*compromised* threshold and **mtime-precision probing** for coarse-granularity
filesystems. This independently supports using `mkdir`, an mtime lease, and a heartbeat:
the same shape as the implementation’s lock.
**Verdict:** don’t depend on it directly (it is async/Promise-based while the publish
path is synchronous, pulls a `graceful-fs` dep, and has no owner-token fencing, only an
`onCompromised` notification).
Adopt its mtime-precision handling and default constants** (`stale ≥ 5000`,
`update = stale/2`) on top of the owner-token *revalidate-before-publish* fencing.
Crucially, proper-lockfile alone does not make a *live* SQLite database safe on NFS: it
only protects the lock.
The design still needs the immutable-snapshot and idempotent-ledger model so correctness
does not depend on the lock at all.

The lease directory carries an explicit **owner manifest** so a stale-break is auditable
and a fencing check has something to revalidate against:

```json
// publish.lock/owner.json
{ "token": "random-owner-token", "pid": 12345, "host": "host.example", "at": 1785552000000 }
```

**One honest caveat:** proper-lockfile’s staleness/compromise check is **mtime
equality**, which is *not* a true monotonic fencing token: per
[Kleppmann](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)
it is necessary but not sufficient under arbitrary process pauses.
`fsqlite` does not rely on it for correctness: the `applied_tx` ledger and
OCC-on-`current` make folding exactly-once *regardless* of whether the lock is perfect
(Finding H). The owner token supports *liveness* and *attribution* rather than the
safety argument. The real shared-filesystem gate determines whether a monotonic fence or
single-host proxy-lock gate is warranted.

### H. The design pattern that satisfies the requirements: snapshot-publish and envelopes

Combining the above, the pattern that meets every requirement with no server and no
fragile file lock is **optimistic concurrency over an append-only changeset commit-log,
with immutable published snapshots selected by an atomic pointer.** On disk:

```text
<dir>/
  fsqlite.json                    # format="fsqlite", format_version="f1.0", store_id
  current                         # tiny text pointer → the published snapshot version
  snapshots/
    000000000000.fsqlite.sqlite   # immutable published heads (standard SQLite)
    000000000001.fsqlite.sqlite
  tx/
    pending/<txid>.txn/           # one transaction envelope per writer commit
      manifest.json               #   format/store identity, writer/base/schema metadata,
                                  #   changeset digest and provenance
      changeset.bin               #   the SQLite changeset blob
      COMMITTED                   #   written LAST: envelope becomes eligible for reconcile
    applied/<txid>.txn/           # archived after folding into a published snapshot
    quarantine/<txid>.txn/        # corrupt / schema-mismatch / strict-conflict (evidence kept)
  leases/<token>.lease            # read-leases pinning a version against GC
  publish.lock/                   # mkdir lease lock (owner token); held only during publish
```

**Protocol:**

- **Identify.** Require a valid root `fsqlite.json`; never infer store identity from
  generic layout names.
  Match its `f1.0` format and UUID `store_id` against snapshots and envelopes before
  accepting them.
- **Write (lock-free).** Seed a session from the *current immutable snapshot* (safe: it
  is never mutated), run the caller’s work, extract a changeset, and write an envelope
  with the `COMMITTED` marker **last**. Unique paths ⇒ conflict-free concurrent writes
  on a conforming filesystem; partial/uncommitted envelopes are ignored.
  Local behavior is tested.
  Multi-host NFS/SMB behavior remains a separate gate.
- **Reconcile (out-of-band).** Build the next snapshot in a temp file from the current
  snapshot and committed pending envelopes (skipping any already in the snapshot’s
  `applied_tx` ledger; quarantining digest/schema-mismatched or strict-conflicting
  ones), run `quick_check`, then **publish** by atomically swapping `current` (write
  `current.tmp`, `rename`). Building is lock-free; only the short publish (re-check
  pointer and rename) is fenced by the `mkdir` lease lock, with optimistic concurrency
  on `current`.
- **Read.** Open only the immutable snapshot named by `current`: any binding, any
  language, **no session extension**, and (since it never changes) safe to
  `immutable=1`.

**Why this satisfies each requirement:**

- **R-DURABLE / safe snapshot backup / R-DETECT.** Published heads are **immutable** and
  the pointer swap is **atomic**, so a crash or interrupted protocol operation cannot
  damage a committed state: recovery returns the last validated published head, losing
  at most the unpublished tail.
  A pinned immutable snapshot can be copied safely.
  Arbitrary recursive copying of the live directory is outside this guarantee.
  Content digests, `integrity_check`, and structural “in-flight tells” make every
  anomaly detectable.
- **R-CONCURRENCY.** Writers never block each other (unique envelopes); only conflicting
  transactions are resolved by policy at reconcile (last-writer-wins / set- union /
  strict-quarantine). This is per-session optimism, not a whole-DB lock.
- **R-FS / R-NOSERVER.** The only shared mutations are file/directory creates and one
  atomic rename. The protocol requires those operations, close-to-open visibility, and
  fsync barriers to pass capability validation.
  Local behavior is tested; multi-host NFS and SMB evidence is pending.
  No WAL `-shm`, no `fcntl`, no daemon.
- **R-FORMAT / R-LOCAL / R-XPLAT.** Every published snapshot is a standard SQLite file;
  readers are universal; `node:sqlite` is zero-dependency so install is trivial cross-
  platform.

**Correctness does not depend on a perfect lock.** The `mkdir` lease is complemented by
a per-snapshot **`applied_tx` ledger** (written in the same transaction that applies
each changeset) makes folding **exactly-once**, and two overlapping reconcilers build
**separate temp files** and commit via **optimistic concurrency on `current`** (the
loser retries to a no-op).
A stale-lock break or a process killed mid-publish therefore cannot corrupt or
double-apply. This is what makes a *portable* design feasible where a perfect
cross-platform lock is not.

### I. The local single-writer variant (same format and any binding)

For the common single-writer-on-local-disk case, the same immutable-snapshot format
supports a **direct** strategy: one writer holds the publish lock and does **copy →
mutate → publish** synchronously: *no changesets, no envelopes, no reconcile, and no
session extension even for the writer*, so it runs on **any** SQLite binding
(`better-sqlite3`, `bun:sqlite`). It is a coarse local single-writer serializer (the
lock is held across the complete write) and remains immutable-snapshot-safe (R-DURABLE).
Because it writes the identical on-disk shape, a store can be written directly when
alone and read/operated by the concurrent engine later: **two write strategies, one
format.** This is the simpler, easier-locking-locally option alongside the full
concurrent engine.

Its single-writer transaction uses the conservative, WAL-free recipe that the whole
document argues for:

```sql
PRAGMA journal_mode=DELETE;   -- rollback journal, no -wal/-shm side files at rest
PRAGMA synchronous=FULL;      -- durability under the configured sync policy
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;     -- absorb brief local contention
BEGIN IMMEDIATE;              -- take write intent up front; contention surfaces at BEGIN
-- caller writes …
COMMIT;
```

`DirectStore` delegates the sanctioned `seal()` export to the shared immutable-snapshot
path; the public `backupDatabase()` helper covers online copies of ordinary SQLite
files. A post-alpha measurement covers the rollback-journal *variant* (`DELETE` vs
`TRUNCATE` vs `PERSIST`): `DELETE` is the simplest and most compatible default; the
others trade compatibility for fewer metadata operations.
(This is a `DirectStore`-only concern; `SnapshotStore`’s `reconcile` builds each
snapshot in a fresh temp file and never runs WAL.)

### J. Experiments run, and results

A dependency-free reference implementation (`node:sqlite`, Node v22.22.2) implements the
design as a generic package (caller supplies schema and per-table policy) and is
exercised by the current QA suite, including real multi-process (`child_process`)
concurrency:

- **Concurrency:** N lock-free writer processes lose **zero** committed tx after
  reconcile; racing reconciler processes publish **exactly-once** with an
  `integrity_check`-clean head; readers looping during concurrent publishes **never**
  see a torn or regressing snapshot.
- **Crash recovery at every publish step** (`after-build`, `after-snapshot`,
  `after-pointer`) recovers to exactly-once; a published snapshot is never lost.
- **True SIGKILL:** a child **killed while holding `publish.lock`** does not wedge the
  store (the stale lease is reclaimed; recovery is exactly-once); a reconciler killed
  mid-build orphans only a temp.
- **Randomized chaos:** writers, reconcilers, and readers all at once converge with zero
  loss, no double-apply, integrity-clean head (stable across repeated runs).
- **Fencing/lease:** revalidate-before-publish aborts a holder whose lease was stolen; a
  stale lock is reclaimable; OCC on the pointer turns a superseded-base reconcile into a
  safe no-op.
- **GC and read-lease:** a snapshot pinned by an active lease survives GC; an abandoned
  lease self-clears; a packager reads a byte-stable pinned snapshot while `current`
  advances.
- **Portability:** a published/sealed head begins with `SQLite format 3\0` and carries
  the fixed fsqlite `application_id` and caller `user_version`; opens read-only with no
  session API.
- **doctor/repair:** restores the last consistent point from a torn store (re-publish to
  the highest integrity-clean snapshot, roll back orphans, quarantine uncommitted
  envelopes, clear transients and the stale lock).
- **Direct mode and interop:** synchronous direct writes; a directly-written store is
  read by the concurrent engine and vice versa; N direct-writer processes serialize with
  zero loss.

**Historical prototype performance (indicative, small metadata rows on local tmpfs):**

These June measurements predate the current maintained workload calibration and are not
release claims. See the
[current schema and workload assessment](research-2026-08-01-schema-evolution-and-workload-fit.md)
for reproducible commands, current numbers, and operating-envelope guidance.

- Write (envelope, default snapshot-seed): ~4-5 ms/write at a few-hundred-row catalog,
  growing with catalog size because the writer copies the current snapshot to seed its
  session.
- **Seeding experiment (2 KB rows):** snapshot seeding grew from 10.5 to 28.6 ms/write
  as the catalog grew from 500 to 5500 rows.
  An empty-schema experiment stayed near 16 ms/write, but it did not preserve the
  writer’s read base and was rejected before `0.1.0` as unsafe.
  The result motivates a safe shared-base or overlay design, not that shortcut.
- Reconcile: ~6 ms/tx (one base copy per pass, per-tx apply, ledger insert, and
  `quick_check`).

### K. Read/write concurrency and isolation: exact guarantees

Exactly what each model offers, and where the snapshot-publish design lands.

**WAL (the fair baseline).** WAL is the strong-isolation incumbent: **many readers run
concurrently and lock-free** (each sees a consistent snapshot as of its transaction
start: snapshot isolation), and a reader never blocks the writer or vice versa.
But there is **one writer at a time, and the write lock covers the whole database**: a
second writer gets `SQLITE_BUSY` and must wait/retry.
Isolation is **serializable** for writers (each write transaction sees the latest
committed state and is fully isolated).
The price: it needs shared memory (`-shm`), so it is **local-disk only**, and a live
file copy is not safe (R-FS and R-DURABLE both fail).
WAL provides serializable isolation with one writer and local-disk portability.

**The snapshot-publish design, stated precisely.** A “write” has two phases with very
different concurrency:

- **Reads use independent immutable snapshots.** A reader opens one published snapshot
  (optionally `immutable=1`), so fsqlite writers and reconciliation do not take a live
  database lock that blocks it.
  Isolation is **snapshot isolation at the granularity of a published version**: a
  reader sees one consistent snapshot N. This resembles a WAL reader’s stable
  transaction view, but it depends on different filesystem primitives and is not
  categorically safer.
  Resource limits still bound reader count, and cross-host operation remains an unproven
  alpha target.
- **Write capture can overlap without the publish lease.** Independent processes record
  envelopes simultaneously, subject to snapshot-copy bandwidth, free space, and process
  limits. A successful capture is not yet visible.
  Reconcile may quarantine it or apply it and publish a new snapshot.
  Publication remains serialized.
- **The only serialized step is the out-of-band merge** (`reconcile`), fenced by the
  `mkdir` lease and OCC on the pointer.
  It is brief, runs on its own cadence, and **writers and readers never block on it.**
  It serializes *the production of a new published snapshot*, not *the acceptance of
  independent writes*. (And even two merges racing are safe: OCC; the loser retries to a
  no-op.)

**Replaceable conflict granularity is per primary key, not whole-DB or per-table.**
Changesets route same-primary-key DATA and CONFLICT cases through that table’s policy:
`lww` (last-writer-wins by deterministic order), `union` (keep first / drop duplicate),
or `strict` (quarantine the losing transaction).
Writers touching different keys do not create that class of conflict.
Caller-declared constraints can still connect different keys or tables: UNIQUE, CHECK,
NOT NULL, and foreign-key failures reject the complete envelope in the settled `f1.0`
design. Changesets carry old and new values, so the engine also detects a genuine **DATA
conflict**: two writers each modified the same existing row from the same base, rather
than causing an insert collision.
The write-concurrency unit is therefore row-granular for replaceable policy conflicts
and envelope-granular when a declared constraint rejects the combined change.

**Isolation: honestly weaker than serializable.** The design is **not serializable
across writers.** It tracks each transaction’s *write set* (the rows it changed), not
its *read set*. So it detects write-write conflicts on the same row, but it **cannot**
detect a read-write anti-dependency: e.g. writer A reads row X and writes row Y
accordingly while writer B changes X; both commit and the X→Y invariant can be violated.
WAL’s single-writer serializability does not have this hole.
The honest framing: the design provides **“row-level optimistic concurrency with
write-set conflict detection and read-your-own-writes within a session”**, not full
serializable isolation.
Applications that need a cross-row invariant must put those rows under a `strict` policy
and use retry (below), or accept last-writer-wins semantics, or keep that invariant in a
single-writer (`DirectStore`) lane.

*Placed in standard theory:* this is the difference between **write-set validation** and
**read-set validation**. The classic optimistic-concurrency method (Kung and Robinson,
*On Optimistic Methods for Concurrency Control*, TODS 1981) validates a transaction’s
**read set** against concurrently-committed write sets; `fsqlite` validates only the
**write set** (the changeset, with old and new values), so it catches write-write/`DATA`
conflicts but no read-write anti-dependency.
The anomaly it therefore admits is the textbook **write skew** of snapshot isolation
(Berenson et al., *A Critique of ANSI SQL Isolation Levels*, 1995), and closing it in
general requires tracking rw-antidependencies: **Serializable Snapshot Isolation**
(Cahill, Röhm and Fekete, SIGMOD 2008; shipped in PostgreSQL), which observes read sets
via predicate/SIREAD locks the row-merge engine does not have.
So “not serializable” is precise, not hand-waved: `fsqlite` sits at **row-level OCC with
write-set validation**, one rung below SSI, and the escape hatches below are how an
application buys back the specific invariants it needs.

**Optimistic concurrency and granular retry: yes, at the row/transaction level.** The
model *is* optimistic at row granularity (writers never lock; conflicts are detected at
merge by PK and old-value).
Granular retry is available in three escalating forms:

1. **Policy resolution (no retry needed):** for `lww`/`union` tables the merge
   deterministically resolves same-row conflicts: the common case needs no retry at all.
2. **Application-level OCC retry (recommended for `strict`):** on a quarantined/aborted
   tx, a `writeWithRetry(fn)` helper re-seeds from the **new** current snapshot and
   re-runs the caller’s `fn` against fresh data, up to N times: a true per-transaction
   optimistic retry loop (the classic compare-and-retry).
   This can be added when a write must observe the latest state.
3. **Declared-precondition commit (`commitIf`):**
   `optimisticWrite(ctx => ctx.commitIf({ reads: [{table, pk, version}], write }))` lets
   the application **declare its read set** (version columns / PK compare-and-swap
   predicates) and revalidate it at merge.
   This is the Kung-Robinson read-set validation that the default model omits.
   It **soundly** closes write skew only within precise limits: it covers
   **fully-declared point-key invariants** over *existing* PKs; it does **not** cover
   phantom/predicate reads (a concurrently-*inserted* row whose PK the reader never saw
   cannot be declared), and it is **unsound by omission** (a forgotten precondition
   silently re-admits write skew).
   For aggregate/range invariants, materialize them into a single version-stamped guard
   row (which serializes that invariant) or use the `DirectStore` lane.
   So `writeWithRetry` re-runs against fresh data; `commitIf` additionally *guarantees*
   the declared reads still hold: use it when an invariant must not be lost, not merely
   refreshed.
4. **Engine rebase (future):** SQLite’s `sqlite3rebaser_*` can rebase a conflicting
   changeset onto the already-resolved base and re-apply **per change**, the
   finest-grained merge.
   `node:sqlite` does not expose it yet (Finding G), so v1 uses (1) and (2); (3) is the
   enhancement that would let even `strict` conflicts auto-merge without re-running
   `fn`.

**Could writes be even more parallel: independent “sections”?** SnapshotStore processes
can capture envelopes without queuing on one SQLite writer lock, but reconciliation is
still a serialized full-head build, validation, sync, and pointer publication.
If that publication lane becomes a measured bottleneck, the application can shard truly
independent data into separate stores, such as one per table group.
Each store then has its own `current` pointer and reconcile lane, at the cost of having
no atomic snapshot across shards.
Sharding is an application tradeoff, not a default requirement or proof that every
workload benefits.

**Summary of the trade.** Compared with WAL, immutable snapshots let readers proceed
without touching a live file, and transaction envelopes let several processes capture
independently instead of queuing on one live SQLite writer lock.
Publication remains serialized and pays the full-copy costs described in the current
workload assessment.
The design targets capability-validated shared filesystems and supports pinned immutable
snapshot copies. Real multi-host NFS and SMB proof is still pending.
In exchange, it provides weaker isolation: row-level merge with write-set conflict
detection and visibility only after reconcile.
This meets R-FS, R-DURABLE, and R-CONCURRENCY at the cost of serializability.

## Key Insights

1. **File locks are the wrong granularity.** The fine-grained part of locking is
   in-memory and same-host; cross-host it must become a *commit*. Put the serialization
   at a millisecond atomic pointer-swap and make it idempotent so lock perfection is
   unnecessary.
2. **A changeset is the OCC commit-log in SQLite-native form.** It turns “concurrent
   writers” into “each writer drops a uniquely-named file” and “a merge step folds
   them,” all plain files, conflict-free even on NFS: exactly the per-session optimism
   the requirements ask for.
3. **Immutability provides safe snapshot backup and crash safety.** Because published
   heads never mutate, a pinned head is byte-stable while publication continues.
   R-DURABLE falls out of the data model and the atomic pointer commit, not out of
   careful SQLite locking.
4. **Readers are universal; only writers/merge need the extension.** This keeps the
   tri-language and tool-compatibility goal intact: Python/Rust/`sqlite3` read a
   published snapshot today; the session requirement is confined to the writer/reconcile
   runtime.
5. **The constraints are in the binding, not SQLite.** `node:sqlite`’s missing
   table-name in the conflict handler, ABORT-as-`false`, and missing rebaser are all
   binding-level; the C API is richer.
   This shapes v1 (filter-based per-table policy; constrained writable surface so no
   rebaser is needed) and gives a clean upstream ask.
6. **Two write strategies, one format** serves both “many agents on a validated shared
   path” and “one local tool with simple coordination” without forking the on-disk
   format or the reader path.

## Comparison Matrix

Concurrency approaches for a single SQLite store with no server.
Read vs write concurrency stated separately, with the conflict/lock **granularity** and
the **isolation** each provides (see Finding K for the precise definitions and caveats):

| Approach | Read concurrency | Write concurrency | Conflict / lock granularity | Isolation | Server-free | Shared-filesystem fit | Immutable snapshot export |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Rollback journal (default) | many readers; a writer briefly excludes readers while writing the database | **1 writer** | whole-DB | serializable | ✓ | conditional on reliable SQLite locks and sync | ✗ |
| **WAL** with `busy_timeout` | **many, lock-free** (snapshot) | **1 writer** (global) | **whole-DB write lock** | writer serializable; readers snapshot | ✓ | ✗ (`-shm`) | ✗ |
| libSQL `BEGIN CONCURRENT` | many | **many** (commit-time check) | **page-level** | snapshot isolation and OCC | ✓ | ✗ (`-shm`) | ✗ |
| Turso/limbo (`journal_mode=mvcc`) | many (MVCC snapshot) | **many** (commit-time check) | **row-level** | snapshot isolation and row OCC | ✓ (embedded) | ✗ (in-process/local; in-memory versions) | ✗ |
| Wrapper `mkdir`-lock with rollback (≈ **DirectStore**) | **many** (immutable snapshots) | **1 writer** (lease) | whole-DB | serializable for a DirectStore-only stream | ✓ | local recommended; conditional on validated primitives | ✓ |
| Elected coordinator (LiteFS) | many | **1 primary** (replicas read-only) | engine-level | serializable | ✗ (FUSE daemon and lease) | n/a: own FUSE FS and replication | n/a (replicated) |
| Raft server (rqlite/dqlite) | many | many | engine-level | serializable | ✗ (cluster) | n/a: replicates over the network | n/a (replicated) |
| **Snapshot-publish and changeset log** (this doc) | independent immutable snapshots, capacity-bounded | independent capture, capacity-bounded; one out-of-band merge | **per-row (per-PK)**, per-table policy | row-level write-set merge and DATA-conflict detection (not serializable) | **✓** | conditional; real multi-host gate pending | **✓** (pinned snapshot) |

A fairness note on the “Shared-filesystem fit” column: LiteFS and rqlite/dqlite are not
“unsafe on NFS”; they **do not use a shared filesystem at all.** LiteFS gives each node
its own FUSE filesystem and *replicates* writes from a single elected primary;
rqlite/dqlite replicate via Raft over the network.
Both require a **running process** (a daemon/cluster), which is exactly the cost the
server-free approaches avoid.
So they solve a *different* problem (multi-node replication) rather than “share one file
on whatever disk you happen to be on.”

The headline contrast: **WAL gives you the strongest isolation (true serializable) but a
single global writer and only on local disk; this design gives you many concurrent
writer captures, immutable snapshot backup, and a protocol that avoids SQLite locking,
but with weaker merge-based isolation.** They sit at opposite ends of the
concurrency-vs-isolation trade, and the right pick depends on whether you need
serializability or concurrent capture and server-free filesystem publication.
(`DirectStore` is the middle: WAL’s single-writer simplicity with immutable publication
and any SQLite binding.)
Of the in-engine efforts, **Turso/limbo’s row-level MVCC is the closest external
analogue to this design’s row-level optimism**: it is a same-host, in-memory-versioned,
new-engine approach (no shared-filesystem or immutable-snapshot backup story, not a
standard SQLite file), which is exactly the axis on which `fsqlite` differs: file-native
and protocol-defined rather than in-process.
The full landscape of these alternatives is catalogued in [Related Work](#related-work).

## Options Considered

### Option A: Thin external write-lock wrapper (the §I “Tier-1” wrapper)

A cross-process `mkdir`/`flock` lease with `BEGIN IMMEDIATE` and
`nolock`/rollback-journal open-fresh-on-NFS around each transaction.

**Pros:** small (~40 lines over an existing lock); appropriate for modest local writes
and validated shared filesystems; keeps one standard SQLite file.
**Cons:** it is the **coarse one-writer-at-a-time** model the requirements want to
avoid; the lease-break/coherence hazards on NFS are *managed, not eliminated*; no
per-session optimism.
Good as a fallback or the “direct mode” floor, not as the primary concurrency story.

### Option B: Ephemeral elected coordinator (LiteFS pattern)

First participant wins a lease, opens the DB, serves a socket; others RPC in; lease
automatically releases on death.

**Pros:** real in-memory MVCC, strong immediate consistency, cross-host.
**Cons:** there *is* a process (transient, but a process); cross-platform
socket/lifecycle management is exactly the daemon-seamlessness liability R-NOSERVER
warns about; more moving parts.
This mode is not on the current roadmap: requiring a coordinator would contradict the
standalone, no-server operating model.
It should be reconsidered only if a future use case explicitly changes that product
boundary.

### Option C: Snapshot-publish and transaction-envelope changesets (recommended)

The Findings-H design: lock-free changeset writers, immutable snapshots, atomic pointer,
idempotent reconcile, `mkdir` lease only around publish, and the Findings-I direct mode
for the simple local case.

**Pros:** satisfies the architectural requirements (per-session optimism; no server;
filesystem-safe protocol; safe immutable-snapshot backup; crash safety; standard-SQLite
readers; cross-platform reference runtime); validated by the QA suite; correctness
independent of lock perfection.
**Cons:** writers/reconcile need the session extension (Node `node:sqlite` / Python APSW
/ Rust `rusqlite` / Go `zombiezen-go` / Deno), which on Node is now a **Release
candidate** (no longer `--experimental`-flagged, but a conservative release should still
gate on Stable); reader latency lags the pending tail until reconcile; per-write
snapshot-seed cost grows with catalog size and needs a future safe overlay or
shared-base optimization; no auto-rebase merge in v1 (constrained writable surface
instead).

> **Option C trade.** Option C buys many lock-free row-level writers, but it pays a
> **harder session dependency** than the single-writer floor (the commit-log *needs*
> sessions; the floor does not: see D2), a reconcile **visibility lag**, and
> **weaker-than-serializable** isolation (Finding K). The built-in mitigation is that
> the **`DirectStore` floor runs on any binding** with no session extension, so a v1 can
> ship the floor first and gate the concurrent engine on `node:sqlite` reaching Stable.
> Whether the extra write concurrency is *worth* those costs is an empirical question to
> settle against measured workload: if real catalog write concurrency is low, the floor
> may suffice for v1, with `SnapshotStore` as the scale path.

### Eliminated options

- **Raft servers (rqlite/dqlite), mvSQLite/FoundationDB:** violate R-NOSERVER; cluster-
  scale answers to a local-scale problem.
- **CRDT layer (cr-sqlite):** slowed since ~2024-10; a *loadable-extension* merge layer
  (a stock reader that touches its virtual table fails: breaks R-FORMAT), not a store;
  over-general for our conflict needs.
- **Turso/limbo and libSQL `BEGIN CONCURRENT`:** real multi-writer, but **local-disk
  only** (still WAL/`-shm` or in-memory version state) and, for Turso, a non-standard
  engine/file; fails R-FS and the standard-artifact goal.
- **Shared-cache mode:** SQLite calls it obsolete; it is connection-scoped and still
  allows only one write transaction per cache: it solves none of the cross-process /
  weak-FS problem.
- **DuckDB:** excellent analytical/columnar engine, but not a multi-process OLTP app
  store; concurrent writers still need a server/protocol.
  (Covered in the prior embeddable-databases survey.)
- **Pure-KV engines (LMDB/RocksDB/redb) for the interchange artifact:** fail R-FORMAT
  (engine-specific, poor external tooling); fine only as a rebuildable local cache.
- **A custom VFS that intercepts `xLock`/`xShmMap`:** native C, large build, and the
  serialization point can live at one app-level chokepoint anyway: transparency buys
  little here.

## Related Work

A wider survey of how real projects achieve our goals: server-free access, multi-writer
concurrency, and/or sync over SQLite: classified by **mechanism**, whether they use the
**session/changeset** extension, and whether they are **server-free**. The repos behind
the session-based entries were reviewed at the commits in [Source Map](#source-map).

| Project | Mechanism | Session-based? | Server-free? | Relation to `fsqlite` |
| --- | --- | --- | --- | --- |
| **SQLiteChangesetSync** | session changesets in a **git-like DAG**; `mergeAll()` | **Yes** | Yes (peer/file) | Closest cousin; conflicts are **detected and *skipped***, with no resolution; mobile/offline. |
| **`sqlite-sync` (sqliteai)** | **CRDT** (causal-length sets, LWW) and cloud sync | No (CRDT) | No (cloud/PG) | Different lane (auto-merge, server-backed). |
| **cr-sqlite (Vlcn)** | **CRDT** loadable extension (`crsql_changes` vtable, Lamport clocks) | No (CRDT) | Yes (peer) | Merge *layer*; a stock reader touching its vtable fails → breaks R-FORMAT; slowed since ~2024-10. |
| **GRDB.swift** | none built-in; raw C session via `db.sqliteConnection` | (raw) | n/a | Confirms sessions live in the mobile corner behind custom builds. |
| **Tencent WCDB** | session/changeset for backup/repair | Yes | Yes (local) | Session use, mobile. |
| **Bloomberg comdb2** | clustered SQL database | No | No (cluster) | Server lane. |
| **LiteFS** (Fly.io) | FUSE replicates **WAL/tx frames**; lease single primary | No | No (FUSE daemon and lease) | Replication, not file-share. |
| **Litestream** | streams **WAL** to object storage | No | Single-writer and remote | Durability, not concurrency. |
| **Verneuil** (Backtrace) | async **WAL/page** snapshot replication to S3; read replicas | No | No (S3) | Read-scaling. |
| **marmot** | trigger CDC → **NATS** broadcast | No | No (NATS) | Trigger-CDC, not session. |
| **Bedrock** (Expensify) | **Paxos** over SQL on a server | No | No | Server/consensus lane. |
| **rqlite** | **Raft** over SQL statements (HTTP) | No | No (cluster) | Eliminated (R-NOSERVER). |
| **dqlite** | embeddable C **Raft** over SQLite | No | No (cluster) | Eliminated. |
| **mvSQLite** | SQLite storage on **FoundationDB** | No | No (FDB) | Eliminated. |
| **libSQL `BEGIN CONCURRENT`** | in-engine **page-level OCC** (WAL) | No | Yes but `-shm` **local-only** | Fails R-FS. |
| **Turso / limbo** | in-engine **row-level MVCC** (`journal_mode=mvcc`) | No | Yes (in-process) | Closest *optimism* analogue; same-host, in-memory versions, non-standard engine. |
| **PowerSync / ElectricSQL** | server CDC / Postgres logical replication → client; LWW/CRDT | No | No (sync service) | Server-centric Postgres↔SQLite sync. |
| **SQLSync** (orbitinghail) | **page-capture VFS** with deterministic **reducer** and **rebase** | **No** (page-level, *not* changeset) | No (coordinator) | Borrows the *rebase* idea conceptually; commonly mis-cited as changeset-based. |

**What this shows.** The “distributed SQLite” infrastructure tier (LiteFS, Litestream,
Verneuil, marmot, Bedrock, rqlite, dqlite, mvSQLite) **avoids the session extension
entirely**: it replicates **WAL/pages** or runs **consensus on a server**. The in-engine
concurrency tier (libSQL, Turso) achieves multi-writer but only **on local disk** and
(Turso) in a **non-standard engine**. The CRDT/sync tier targets **device/server** sync.
The **session/changeset-based** projects all sit in the **mobile/offline-first** corner
and are app/device-specific.
Even the closest, SQLiteChangesetSync, **does not resolve conflicts.** So `fsqlite`’s
target, *server-free, file-native, row-level, any-filesystem, with the artifact staying
standard SQLite*: is reached by **no surveyed project**. This is the gap of Finding E,
corroborated against a much wider sample.

**Commit-log / atomic-pointer prior art (the structural ancestors).** The design’s shape
is not novel in the *data-lake* world, which is the point:

- **Delta Lake** commits by creating the next zero-padded version file in `_delta_log/`
  via **atomic put-if-absent**: one writer claims version *v*; data files are immutable;
  losers retry at the next version (Delta `PROTOCOL.md`). This is `fsqlite`’s
  envelope-ledger and atomic-pointer model.
- **Apache Iceberg** commits by an **optimistic swap of the table’s metadata pointer**,
  rejected if the pointer already moved; “an atomic swap … provides the basis for
  serializable isolation,” with multiple engine implementations against one spec
  (Iceberg spec). This is the “format and commit protocol, many implementations” framing
  of [What Kind of Artifact This Is](#what-kind-of-artifact-this-is).

The one deliberate divergence: Iceberg/Delta increasingly lean on a **catalog service**
for the atomic put-if-absent (the hard part on object stores); `fsqlite` takes the
**filesystem-only** path, where the atomic `mkdir`/`rename` lease *is* the
put-if-absent: no catalog service, at the cost of the cross-host coordination a service
would provide.

## Recommendations

The evidence supports Option C: immutable SQLite snapshots, transaction envelopes, and
filesystem publication, with a separate serialized local-writer strategy over the same
format. The implementation and API have continued to change since this research was
written, so they are intentionally not reproduced here.

The current resolution is maintained in three places:

- [Design and Constraints](../fsqlite-design.md) defines the system constraints,
  rationale, trust boundary, operating envelope, and strategy choice.
- [Format Specification](../fsql-format-spec.md) normatively defines interoperable
  `f1.0` behavior.
- [Roadmap](../roadmap.md) owns unresolved evidence, portability, evolution, isolation,
  and performance work.

One research proposal was rejected before `0.1.0`: an empty schema-only writer seed.
Without the published rows as its read base, updates and deletes can disappear and an
existing-key insert can overwrite columns the writer never observed.
A future large-store optimization must preserve the callback’s observed data and
declared constraints.

## What `fsqlite` Can and Cannot Promise

The boundary is explicit:

**Validated guarantees:**

- the at-rest artifact stays an **ordinary SQLite file** any tool/language can read;
- **publication is serialized at the merge**, and an envelope that reconcile
  successfully applies becomes visible and power-loss durable when the new snapshot is
  published (snapshot isolation at published-version granularity for readers);
- **bounded loss**: a crash or interrupted protocol operation loses at most the
  unpublished tail, never a previously published snapshot; a pinned immutable snapshot
  is safe to copy (R-DURABLE);
- **no silent corruption**: every detectable anomaly is surfaced by `validate`/`doctor`
  (R-DETECT);
- **package-created backups are consistent snapshots** (backup API / `VACUUM INTO` / a
  fenced copy), each `integrity_check`-verified in tests.

**Not guaranteed:**

- safety against **raw writers that bypass the protocol** (the cooperative boundary: a
  rogue process writing the tree can corrupt it, as it could any SQLite file);
- correctness on a filesystem that **lies** about atomic `mkdir`/`rename`, `mtime`,
  writes, or `fsync` (must be *validated* per environment: see `fsinspect` below);
- no loss if a user **copies the live store with arbitrary backup software** mid-write
  outside the sanctioned helpers;
- **WAL safety over NFS** (never the default; opt-in local-disk only);
- **thread safety if a single connection is shared across Worker Threads** (R-THREAD:
  one connection per thread);
- **full serializability**: the model is row-level OCC with write-set validation, weaker
  than serializable (Finding K); declared read-set validation is future work.

## Validation Matrix

The implementation already exercises several rows.
Every remaining row below names the evidence still needed; this is the checklist of
*what must be tested where*:

| Area | What to test |
| --- | --- |
| Local contention | many processes, one effective writer at the merge, no double-ownership *(automated ✓)* |
| Worker Threads | one connection per thread; explicit coordination contract and tests remain on the roadmap |
| Crash safety | kill mid-write/at-every-publish-step, reopen, `integrity_check` *(automated ✓)* |
| Stale locks | a stale lease is reclaimed without two breakers owning it *(automated ✓)* |
| Compromised locks | lock deletion/replacement while held aborts the current operation *(automated ✓)* |
| Backup | backup during writes; `integrity_check`; restore-and-read *(automated ✓)* |
| URI modes | normal, `immutable=1`, `nolock=1` where supported |
| Filesystems | APFS, ext4, NTFS, **NFSv4.1/EFS/Filestore**, SMB; consumer sync products are a separate unsupported model until tested |
| Cross-language | Node writer and Python/Rust/Go readers; later multi-language writers |
| Path handling | symlinks, spaces, Unicode, Windows drive paths |
| Dependency policy | frozen lockfile, install-script policy, package cool-off *(alpha ✓)* |

**The `fsinspect` filesystem-capability diagnostic.** Because the filesystem row is the
single biggest unknown and is hard to introspect, the shipped probe reports atomic
`mkdir` mutual exclusion, atomic rename-replace, exclusive create, close-to-open
visibility, mtime precision, symlink and hard-link behavior, directory fsync, WAL
viability, and a filesystem-type fingerprint.
It is one-host diagnostic evidence, not proof of cross-host semantics.
The real gate must run coordinated operations from at least two hosts on the target
mount.

## Areas of Further Research

The `f1.0` design is settled for alpha.
Remaining work is tracked under the post-alpha roadmap epic and its governing future
plan:

1. **Format conformance and evolution:** golden fixtures, an independent verifier, and
   explicit side-by-side whole-format upgrades.
2. **Real shared-filesystem behavior:** multi-host NFS/SMB tests, clock skew, attribute
   caching, lease breaks, monotonic-fence evidence, and expanded `fsinspect`
   diagnostics.
3. **Windows publication and path portability:** atomic rename-replace under racing
   publishers, URI modes, path edge cases, and a packed package matrix on supported
   architectures.
4. **Power-loss durability and recovery:** block-device fault injection, an optional
   durable-envelope receipt mode, and bounded research into replay-based bit-rot
   recovery.
5. **Cross-binding changesets and writers:** cross-version blob conformance before
   Python, Rust, or Go writer implementations claim parity.
6. **Caller-schema migration:** deterministic schema transitions distinct from the
   fsqlite directory-format upgrade.
7. **Stronger isolation:** declared read-set validation for point-key invariants, with
   guard rows or DirectStore for predicate and aggregate invariants.
8. **Threading and process-local coordination:** Worker Thread tests and an explicit
   coordination contract.
9. **Binding improvements:** table-name conflict context, rebaser exposure, and a
   decision on whether `base_version` should acquire staleness semantics.
10. **DirectStore journal policy:** measure rollback-journal variants without changing
    the compatibility-first `DELETE` default prematurely.
11. **Large-store efficiency:** measure writer seeding and explicit snapshot
    compaction/retention without weakening immutable publication.

Current implementation work is tracked in the [roadmap](../roadmap.md).
Project plans preserve sequencing and acceptance criteria but do not redefine the
design.

## Methodology

Empirical probes were run against `node:sqlite` (Node v22.22.2) and cross-checked
against upstream source at pinned commits.
The source-level review covered `sqlite/sqlite` (`002d33d`) for the session/locking/WAL
semantics (`ext/session/sqlite3session.{h,c}`, `src/wal.c`, `src/os_unix.c`);
`nodejs/node` (`v22.22.2`, SQLite 3.51.2) for the binding (`src/node_sqlite.cc`,
`deps/sqlite/sqlite.gyp`); `WiseLibs/better-sqlite3` (`f93f490`, v12.10.0, SQLite
3.53.2) for binding/format/session-availability (`deps/defines.gypi`, `lib/`); and
`moxystudio/node-proper-lockfile` (`9f8c303`, v4.1.2) for the `mkdir`-lease prior art
(`lib/lockfile.js`, `README.md`). Each technical claim in this document carries a
file:line reference verifiable after cloning those commits.
A complete implementation was run end-to-end (zero-loss concurrency, racing reconcilers,
crash-at-every-publish-step, SIGKILL, chaos, fencing, GC/lease, portability, repair,
direct-mode interop) and performance, seeding, and patchset benchmarks.
APSW, `rusqlite`, and SQLSync were also reviewed for cross-language session support and
mechanism comparison.
The full citation set is in the [Source Map](#source-map).
Point-in-time version and maturity facts should be re-verified before relying on them.

## References

**SQLite: format, locking, journaling, sessions (primary):**

- [SQLite as a Library of Congress recommended storage format](https://sqlite.org/locrsf.html)
  · [SQLite as an application file format](https://sqlite.org/appfileformat.html) ·
  [single-file DB](https://www.sqlite.org/onefile.html)
- [File locking (lockingv3)](https://sqlite.org/lockingv3.html) ·
  [WAL mode (incl. network-FS limits)](https://sqlite.org/wal.html) ·
  [URI filenames (`nolock`/`immutable`)](https://sqlite.org/uri.html) ·
  [alternate VFSes (`unix-dotfile`/`unix-flock`/`unix-none`)](https://sqlite.org/vfs.html)
- [Backup API](https://sqlite.org/backup.html) ·
  [`VACUUM INTO`](https://sqlite.org/lang_vacuum.html) ·
  [How to corrupt a SQLite database](https://sqlite.org/howtocorrupt.html) ·
  [security / untrusted DBs](https://sqlite.org/security.html) ·
  [limits](https://sqlite.org/limits.html)
- [Session extension intro](https://sqlite.org/sessionintro.html) ·
  [`sqlite3session_changeset`](https://www.sqlite.org/session/sqlite3session_changeset.html)
  ·
  [`sqlite3changeset_apply` and conflict handler](https://www.sqlite.org/session/sqlite3changeset_apply.html)
  · [rebaser](https://www.sqlite.org/session/rebaser.html) · FTS5

**Bindings:**

- [Node `node:sqlite`](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)
  · [session support commit](https://github.com/nodejs/node/commit/457e73f4c9) (source
  pass: `nodejs/node` `src/node_sqlite.cc`, `deps/sqlite/sqlite.gyp:24,27`:
  SESSION/PREUPDATE on)
- [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) (source pass:
  `WiseLibs/better-sqlite3` `deps/defines.gypi`, SESSION **off**; `lib/`, no changeset
  API; standard on-disk format) ·
  [APSW session (Python)](https://rogerbinns.github.io/apsw/session.html) ·
  [`rusqlite` `session` feature](https://docs.rs/rusqlite/latest/rusqlite/session/index.html)
  · [`mattn/go-sqlite3` session request](https://github.com/mattn/go-sqlite3/issues/825)

**Concurrency / locking mechanisms (background):**

- [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html)
  ·
  [Berkeley DB locking subsystem](https://docs.oracle.com/database/bdb181/html/programmer_reference/lock.html)
  ·
  [robust mutexes (`pthread_mutexattr_setrobust`)](https://man7.org/linux/man-pages/man3/pthread_mutexattr_setrobust.3.html)
  · [OFD locks (`F_OFD_SETLK`)](https://man7.org/linux/man-pages/man2/fcntl.2.html) ·
  [Windows named mutexes (`WAIT_ABANDONED`)](https://learn.microsoft.com/en-us/windows/win32/sync/mutex-objects)
- [Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)
  (leader election analogue) ·
  [`proper-lockfile`](https://github.com/moxystudio/node-proper-lockfile) (source pass:
  `moxystudio/node-proper-lockfile` `lib/lockfile.js`: `mkdir` lease and mtime
  heartbeat; `README`: “`O_EXCL` is broken on NFS, `mkdir` is not”)

**Prior art: distributed/concurrent/replicated SQLite:**

- [LiteFS](https://fly.io/docs/litefs/)
  ([how it works](https://fly.io/docs/litefs/how-it-works/)) ·
  [Litestream](https://litestream.io/) · [rqlite](https://rqlite.io/) ·
  [dqlite](https://dqlite.io/) · [mvSQLite](https://github.com/losfair/mvsqlite) ·
  [cr-sqlite (Vlcn)](https://github.com/vlcn-io/cr-sqlite)
- [libSQL](https://github.com/tursodatabase/libsql) ·
  [Turso `BEGIN CONCURRENT`](https://turso.tech/blog/beyond-the-single-writer-limitation-with-tursos-concurrent-writes)
  · [Turso Database (pure-Rust rewrite, beta)](https://github.com/tursodatabase/turso)
- Changeset-sync prior art:
  [SQLiteChangesetSync](https://github.com/gerdemb/SQLiteChangesetSync) ·
  [sqliteai/sqlite-sync](https://github.com/sqliteai/sqlite-sync) ·
  [Bloomberg comdb2](https://github.com/bloomberg/comdb2) ·
  [GRDB session discussion](https://github.com/groue/GRDB.swift/discussions/1523)

**Commit-log / OCC pattern (the cross-host “lock becomes a commit”):**

- [Apache Iceberg](https://iceberg.apache.org/) ·
  [Iceberg spec](https://iceberg.apache.org/spec/) · [Delta Lake](https://delta.io/) ·
  [Delta `PROTOCOL.md`](https://github.com/delta-io/delta/blob/master/PROTOCOL.md)
  (atomic pointer-swap / optimistic-concurrency commit logs over immutable files)

**Cross-language session bindings (writer-parity, Finding F1):**

- [APSW session](https://rogerbinns.github.io/apsw/session.html) (table name and
  `Rebaser`) ·
  [`rusqlite` `session`](https://docs.rs/rusqlite/latest/rusqlite/session/index.html) ·
  [`zombiezen.com/go/sqlite` session](https://github.com/zombiezen/go-sqlite/blob/v1.4.2/session.go)
  · [Bun `node:sqlite` Session](https://bun.com/reference/node/sqlite/Session) ·
  [Deno `node:sqlite`](https://docs.deno.com/api/node/sqlite/) ·
  [official `sqlite-wasm`](https://www.npmjs.com/package/@sqlite.org/sqlite-wasm)

**Backup / threading / runtime (Findings C, G2):**

- [`sqlite3_rsync`](https://sqlite.org/rsync.html) (live consistent copy; SQLite
  3.47.0+) · [threadsafe modes](https://sqlite.org/threadsafe.html) ·
  [shared-cache (obsolete)](https://sqlite.org/sharedcache.html) ·
  [Node `node:sqlite` (current)](https://nodejs.org/api/sqlite.html) ·
  [Turso v0.5.0 (`journal_mode=mvcc`)](https://turso.tech/blog/turso-0.5.0)

**Filesystem semantics and distributed locking (Findings B, D):**

- [NFSv4 RFC 7530](https://datatracker.ietf.org/doc/html/rfc7530) ·
  [NFSv4.1 RFC 8881](https://www.rfc-editor.org/info/rfc8881/) ·
  [LWN: O_EXCL over NFS](https://lwn.net/Articles/251004/) ·
  [Kleppmann: how to do distributed locking (fencing tokens)](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)

**Isolation theory (Finding K):**

- Kung and Robinson, *On Optimistic Methods for Concurrency Control* (ACM TODS, 1981) ·
  Berenson et al., *A Critique of ANSI SQL Isolation Levels* (SIGMOD 1995) · Cahill,
  Röhm and Fekete, *Serializable Isolation for Snapshot Databases*
  ([SIGMOD 2008](https://people.eecs.berkeley.edu/~kubitron/courses/cs262a-F13/handouts/papers/p729-cahill.pdf))
  · Fekete et al., *Making Snapshot Isolation Serializable* (ACM TODS, 2005)

**Other workarounds surveyed (Related Work):**

- [SQLSync](https://github.com/orbitinghail/sqlsync) (page-VFS and reducer) ·
  [Verneuil](https://github.com/backtrace-labs/verneuil) ·
  [marmot](https://github.com/maxpert/marmot) ·
  [PowerSync](https://docs.powersync.com/architecture/powersync-protocol) ·
  [ElectricSQL](https://electric-sql.com/) ·
  [Tencent WCDB](https://github.com/Tencent/wcdb)

**Implementation evidence:**

- The package’s full `node:test` and CLI golden suites; its
  `upstream-source-confirmations.md` records the exact SQLite/`node:sqlite` source
  lines.

## Source Map

Every load-bearing claim in this document is grounded in source read at a pinned commit.
Clone each repository at the recorded commit into any scratch directory, then resolve
the repo-relative source paths below.

| Repo | Commit | Read for |
| --- | --- | --- |
| `sqlite/sqlite` | `002d33d` | session semantics (`ext/session/sqlite3session.{h,c}`), WAL/network-FS (`src/wal.c:129-133`), locking (`src/os_unix.c:1191`, `:7298-7312`), backup (`src/backup.c`), `tool/sqlite3_rsync.c`, VFS modes, `os_win.c` `LockFileEx` |
| `nodejs/node` | `v22.22.2` (and a current `main` re-read) | the binding (`src/node_sqlite.cc` `conflictCallback`; ABORT-as-`false`; MISUSE rules), `deps/sqlite/sqlite.gyp:24,27` (SESSION/PREUPDATE on), open flags |
| `WiseLibs/better-sqlite3` | `f93f490` | `deps/defines.gypi` (`THREADSAFE=2`; `USE_URI=0`; SESSION **off**; `OMIT_SHARED_CACHE`); no changeset API; standard on-disk format |
| `moxystudio/node-proper-lockfile` | `9f8c303` | `mkdir` lease, mtime heartbeat, precision probe, realpath, and compromised-lock check (`lib/lockfile.js`, `lib/mtime-precision.js`, `README`) |
| `rogerbinns/apsw` | `e5f9feb` | full Python session surface incl. table-name-in-conflict-handler and a `Rebaser` (`src/session.c`) |
| `rusqlite/rusqlite` | `61d66c0` | `Operation::table_name` in the conflict handler; rebaser only as raw `libsqlite3-sys` FFI (`src/session.rs`) |
| `orbitinghail/sqlsync` | `7dc1af6` | confirmation that SQLSync is **page-VFS with a reducer and rebase**, not changeset-based |

The first four commits are also recorded in `upstream-source-confirmations.md`, with
per-claim file:line references.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
