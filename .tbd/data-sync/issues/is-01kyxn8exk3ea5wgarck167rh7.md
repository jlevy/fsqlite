---
type: is
id: is-01kyxn8exk3ea5wgarck167rh7
title: Optimize writer seeding and snapshot compaction
kind: task
status: open
priority: 2
version: 4
spec_path: docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md
labels:
  - post-alpha
  - pr-review
dependencies: []
parent_id: is-01kyxmrxxwhdr0a5f90akc73a4
created_at: 2026-08-01T03:18:07.538Z
updated_at: 2026-08-01T07:31:30.184Z
---
Measure large-store writer startup and retained-snapshot costs. Design a safe shared read-only base, overlay, copy-on-write seed, or equivalent that preserves the rows and constraints observed by the callback. Add explicit compaction and retention policy without changing f1.0 identity or weakening immutable publication. The unsafe empty-schema seed is not part of f1.0.

## Notes

PR #1 review D1 measured snapshot-copy write cost at roughly 2.3 ms per MiB on the reviewer machine. The 0.1.0 design discloses that cost and requires full-head seeding. Any optimization must retain the callback read base and pass conformance and constraint-closure tests.
