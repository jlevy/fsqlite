---
type: is
id: is-01m6yzk0sjfm017ew5xapqedtw
title: 'PR #5 C10: Remove a misleading comment. `snapshotStore.ts:209-211` says "The raw, unrestricted value is still recorded in the manifest", but `write()` rejects a non-matching `writerId` b'
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
created_at: 2026-11-09T01:43:28.305Z
updated_at: 2026-11-09T02:06:34.779Z
started_at: 2026-11-09T01:54:01.132Z
closed_at: 2026-11-09T02:06:34.779Z
close_reason: "Addressed in the reviewed 6d628b6 head. PRs #3 and #5 are merged into main at 40149ee. pnpm verify passed locally and all seven PR #5 checks passed."
resolution: null
duplicate_of: null
---
Review C at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-5820649883

Related: A2 (Review A) is the one destructive-maintenance hole I would otherwise have reported. Unvalidated `staleMs: 0` lets `repair()` break a live lock and delete a live build. It is not repeated here, and its fix covers it.
