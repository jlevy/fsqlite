---
type: is
id: is-01kyx99wh698h6ezajbe6d0ee5
title: Classify permanent vs retryable failures in writeWithRetry
kind: bug
status: open
priority: 1
version: 1
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase2
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:49:11.333Z
updated_at: 2026-07-31T23:49:11.333Z
---
snapshotStore.ts:429-438 infers success from the ABSENCE of a quarantine marker (never confirms the tx reached the published snapshot's applied_tx ledger), and cannot distinguish a genuine strict-row conflict (retryable) from digest-mismatch, schema-version-mismatch, schema-hash-mismatch or envelope-too-large (all permanent, :490-514). It retries all five 5 times then reports 'persistent conflict', which is actively wrong for four of them. The real reason is already written into the QUARANTINE file at :834 - read it and carry it into the error.
