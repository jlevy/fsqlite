---
type: is
id: is-01m6yzk3ppynjk8ct3wj3xq3sb
title: "PR #5 D4 — Low — the F4 gate repeats a full `foreign_key_check` that the per-envelope checks already prove"
kind: task
status: closed
priority: 3
version: 3
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
created_at: 2026-11-09T01:43:31.285Z
updated_at: 2026-11-10T23:31:23.413Z
closed_at: 2026-11-10T23:31:23.413Z
close_reason: "Fixed in jlevy/fsqlite#7 (merged e8fd2b2): D1 no-op gc skips the full head check and classifies once; D3 writer working copies at synchronous=OFF; C5 bounded pointer read and quote; D4 spec F4 notes the deliberate full FK check. Reviewed in rounds 1-2 (A-D)."
resolution: null
duplicate_of: null
---
Review D at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-5820694576

`packages/fsqlite/src/snapshotStore.ts:1235` calls `driver.quickCheck` (`driver.ts:279-285`), which ends in `foreignKeyCheck`; spec `docs/fsql-format-spec.md:490`.
