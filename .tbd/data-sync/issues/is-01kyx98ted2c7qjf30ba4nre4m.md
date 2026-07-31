---
type: is
id: is-01kyx98ted2c7qjf30ba4nre4m
title: Verify a clean-room install reproduces green from scratch
kind: task
status: open
priority: 1
version: 1
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase1
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:48:36.427Z
updated_at: 2026-07-31T23:48:36.427Z
---
Confirm pnpm install --frozen-lockfile followed by the full gate (format check, markdown check, zero-warning lint, tsc --noEmit, node:test suite, tryscript goldens, build with publint, package smoke test) passes from a fresh clone with nothing preinstalled. This is the exit criterion for Phase 1.
