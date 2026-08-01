# Changelog

All notable changes to fsqlite are documented here.

## 0.1.0: 2026-07-31

First standalone alpha.

- Introduces the self-identifying, flat `f1.0` store format with `fsqlite.json`, stable
  store UUIDs, and fixed SQLite `application_id` `0x4653514C` (`FSQL`).
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
