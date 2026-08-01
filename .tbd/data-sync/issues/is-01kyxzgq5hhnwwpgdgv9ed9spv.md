---
type: is
id: is-01kyxzgq5hhnwwpgdgv9ed9spv
title: "PR #1 review D6: verify fsqlite identity after caller callback before publish"
kind: bug
status: open
priority: 2
version: 3
spec_path: docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md
labels:
  - post-alpha
  - pr-review
dependencies: []
parent_id: is-01kyxmrxxwhdr0a5f90akc73a4
created_at: 2026-08-01T06:17:23.888Z
updated_at: 2026-08-01T06:28:57.121Z
---
Owner engineering review D6. DirectStore passes a raw writable DatabaseSync to caller code and only runs quick_check before publishing (packages/fsqlite/src/directStore.ts:85-114); the callback can alter application_id, user_version, applied_tx, or fsqlite_meta without quick_check detecting it. Reassert format identity/reserved-table invariants on the candidate before fsync/rename, and add regressions for reserved metadata mutation and caller user_version changes.
