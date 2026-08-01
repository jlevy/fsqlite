---
type: is
id: is-01kyxmt1qt0vnytwrdcp5eqc5f
title: Expand fsinspect for shared-filesystem and sync diagnostics
kind: feature
status: open
priority: 2
version: 1
spec_path: docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md
labels:
  - post-alpha
dependencies: []
parent_id: is-01kyxmrxxwhdr0a5f90akc73a4
created_at: 2026-08-01T03:10:15.289Z
updated_at: 2026-08-01T03:10:15.289Z
---
Use evidence from the real shared-filesystem gate to add diagnostics for attribute caching, clock skew, close-to-open delay, and recognizable cloud-sync hazards. Keep the command diagnostic: it must never auto-select a weaker write strategy.
