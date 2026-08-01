---
type: is
id: is-01kyz6fnw8w1xgqazt7v6d2dpg
title: "Architecture revision: docs/fsqlite-design.md"
kind: task
status: closed
priority: 1
version: 2
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - documentation
  - design-review
dependencies: []
parent_id: is-01kyz6efvy59b3fcyzj5rdkqg1
created_at: 2026-08-01T17:38:24.263Z
updated_at: 2026-08-01T17:57:46.598Z
closed_at: 2026-08-01T17:57:46.598Z
close_reason: Revised and independently audited; pnpm verify passes with 127 node:test cases, 24 CLI goldens, build, package smoke, formatting, lint, typecheck, and project-hook checks.
---
Revise the current architecture explanation around ordinary SQLite versus DirectStore and SnapshotStore; make guarantees, schema epochs, performance causes, and decision boundaries explicit without duplicating research. Follow the tbd common documentation guidelines and the revise-architecture-doc intent for docs/fsqlite-design.md.
