---
type: is
id: is-01kyxzh0gy8tr2w2ngvnbjwhmr
title: "PR #1 review I6: remove redundant marker and snapshot identity reads"
kind: task
status: open
priority: 3
version: 3
spec_path: docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md
labels:
  - post-alpha
  - pr-review
dependencies: []
parent_id: is-01kyxmrxxwhdr0a5f90akc73a4
created_at: 2026-08-01T06:17:33.469Z
updated_at: 2026-08-01T06:28:57.672Z
---
Owner engineering review I6. SnapshotStore.read reads the marker at snapshotStore.ts:387 and then currentVersion rereads it at :372-379 before doing identity probes; write similarly reads marker/current/identity separately at :477-480. Immutable marker/snapshot identity permits reducing repeated file reads/query/open-close work while retaining close-to-open pointer semantics. Profile and add a regression/benchmark guard if a cache is adopted.
