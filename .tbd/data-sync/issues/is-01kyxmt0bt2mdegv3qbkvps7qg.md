---
type: is
id: is-01kyxmt0bt2mdegv3qbkvps7qg
title: Implement Windows atomic publication and race validation
kind: feature
status: open
priority: 1
version: 1
spec_path: docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md
labels:
  - post-alpha
dependencies: []
parent_id: is-01kyxmrxxwhdr0a5f90akc73a4
created_at: 2026-08-01T03:10:13.881Z
updated_at: 2026-08-01T03:10:13.881Z
---
Use ReplaceFile or MoveFileEx replacement semantics for current and snapshot publication on Windows. Race multiple publishers through the actual primitive, run the packed package on supported Windows/architecture combinations, and add the results to the conformance matrix.
