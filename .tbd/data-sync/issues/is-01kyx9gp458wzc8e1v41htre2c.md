---
type: is
id: is-01kyx9gp458wzc8e1v41htre2c
title: Wire a doc-claim drift guard
kind: task
status: closed
priority: 3
version: 2
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase3
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:52:54.148Z
updated_at: 2026-08-01T04:31:41.090Z
closed_at: 2026-08-01T04:31:41.090Z
close_reason: Completed the standalone public API, package documentation, format identity, backup validation, roadmap, claim guard, and release runbook; full local verification passes.
---
Prose test counts have already rotted three ways (runbook says 75, its own Part A table sums to 73, the research doc says 55 in four places; the runner reports 75). Add a CI check that asserts the counts claimed in docs match reality so this cannot silently recur.
