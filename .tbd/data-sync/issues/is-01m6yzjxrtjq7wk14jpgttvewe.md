---
type: is
id: is-01m6yzjxrtjq7wk14jpgttvewe
title: "PR #5 C1 (Medium): the seal guard against store-owned paths is case-sensitive, so on macOS `seal()` can replace `current` or `fsqlite.json`"
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
created_at: 2026-11-09T01:43:25.209Z
updated_at: 2026-11-09T01:59:32.287Z
started_at: 2026-11-09T01:48:24.760Z
---
Review C at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-5820649883

`packages/fsqlite/src/snapshotStore.ts`:
- lines 181–185: `STORE_ROOT_ENTRIES`;
