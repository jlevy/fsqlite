---
type: is
id: is-01kyxn8exk3ea5wgarck167rh7
title: Optimize writer seeding and snapshot compaction
kind: task
status: open
priority: 2
version: 3
spec_path: docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md
labels:
  - post-alpha
  - pr-review
dependencies: []
parent_id: is-01kyxmrxxwhdr0a5f90akc73a4
created_at: 2026-08-01T03:18:07.538Z
updated_at: 2026-08-01T06:29:06.144Z
---
Measure large-store writer startup and retained-snapshot costs. Evaluate schema-only seeding for insert-heavy writers, safe shared read-only bases or overlays, and explicit compaction/retention policy without changing f1.0 identity or weakening immutable publication.

## Notes

PR #1 engineering review D1 measured snapshot-seed write cost at roughly 2.3 ms per MiB on the reviewer machine and recommends safe shared-base or overlay work. Current disclosure is handled in fsq-rx5z; long-term optimization remains here.
