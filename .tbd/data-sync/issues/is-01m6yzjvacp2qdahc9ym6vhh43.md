---
type: is
id: is-01m6yzjvacp2qdahc9ym6vhh43
title: "PR #5 A7 (Low): doc and comment drift against the code"
kind: task
status: in_progress
priority: 3
version: 2
delegate: codex@spud10
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
hold: null
hold_until: null
created_at: 2026-11-09T01:43:22.699Z
updated_at: 2026-11-09T01:48:24.739Z
started_at: 2026-11-09T01:48:24.739Z
---
Review A at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-PRR_kwDOS5UOe88AAAABWu-f2Q

- `packages/fsqlite/src/snapshotStore.ts:845-846`: the `readLease` docstring says "reconcile's GC" (gc is a separate call now) and "Returns { version, heartbeat, release }" (it is a disposable `ReadLease`).
- `packages/fsqlite/src/snapshotStore.ts:1112` and `packages/fsqlite/src/directStore.ts:127`, plus spec §F6 ("The Node implementation sets a numeric `published` property"): this duck-typed wording predates the typed class. Say `instanceof PostPublishError` (or `code === 'post-publish'`).
- `README.md:231`: the transient list omits `*.tmp-journal`, which spec §2 and `isTransientFile` now include.
