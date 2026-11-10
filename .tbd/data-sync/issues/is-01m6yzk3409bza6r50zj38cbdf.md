---
type: is
id: is-01m6yzk3409bza6r50zj38cbdf
title: "PR #5 D2 — Medium — each envelope's `foreign_key_check` scans every foreign-key-bearing table, so batching does not amortize reconcile on foreign-key schemas"
kind: task
status: in_progress
priority: 2
version: 5
delegate: codex@spud10
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
hold: null
hold_until: null
created_at: 2026-11-09T01:43:30.687Z
updated_at: 2026-11-10T23:31:34.689Z
started_at: 2026-11-09T01:48:24.814Z
---
Review D at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-5820694576

`packages/fsqlite/src/conflictPolicy.ts:242`; `packages/fsqlite/src/snapshotStore.ts:1198-1235` (`fold`); spec `docs/fsql-format-spec.md:369-374`; `docs/fsqlite-design.md:450` and `:467`.

## Notes

PR #5 documents the per-envelope FK scan. The performance optimization remains open.

2026-11-10: jlevy/fsqlite#7 (merged e8fd2b2) added merge-constraints.test.ts "foreign keys close at each envelope, even when a later envelope in the batch would cure it", which pins per-envelope closure. Design constraint for any optimization: outcomes must equal closure at each envelope boundary (spec F3). A batch check with per-envelope fallback is not enough, because its success path applies an envelope whose dangling reference a later envelope repairs. An exact fix needs a spec change to batch-boundary closure or an incremental check node:sqlite cannot express today.
