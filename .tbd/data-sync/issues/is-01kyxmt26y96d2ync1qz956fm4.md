---
type: is
id: is-01kyxmt26y96d2ync1qz956fm4
title: Decide future base_version staleness semantics
kind: task
status: open
priority: 3
version: 1
spec_path: docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md
labels:
  - post-alpha
dependencies: []
parent_id: is-01kyxmrxxwhdr0a5f90akc73a4
created_at: 2026-08-01T03:10:15.773Z
updated_at: 2026-08-01T03:10:15.773Z
---
Keep base_version provenance-only in f1.0. Measure useful staleness diagnostics and decide whether a later minor format should add warnings or policy, ensuring older readers can reject any newly required semantics through required_features.
