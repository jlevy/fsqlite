---
type: is
id: is-01kyxzg0bn6b3fjshfdabjj4aq
title: "PR #1 review D4: heartbeat long publish-lock critical sections"
kind: bug
status: open
priority: 2
version: 3
spec_path: docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md
labels:
  - post-alpha
  - pr-review
dependencies: []
parent_id: is-01kyxmrxxwhdr0a5f90akc73a4
created_at: 2026-08-01T06:17:00.532Z
updated_at: 2026-08-01T06:28:56.845Z
---
Owner engineering review D4/I9 large-store gap. packages/fsqlite/src/lock.ts:131-135 exports heartbeat but no engine path calls it; DirectStore holds the lease across copy/mutate/check/fsync/publish (directStore.ts:78-115), and repair scans every snapshot under it (snapshotStore.ts:1001-1090). With defaults stale=20s, timeout=30s, large stores can be stale-broken and livelock. Implement/reason about safe periodic heartbeats (or document calibrated limits) and add a controlled long-operation/large-store regression test.
