---
type: is
id: is-01kyxzgw7v31yehrbzzrmyp21q
title: "PR #1 review D7: reject unsafe schema-only writes instead of silently losing data"
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
created_at: 2026-08-01T06:17:29.082Z
updated_at: 2026-08-01T07:38:23.811Z
closed_at: 2026-08-01T07:38:23.810Z
close_reason: Removed schema-only seeding from f1.0 so every callback observes the complete immutable base snapshot and its rows and constraints; updated API, benchmark, tests, spec, and design.
---
Owner engineering review D7. SnapshotStore.write documents schema-only as valid only for inserts of new keys (packages/fsqlite/src/snapshotStore.ts:461-465) but accepts arbitrary WorkFn at :467-499. UPDATE/DELETE against empty seed can yield no changeset; existing-key INSERT can capture a replaceable insert and clobber unseen columns under lww. Define/enforce a safe contract (e.g. inspect changeset and reject non-inserts; reject retry+schema-only) with tests for update, delete, and duplicate insert.
