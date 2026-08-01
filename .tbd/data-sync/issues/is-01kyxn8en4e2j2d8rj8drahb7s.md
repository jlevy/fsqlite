---
type: is
id: is-01kyxn8en4e2j2d8rj8drahb7s
title: Measure DirectStore rollback-journal variants
kind: task
status: open
priority: 3
version: 1
spec_path: docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md
labels:
  - post-alpha
dependencies: []
parent_id: is-01kyxmrxxwhdr0a5f90akc73a4
created_at: 2026-08-01T03:18:07.267Z
updated_at: 2026-08-01T03:18:07.267Z
---
Benchmark and fault-test DELETE, TRUNCATE, and PERSIST rollback-journal modes for DirectStore across supported local and shared filesystems. Keep DELETE as the compatibility baseline unless evidence supports a different explicit policy; SnapshotStore remains WAL-free and unaffected.
