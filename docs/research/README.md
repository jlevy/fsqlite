# fsqlite Research

The
[Portable Concurrent SQLite Research](research-2026-06-06-portable-concurrent-sqlite.md)
is the primary technical report behind fsqlite.
It is self-contained and covers:

- SQLite session and changeset semantics, conflict handling, and cross-language support
- cooperative and arbitrary-writer coordination models
- local and network-filesystem locking, leases, fencing, and publication
- immutable snapshots, backups, reconciliation, isolation, and conditional commits
- Node and other SQLite bindings, compile-time capabilities, and runtime constraints
- prior art, rejected alternatives, validation experiments, and unresolved research

The report distinguishes point-in-time ecosystem observations from current project
decisions. For current behavior, read it with the [design](../fsqlite-design.md) and the
normative [format specification](../fsql-format-spec.md).

Two focused evidence records complement the report:

- [Upstream Source Confirmations](../upstream-source-confirmations.md) records pinned
  public source locations for SQLite and Node behavior
- [Application ID](../application-id.md) records selection and registration of the
  SQLite file identifier

Research is included when it supports the standalone format or implementation.
Consumer-specific evaluations and duplicated preliminary notes are excluded; reusable
findings from that work are incorporated into the report with public sources.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
