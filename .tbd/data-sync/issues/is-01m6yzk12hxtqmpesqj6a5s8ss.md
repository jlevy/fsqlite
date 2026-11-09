---
type: is
id: is-01m6yzk12hxtqmpesqj6a5s8ss
title: "PR #5 B1 (High): the O6 window's outcome is silent permanent loss that `validate()` reports as `sealed` and `repair()` completes; two spec statements about it are imprecise"
kind: task
status: in_progress
priority: 1
version: 2
delegate: codex@spud10
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
hold: null
hold_until: null
created_at: 2026-11-09T01:43:28.592Z
updated_at: 2026-11-09T01:48:24.774Z
started_at: 2026-11-09T01:48:24.774Z
---
Review B at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-PRR_kwDOS5UOe88AAAABWvBZRg

`packages/fsqlite/src/publication.ts:126-141`, `packages/fsqlite/src/fsutil.ts:73-88`, `packages/fsqlite/src/publication.ts:190-199`, `packages/fsqlite/src/snapshotStore.ts:1866-1878`, `:1394-1422`, `:1549-1639`; `docs/fsql-format-spec.md:569-578` (L5) and `:941-949` (O6).
Interleaving (reproduced with real code paths, the frozen holder modelled at the `fsyncPath` of its pointer temp): A at base N links `snapshots/N+1`, passes its final checks at `publication.ts:126`, and stalls inside `publishPointer` after `fsyncPath(tempPath)` for longer than `staleMs`. B breaks A's lock, reclaims A's entry (its mtime is now older than the window), publishes N+1 with {X, Y} and archives both. C publishes N+2 with {Z} and archives it. A resumes and renames its temp over `current`: `current` = N+1.
