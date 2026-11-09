---
type: is
id: is-01m6yzjvacp2qdahc9ym6vhh43
title: "PR #5 A7 (Low): doc and comment drift against the code"
kind: task
status: closed
priority: 3
version: 4
delegate: codex@spud10
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
hold: null
hold_until: null
created_at: 2026-11-09T01:43:22.699Z
updated_at: 2026-11-09T02:06:34.749Z
started_at: 2026-11-09T01:48:24.739Z
closed_at: 2026-11-09T02:06:34.749Z
close_reason: "Addressed in the reviewed 6d628b6 head. PRs #3 and #5 are merged into main at 40149ee. pnpm verify passed locally and all seven PR #5 checks passed."
resolution: null
duplicate_of: null
---
Review A at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-5820620761

- `packages/fsqlite/src/snapshotStore.ts:845-846`: the `readLease` docstring says "reconcile's GC" (gc is a separate call now) and "Returns { version, heartbeat, release }" (it is a disposable `ReadLease`).
- `packages/fsqlite/src/snapshotStore.ts:1112` and `packages/fsqlite/src/directStore.ts:127`, plus spec §F6 ("The Node implementation sets a numeric `published` property"): this duck-typed wording predates the typed class. Say `instanceof PostPublishError` (or `code === 'post-publish'`).
- `README.md:231`: the transient list omits `*.tmp-journal`, which spec §2 and `isTransientFile` now include.
