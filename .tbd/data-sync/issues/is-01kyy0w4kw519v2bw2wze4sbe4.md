---
type: is
id: is-01kyy0w4kw519v2bw2wze4sbe4
title: "Precommit review: revalidate publication fences after fsync"
kind: bug
status: closed
priority: 1
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - pr-review
dependencies: []
parent_id: is-01kyxzayw4jqyc0tty925kttr0
created_at: 2026-08-01T06:41:06.683Z
updated_at: 2026-08-01T06:51:35.534Z
closed_at: 2026-08-01T06:51:35.534Z
close_reason: Fixed in cac31b9 with explicit ledger columns, permanent conflict classification, post-fsync publication fencing and fault coverage, immutable merge pass order, database cleanup on pragma failure, and time-stable transient cleanup coverage.
---
DirectStore.write and SnapshotStore.reconcile must revalidate the pointer/OCC and owner token after potentially slow fsync work and immediately before each destructive snapshot rename and pointer swap. Add theft-during-fsync fault coverage.
