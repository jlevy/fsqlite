---
type: is
id: is-01m6yzk0sjfm017ew5xapqedtw
title: 'PR #5 C10: Remove a misleading comment. `snapshotStore.ts:209-211` says "The raw, unrestricted value is still recorded in the manifest", but `write()` rejects a non-matching `writerId` b'
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
created_at: 2026-11-09T01:43:28.305Z
updated_at: 2026-11-09T01:54:01.132Z
started_at: 2026-11-09T01:54:01.132Z
---
Review C at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-PRR_kwDOS5UOe88AAAABWvARmw

Related: A2 (Review A) is the one destructive-maintenance hole I would otherwise have reported. Unvalidated `staleMs: 0` lets `repair()` break a live lock and delete a live build. It is not repeated here, and its fix covers it.
