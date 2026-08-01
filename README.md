# fsqlite

Filesystem-friendly concurrent SQLite for Node.js: immutable SQLite snapshots,
transaction-envelope writers, and atomic filesystem publication with no database server.

Ordinary SQLite coordinates processes around one mutable database file.
That is the simplest and usually fastest choice when every process is on one computer,
the filesystem locking is reliable, and writers can take turns.
fsqlite uses a different boundary: each published version is an immutable SQLite file,
independent writers can record proposed row changes without opening one shared file for
writing, and a later reconcile publishes the next version.

That trade is useful for compact local-agent state and file-native handoff.
It is not a faster replacement for ordinary SQLite: snapshot writes copy the published
database, visibility is delayed until reconcile, and concurrent merges are not
serializable. Start with the
[package decision guide](packages/fsqlite/README.md#should-you-use-fsqlite) before
choosing a write strategy.

The npm package source and primary usage guide live in
[`packages/fsqlite`](packages/fsqlite/README.md).
The [documentation map](docs/README.md) links the format specification, design,
technical research, QA runbook, roadmap, and project plans.
Release maintainers should follow the [release runbook](docs/releasing.md).

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm verify
```

The first release is `fsqlite@0.1.0`. The project, `f1.0` format, and public API are in
an alpha phase; cross-host NFS/SMB validation remains a disclosed pre-1.0 gate.

MIT © 2026 Joshua Levy.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
