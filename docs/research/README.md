# fsqlite Research

The
[Portable Concurrent SQLite Research](research-2026-06-06-portable-concurrent-sqlite.md)
is the primary technical report behind fsqlite.
Its central observation is that “local” no longer implies one database client or low
write contention. A single workspace can have many independent agents updating one
compact knowledge base, while a database server remains operationally inconvenient and
the resulting artifact still needs to be easy to inspect, archive, and hand to another
environment.

The report’s
[landscape review](research-2026-06-06-portable-concurrent-sqlite.md#e-the-prior-art-landscape-and-the-gap)
finds that surveyed alternatives usually retain one live SQLite writer, add a daemon or
consensus service, replace the engine or storage layer, require reader extensions, or
solve replication rather than cooperative file-native write coordination.
Its
[coordination triangle](research-2026-06-06-portable-concurrent-sqlite.md#b-locking-covers-three-layers-fine-grained-state-needs-a-coordinator)
explains the unavoidable trade: a server-free design can combine direct file access with
protocol-coordinated writes only by requiring cooperative writers.
The [key insights](research-2026-06-06-portable-concurrent-sqlite.md#key-insights) show
how SQLite changesets, immutable snapshots, and atomic pointer publication occupy that
gap while preserving standard SQLite readers.

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

The focused
[Schema Evolution and Workload Fit](research-2026-08-01-schema-evolution-and-workload-fit.md)
assessment checks the current alpha against the complete design review.
It gives schema lifecycle rules, local performance measurements, severity, adoption
guidance, and reconsideration triggers.

Two source evidence records complement those reports:

- [Upstream Source Confirmations](../upstream-source-confirmations.md) records pinned
  public source locations for SQLite and Node behavior
- [Application ID](../application-id.md) records selection and registration of the
  SQLite file identifier

This material is dated evidence.
The primary report’s ecosystem, version, and link facts were last re-checked on
2026-11-08; its “2026-11 update” notes record what changed since June.
The current [design constraints](../fsqlite-design.md#design-constraints), normative
format specification, QA runbook, and roadmap supersede any recommendation or future
work described in the report.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
