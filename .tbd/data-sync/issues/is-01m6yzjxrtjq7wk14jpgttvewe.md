---
type: is
id: is-01m6yzjxrtjq7wk14jpgttvewe
title: "PR #5 C1 (Medium): the seal guard against store-owned paths is case-sensitive, so on macOS `seal()` can replace `current` or `fsqlite.json`"
kind: task
status: closed
priority: 2
version: 4
delegate: codex@spud10
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
hold: null
hold_until: null
created_at: 2026-11-09T01:43:25.209Z
updated_at: 2026-11-09T02:06:34.765Z
started_at: 2026-11-09T01:48:24.760Z
closed_at: 2026-11-09T02:06:34.765Z
close_reason: "Addressed in the reviewed 6d628b6 head. PRs #3 and #5 are merged into main at 40149ee. pnpm verify passed locally and all seven PR #5 checks passed."
resolution: null
duplicate_of: null
---
Review C at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-5820649883

`packages/fsqlite/src/snapshotStore.ts`:
- lines 181–185: `STORE_ROOT_ENTRIES`;
