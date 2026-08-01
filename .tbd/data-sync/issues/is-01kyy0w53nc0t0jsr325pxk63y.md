---
type: is
id: is-01kyy0w53nc0t0jsr325pxk63y
title: "Precommit review: close database when pragma setup fails"
kind: bug
status: closed
priority: 2
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - pr-review
dependencies: []
parent_id: is-01kyxzayw4jqyc0tty925kttr0
created_at: 2026-08-01T06:41:07.188Z
updated_at: 2026-08-01T06:51:35.546Z
closed_at: 2026-08-01T06:51:35.546Z
close_reason: Fixed in cac31b9 with explicit ledger columns, permanent conflict classification, post-fsync publication fencing and fault coverage, immutable merge pass order, database cleanup on pragma failure, and time-stable transient cleanup coverage.
---
driver.open constructs a DatabaseSync before running configuration pragmas. If a pragma throws, close the handle and rethrow the original setup error. Add or preserve focused coverage.
