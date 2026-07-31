---
type: is
id: is-01kyx9gn7fvnx5n7nhngvfpqb7
title: Scrub the QA runbook of monorepo assumptions
kind: task
status: open
priority: 2
version: 1
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase3
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:52:53.230Z
updated_at: 2026-07-31T23:52:53.230Z
---
The most entangled doc: 11 references at :18 (cd packages/fsqlite), :24-30 (run from a full repo checkout after pnpm install, no package-local install, resolve tsdown/tsc from ../../node_modules), :33 (monorepo CI job name test-fsqlite), :91, and :236-241. Part C item 1 describes a constraint that CEASES TO EXIST on extraction and must be deleted rather than rewritten. Also fix the stale test counts (:35 and :100 claim 75 while its own Part A table sums to 73; the runner reports 75).
