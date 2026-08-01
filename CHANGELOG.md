# Changelog

All notable changes to fsqlite are documented here.

## 0.1.0: 2026-07-31

First standalone alpha.

- Introduces the self-identifying, flat `f1.0` store format with `fsqlite.json`, stable
  store UUIDs, and fixed SQLite `application_id` `0x4653514C` (`FSQL`).
- Defines **constraint closure** (format spec 6.1): the merge is keyed on primary keys,
  and every caller constraint it cannot preserve is reported rather than silently
  accepted. `reconcile()` returns a `dropped` count by conflict type, `reconcile()` and
  `validate()` report foreign key violations on an axis separate from store health, and
  merge passes run in a fixed order with foreign keys deferred to each envelope’s commit
  so the result never depends on policy-object key order.
- Documents the **design constraints** and the **operating envelope** (per-write cost
  scales with store size) as first-class parts of the design, and seeds writer working
  copies through a copy-on-write reflink where the filesystem supports one.
- Lets `repair` reclaim a stale publisher lease rather than refusing to clear the debris
  it diagnosed, fences `init` like every other publisher, sweeps and reports store-root
  transients, and exposes `repair()` on `DirectStore`.
- Provides `SnapshotStore`, `DirectStore`, online backup, recognition, inspection,
  validation, sealing, garbage collection, and fail-closed repair APIs.
- Fixes recovery atomicity, repair fencing, lease-loss handling, lock cleanup, and
  permanent-versus-retryable write classification.
- Ships a zero-runtime-dependency ESM package and CLI for supported Node releases.
- Adds reproducible pnpm tooling, strict type/lint/format gates, supply-chain checks,
  cross-platform CI, package smoke tests, and tag-triggered trusted publishing.

This is an alpha: the API and format may change before 1.0, and real multi-host NFS/SMB
validation is still pending.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
