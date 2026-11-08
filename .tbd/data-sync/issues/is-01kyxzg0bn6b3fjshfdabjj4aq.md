---
type: is
id: is-01kyxzg0bn6b3fjshfdabjj4aq
title: Heartbeat long publish-lock critical sections
kind: task
status: open
priority: 2
version: 6
spec_path: docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md
labels:
  - post-alpha
  - pr-review
dependencies: []
parent_id: is-01kyxmrxxwhdr0a5f90akc73a4
created_at: 2026-08-01T06:17:00.532Z
updated_at: 2026-11-08T22:23:27.829Z
---
DirectStore holds the publish lease across copy, callback, candidate checks, fsync, and publication; repair can scan multiple snapshots under the lease. The Node default stale window is 20 seconds. Fencing preserves safety if a long operation is stale-broken, but repeated work can livelock or time out. Design a safe heartbeat for synchronous critical sections or shorten them through an optimistic protocol, then add a controlled long-operation regression. Until then, deployments must set staleMs above their worst-case operation and keep timeoutMs > staleMs.

## Notes

The C1-C12 design consolidation documents this as a liveness boundary, and the package README and QA Part C include the required tuning disclosure. Implementation remains post-alpha.

2026-11-08: Being fixed together with fsq-joo8 (overlapping-publisher clobber, C1); this is C8 in fable-core.md.

2026-11-08 (core pass 1, PR #5): the publish lease is now renewed at critical-section step boundaries (copy, callback, fsync, reconcile steps). One synchronous step longer than staleMs can still be stale-broken; the remaining fix is an optimistic DirectStore or sub-step renewal. Narrow this bead to that residual.
