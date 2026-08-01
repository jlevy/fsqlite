---
type: is
id: is-01kyxmt19dc881rzs8t4qy8bbe
title: Design declared read-set validation for point-key invariants
kind: feature
status: open
priority: 2
version: 1
spec_path: docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md
labels:
  - post-alpha
dependencies: []
parent_id: is-01kyxmrxxwhdr0a5f90akc73a4
created_at: 2026-08-01T03:10:14.828Z
updated_at: 2026-08-01T03:10:14.828Z
---
Add a commitIf-style protocol for explicitly declared point-key read sets. State the omission and phantom limits, test write-skew prevention, and require versioned guard rows or DirectStore for predicate, range, and aggregate invariants.
