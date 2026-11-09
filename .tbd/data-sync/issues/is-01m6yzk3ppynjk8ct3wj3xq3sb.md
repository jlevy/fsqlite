---
type: is
id: is-01m6yzk3ppynjk8ct3wj3xq3sb
title: "PR #5 D4 — Low — the F4 gate repeats a full `foreign_key_check` that the per-envelope checks already prove"
kind: task
status: open
priority: 3
version: 1
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
created_at: 2026-11-09T01:43:31.285Z
updated_at: 2026-11-09T01:43:31.285Z
---
Review D at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-PRR_kwDOS5UOe88AAAABWvDAMA

`packages/fsqlite/src/snapshotStore.ts:1235` calls `driver.quickCheck` (`driver.ts:279-285`), which ends in `foreignKeyCheck`; spec `docs/fsql-format-spec.md:490`.
