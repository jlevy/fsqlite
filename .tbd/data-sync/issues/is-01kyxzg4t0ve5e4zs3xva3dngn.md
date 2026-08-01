---
type: is
id: is-01kyxzg4t0ve5e4zs3xva3dngn
title: "PR #1 review D5a: fence initial snapshot publication"
kind: bug
status: closed
priority: 2
version: 4
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels: []
dependencies: []
parent_id: is-01kyxzayw4jqyc0tty925kttr0
created_at: 2026-08-01T06:17:05.088Z
updated_at: 2026-08-01T06:31:41.562Z
closed_at: 2026-08-01T06:31:41.562Z
close_reason: Implemented with focused recovery and failure-path regression tests; the affected test files and focused lint pass.
---
Owner engineering review D5a. SnapshotStore.init() acquires withLock but ignores its token (packages/fsqlite/src/snapshotStore.ts:224-279) before rename/publish, whereas docs/fsql-format-spec.md:346-348 requires each holder to revalidate immediately before destructive publication and :172 calls first-open fenced. Revalidate current and owner token before snapshot-0 rename/pointer swap; add a stale-break/racing initializer regression.
