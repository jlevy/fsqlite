---
type: is
id: is-01kyxmt1zdgx61xkcbmc14asyn
title: Evaluate rebaser support and upstream node:sqlite enhancements
kind: task
status: open
priority: 3
version: 3
spec_path: docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md
labels:
  - post-alpha
dependencies: []
parent_id: is-01kyxmrxxwhdr0a5f90akc73a4
created_at: 2026-08-01T03:10:15.533Z
updated_at: 2026-11-08T23:02:22.022Z
---
Evaluate SQLite rebaser use without making it a base-format requirement. Prepare upstream Node requests for conflict table context and rebaser exposure, then decide whether a later optional feature can use them while f1.0 remains implementable without them.

## Notes

2026-11-08: fable-research.md research section (c) item 10 sketches the upstream request: an apply_v3 filter, the change object passed to onConflict, and an optional rebaser, with APSW as precedent.

2026-11-08 (PR #5 core pass 2): also request SQLITE_DBCONFIG_ENABLE_TRIGGER (to allow trigger schemas in SnapshotStore reconcile) and the SQLITE_CHANGESETAPPLY_FKNOACTION apply flag from node:sqlite; fsqlite currently turns FK enforcement off on the build connection and rejects trigger schemas.
