---
type: is
id: is-01kyy0w5bqwz14smer6t0qbjze
title: "Precommit review: make transient cleanup test time-stable"
kind: task
status: closed
priority: 3
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - pr-review
dependencies: []
parent_id: is-01kyxzayw4jqyc0tty925kttr0
created_at: 2026-08-01T06:41:07.446Z
updated_at: 2026-08-01T06:51:35.552Z
closed_at: 2026-08-01T06:51:35.552Z
close_reason: Fixed in cac31b9 with explicit ledger columns, permanent conflict classification, post-fsync publication fencing and fault coverage, immutable merge pass order, database cleanup on pragma failure, and time-stable transient cleanup coverage.
---
DirectStore maintenance coverage relies on transientStaleMs zero and a same-tick mtime even though production uses a strict age comparison. Backdate the fixture and use a positive threshold so the test is stable on coarse filesystems.
