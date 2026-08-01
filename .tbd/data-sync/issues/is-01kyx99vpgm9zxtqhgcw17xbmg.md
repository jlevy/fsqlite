---
type: is
id: is-01kyx99vpgm9zxtqhgcw17xbmg
title: Commit changeset data and its applied_tx ledger row in one transaction
kind: bug
status: closed
priority: 0
version: 2
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase2
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:49:10.479Z
updated_at: 2026-08-01T04:31:40.768Z
closed_at: 2026-08-01T04:31:40.768Z
close_reason: Implemented the correctness repair with focused regression coverage; the 95-case Node suite and full local verification gate pass.
---
snapshotStore.ts:516-527 applies the changeset in one transaction then writes the applied_tx row in a second. The module header at :18-20 asserts they are BOTH committed as a load-bearing invariant. If mark.run throws (PK collision, disk-full, SQLITE_BUSY) the tx is quarantined even though its data already committed; the build passes quickCheck and is published with the rows but no ledger entry, so any operator replay of that quarantined envelope double-applies it. Two-line fix restores the stated invariant.
