---
type: is
id: is-01m6yzk1z3sqs18h4qkr9yg02e
title: "PR #5 B4 (Low): a lease holder's open can fail while its snapshot is tombstoned; `seal()` would throw a raw SQLite error"
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
created_at: 2026-11-09T01:43:29.506Z
updated_at: 2026-11-09T01:48:24.793Z
started_at: 2026-11-09T01:48:24.793Z
---
Review B at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-PRR_kwDOS5UOe88AAAABWvBZRg

`packages/fsqlite/src/snapshotStore.ts:1459-1503`, `:1671`; `docs/fsql-format-spec.md:625-627`.
Order: gc's pre-rename re-scan for v completes, the reader's lease lands and its existence check passes, gc renames v to its tombstone, the reader opens v (fails, `unable to open database file`), gc's second scan sees the lease and restores v. Reproduced (`tombstone-window.ts`). The spec admits the name can "vanish briefly"; the implementation's own lease consumer, `seal()`, opens at `:1671` with no retry and lets SQLITE_CANTOPEN escape unclassified. The window is one lease-directory scan, so this is a rare spurious failure, not loss.
