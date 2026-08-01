---
type: is
id: is-01kyxzgq5hhnwwpgdgv9ed9spv
title: "PR #1 review D6: verify fsqlite identity after caller callback before publish"
kind: bug
status: closed
priority: 1
version: 5
spec_path: docs/fsqlite-design.md
labels:
  - pr-review
  - pre-release
dependencies: []
parent_id: is-01kyy2a72arphq93y0ds49ps2r
created_at: 2026-08-01T06:17:23.888Z
updated_at: 2026-08-01T07:38:23.612Z
closed_at: 2026-08-01T07:38:23.611Z
close_reason: Protected callback-owned metadata and schema boundaries, revalidated complete candidate identity before publication, rejected forged reserved-table envelopes, and added regression coverage.
---
Owner engineering review D6. DirectStore passes a raw writable DatabaseSync to caller code and only runs quick_check before publishing (packages/fsqlite/src/directStore.ts:85-114); the callback can alter application_id, user_version, applied_tx, or fsqlite_meta without quick_check detecting it. Reassert format identity/reserved-table invariants on the candidate before fsync/rename, and add regressions for reserved metadata mutation and caller user_version changes.
