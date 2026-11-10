---
type: is
id: is-01m6yzjz9p90xab7c1bh7jhcp4
title: "PR #5 C5 (Low): a corrupt `current` is read whole and echoed whole in the error"
kind: task
status: closed
priority: 3
version: 3
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
created_at: 2026-11-09T01:43:26.773Z
updated_at: 2026-11-10T23:31:23.411Z
closed_at: 2026-11-10T23:31:23.411Z
close_reason: "Fixed in jlevy/fsqlite#7 (merged e8fd2b2): D1 no-op gc skips the full head check and classifies once; D3 writer working copies at synchronous=OFF; C5 bounded pointer read and quote; D4 spec F4 notes the deliberate full FK check. Reviewed in rounds 1-2 (A-D)."
resolution: null
duplicate_of: null
---
Review C at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-5820649883

`packages/fsqlite/src/snapshotStore.ts:816-822`.
