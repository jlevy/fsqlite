---
type: is
id: is-01kyz0kb91cz9k4y1vnp3634e0
title: Enforce caller-schema identity before mutation
kind: bug
status: closed
priority: 1
version: 4
spec_path: docs/fsql-format-spec.md
labels:
  - design-review
dependencies: []
parent_id: is-01kyz0jk4e1tn8vfct59gw53ya
created_at: 2026-08-01T15:55:33.024Z
updated_at: 2026-08-01T16:30:42.352Z
closed_at: 2026-08-01T16:30:42.352Z
close_reason: Implemented, documented, and verified by the complete pnpm verify gate; independent final review found no remaining actionable design issue.
---
Validate schemaVersion as a non-negative signed-32-bit SQLite user_version integer before init creates any marker, directory, or snapshot. Require SnapshotStore and DirectStore write paths, plus reconciliation, to verify the configured exact schema identity before capturing, invoking callbacks, moving envelopes, or publishing. Add regressions for invalid numeric/runtime values and wrong-schema handles that skip init.
