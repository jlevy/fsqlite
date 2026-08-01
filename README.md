# fsqlite

Filesystem-friendly concurrent SQLite for Node.js: immutable SQLite snapshots,
transaction-envelope writers, and atomic filesystem publication with no database server.

The published package and canonical usage guide live in
[`packages/fsqlite`](packages/fsqlite/README.md).
The [documentation map](docs/README.md) links the format specification, design,
technical research, QA runbook, roadmap, and project plans.
Release maintainers should follow the [release runbook](docs/releasing.md).

```bash
pnpm install
pnpm verify
```

The current release target is `fsqlite@0.1.0-alpha.1`. The `f1.0` format and public API
are alpha; cross-host NFS/SMB validation remains a disclosed pre-1.0 gate.

MIT © 2026 Joshua Levy.
