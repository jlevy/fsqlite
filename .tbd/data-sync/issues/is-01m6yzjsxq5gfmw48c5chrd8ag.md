---
type: is
id: is-01m6yzjsxq5gfmw48c5chrd8ag
title: "PR #5 A2 (Medium): `LockOptions` is not validated, so `staleMs: 0` lets `repair()` break a live publisher's lock and delete its build"
kind: task
status: in_progress
priority: 2
version: 3
delegate: codex@spud10
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
hold: null
hold_until: null
created_at: 2026-11-09T01:43:21.270Z
updated_at: 2026-11-09T01:59:32.014Z
started_at: 2026-11-09T01:48:24.712Z
---
Review A at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-5820620761

- `packages/fsqlite/src/lock.ts:125-135`: the only check is `timeoutMs > staleMs`.
- `packages/fsqlite/src/snapshotStore.ts:1769-1775`: the live-lock refusal uses `lockOpts.staleMs` as given.
- `packages/fsqlite/src/types.ts:97,111,117` and `packages/fsqlite/src/directStore.ts:44`: the docs promise "Invalid values throw a `TypeError`".
