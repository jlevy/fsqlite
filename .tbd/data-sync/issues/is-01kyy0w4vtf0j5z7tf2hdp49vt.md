---
type: is
id: is-01kyy0w4vtf0j5z7tf2hdp49vt
title: "Precommit review: make merge pass order immutable"
kind: bug
status: closed
priority: 2
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - pr-review
dependencies: []
parent_id: is-01kyxzayw4jqyc0tty925kttr0
created_at: 2026-08-01T06:41:06.937Z
updated_at: 2026-08-01T06:51:35.539Z
closed_at: 2026-08-01T06:51:35.539Z
close_reason: Fixed in cac31b9 with explicit ledger columns, permanent conflict classification, post-fsync publication fencing and fault coverage, immutable merge pass order, database cleanup on pragma failure, and time-stable transient cleanup coverage.
---
The exported mutable ACTIONS array now controls normative reconciliation order. Keep the public vocabulary compatible but drive applyWithPolicy from a private frozen or readonly order that callers cannot mutate.
