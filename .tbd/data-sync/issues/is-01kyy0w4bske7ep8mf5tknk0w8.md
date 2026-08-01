---
type: is
id: is-01kyy0w4bske7ep8mf5tknk0w8
title: "Precommit review: distinguish permanent merge conflicts from retryable strict conflicts"
kind: bug
status: closed
priority: 1
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - pr-review
dependencies: []
parent_id: is-01kyxzayw4jqyc0tty925kttr0
created_at: 2026-08-01T06:41:06.424Z
updated_at: 2026-08-01T06:51:35.527Z
closed_at: 2026-08-01T06:51:35.527Z
close_reason: Fixed in cac31b9 with explicit ledger columns, permanent conflict classification, post-fsync publication fencing and fault coverage, immutable merge pass order, database cleanup on pragma failure, and time-stable transient cleanup coverage.
---
A nonreplaceable NOTFOUND, CONSTRAINT, or FOREIGN_KEY conflict is permanent for an envelope but currently becomes StrictConflictError, so writeWithRetry can rerun caller code unnecessarily. Add a distinct permanent conflict error or equivalent classification and a public writeWithRetry regression.
