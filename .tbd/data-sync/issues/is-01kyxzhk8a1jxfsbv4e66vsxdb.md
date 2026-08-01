---
type: is
id: is-01kyxzhk8a1jxfsbv4e66vsxdb
title: "PR #1 review I8c: name applied_tx INSERT columns"
kind: task
status: closed
priority: 4
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels: []
dependencies: []
parent_id: is-01kyxzayw4jqyc0tty925kttr0
created_at: 2026-08-01T06:17:52.649Z
updated_at: 2026-08-01T06:51:35.514Z
closed_at: 2026-08-01T06:51:35.513Z
close_reason: Fixed in cac31b9 with explicit ledger columns, permanent conflict classification, post-fsync publication fencing and fault coverage, immutable merge pass order, database cleanup on pragma failure, and time-stable transient cleanup coverage.
---
Owner engineering review I8c. packages/fsqlite/src/snapshotStore.ts:613 prepares INSERT INTO applied_tx VALUES (?, ?), coupling the ledger write to DDL column order. Specify tx_id/applied_at (or actual schema names) explicitly and keep the ledger regression suite green.
