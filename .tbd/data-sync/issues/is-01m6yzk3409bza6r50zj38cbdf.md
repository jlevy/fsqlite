---
type: is
id: is-01m6yzk3409bza6r50zj38cbdf
title: "PR #5 D2 — Medium — each envelope's `foreign_key_check` scans every foreign-key-bearing table, so batching does not amortize reconcile on foreign-key schemas"
kind: task
status: in_progress
priority: 2
version: 2
delegate: codex@spud10
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
hold: null
hold_until: null
created_at: 2026-11-09T01:43:30.687Z
updated_at: 2026-11-09T01:48:24.814Z
started_at: 2026-11-09T01:48:24.814Z
---
Review D at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-PRR_kwDOS5UOe88AAAABWvDAMA

`packages/fsqlite/src/conflictPolicy.ts:242`; `packages/fsqlite/src/snapshotStore.ts:1198-1235` (`fold`); spec `docs/fsql-format-spec.md:369-374`; `docs/fsqlite-design.md:450` and `:467`.
