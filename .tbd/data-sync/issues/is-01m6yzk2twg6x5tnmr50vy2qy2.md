---
type: is
id: is-01m6yzk2twg6x5tnmr50vy2qy2
title: "PR #5 D1 — Medium — gc now reads the whole head on every call, including calls that delete nothing"
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
created_at: 2026-11-09T01:43:30.395Z
updated_at: 2026-11-09T01:59:33.147Z
started_at: 2026-11-09T01:48:24.807Z
---
Review D at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-5820694576

`packages/fsqlite/src/snapshotStore.ts:1364` (`const health = this.validate()` in `gc`); spec `docs/fsql-format-spec.md:600` (G0); `docs/fsqlite-design.md:447-471` (Capacity and Cadence).
