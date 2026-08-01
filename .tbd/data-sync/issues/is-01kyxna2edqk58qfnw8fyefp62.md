---
type: is
id: is-01kyxna2edqk58qfnw8fyefp62
title: Complete concurrent backup and restore validation
kind: task
status: closed
priority: 1
version: 4
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase3
dependencies:
  - type: blocks
    target: is-01kyx9gpj0yvtab58tgxy5ezk1
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-08-01T03:19:00.297Z
updated_at: 2026-08-01T04:31:41.066Z
closed_at: 2026-08-01T04:31:41.066Z
close_reason: Completed the standalone public API, package documentation, format identity, backup validation, roadmap, claim guard, and release runbook; full local verification passes.
---
After the public backup surface is settled, test an online backup while writes are active, run integrity_check on the result, restore it into a fresh location, and verify a coherent committed state. Cover SnapshotStore seal/VACUUM INTO and DirectStore's sanctioned locked-copy path as applicable; never endorse raw copying of a mutable database.
