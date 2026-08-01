---
type: is
id: is-01kyxrnjkxmms31gewd53g9skq
title: Validate envelope tx_id against its directory name
kind: bug
status: closed
priority: 1
version: 2
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase2
  - review-finding
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-08-01T04:17:43.036Z
updated_at: 2026-08-01T04:31:40.813Z
closed_at: 2026-08-01T04:31:40.813Z
close_reason: Implemented the correctness repair with focused regression coverage; the 95-case Node suite and full local verification gate pass.
---
Precommit review found reconcile trusts manifest.tx_id without checking that it equals the <txid>.txn directory name required by f1.0. A mismatched envelope can apply data while stamping a different ledger identity. Quarantine it before apply and add a regression test.
