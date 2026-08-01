---
type: is
id: is-01kyxzgw7v31yehrbzzrmyp21q
title: "PR #1 review D7: reject unsafe schema-only writes instead of silently losing data"
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
created_at: 2026-08-01T06:17:29.082Z
updated_at: 2026-08-01T06:28:57.396Z
---
Owner engineering review D7. SnapshotStore.write documents schema-only as valid only for inserts of new keys (packages/fsqlite/src/snapshotStore.ts:461-465) but accepts arbitrary WorkFn at :467-499. UPDATE/DELETE against empty seed can yield no changeset; existing-key INSERT can capture a replaceable insert and clobber unseen columns under lww. Define/enforce a safe contract (e.g. inspect changeset and reject non-inserts; reject retry+schema-only) with tests for update, delete, and duplicate insert.
