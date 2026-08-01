---
type: is
id: is-01kyz763jnzcnqzktm3wpr299m
title: "Architecture revision: docs/README.md"
kind: task
status: closed
priority: 2
version: 2
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - documentation
  - design-review
dependencies: []
parent_id: is-01kyz6efvy59b3fcyzj5rdkqg1
created_at: 2026-08-01T17:50:39.188Z
updated_at: 2026-08-01T17:57:46.636Z
closed_at: 2026-08-01T17:57:46.636Z
close_reason: Revised and independently audited; pnpm verify passes with 127 node:test cases, 24 CLI goldens, build, package smoke, formatting, lint, typecheck, and project-hook checks.
---
Clarify the documentation hierarchy and public boundary: include standalone project plans because they record fsqlite decisions and release gates, while excluding private consumer context. Update the map for the first-principles design and workload guidance.
