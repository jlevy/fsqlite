---
type: is
id: is-01m6yzk2twg6x5tnmr50vy2qy2
title: "PR #5 D1 — Medium — gc now reads the whole head on every call, including calls that delete nothing"
kind: task
status: closed
priority: 2
version: 5
delegate: codex@spud10
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
hold: null
hold_until: null
created_at: 2026-11-09T01:43:30.395Z
updated_at: 2026-11-10T23:31:23.403Z
started_at: 2026-11-09T01:48:24.807Z
closed_at: 2026-11-10T23:31:23.403Z
close_reason: "Fixed in jlevy/fsqlite#7 (merged e8fd2b2): D1 no-op gc skips the full head check and classifies once; D3 writer working copies at synchronous=OFF; C5 bounded pointer read and quote; D4 spec F4 notes the deliberate full FK check. Reviewed in rounds 1-2 (A-D)."
resolution: null
duplicate_of: null
---
Review D at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-5820694576

`packages/fsqlite/src/snapshotStore.ts:1364` (`const health = this.validate()` in `gc`); spec `docs/fsql-format-spec.md:600` (G0); `docs/fsqlite-design.md:447-471` (Capacity and Cadence).

## Notes

PR #5 records the measured warm and cold validation cost. The no-op collection optimization remains open.
