---
type: is
id: is-01kyz0k92v8k4zqmbwt28dg6zh
title: Clarify schema epoch and operating envelope in docs/fsqlite-design.md
kind: task
status: closed
priority: 1
version: 2
spec_path: docs/fsqlite-design.md
labels:
  - design-review
dependencies: []
parent_id: is-01kyz0jk4e1tn8vfct59gw53ya
created_at: 2026-08-01T15:55:30.778Z
updated_at: 2026-08-01T16:30:42.316Z
closed_at: 2026-08-01T16:30:42.315Z
close_reason: Implemented, documented, and verified by the complete pnpm verify gate; independent final review found no remaining actionable design issue.
---
Explain immutable caller-schema identity, migration boundaries, exact schema hash semantics, conflict-policy coupling, byte-based scaling, reconciliation cadence, disk amplification, and workload fit.
