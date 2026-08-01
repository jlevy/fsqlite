---
type: is
id: is-01kyxmtrtfxf2sh0badg29wqth
title: Verify and register the fsqlite SQLite application_id
kind: task
status: closed
priority: 1
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase3
dependencies:
  - type: blocks
    target: is-01kyx9gpj0yvtab58tgxy5ezk1
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-08-01T03:10:38.926Z
updated_at: 2026-08-01T04:31:41.059Z
closed_at: 2026-08-01T04:31:41.059Z
close_reason: Completed the standalone public API, package documentation, format identity, backup validation, roadmap, claim guard, and release runbook; full local verification passes.
---
Reserve PRAGMA application_id 0x4653514C (ASCII FSQL) for fsqlite snapshots. Verify it does not collide with SQLite's published application-id registry, submit or document the registry request as appropriate, remove caller override from the public API, and test that every snapshot and sealed export carries the fixed value.
