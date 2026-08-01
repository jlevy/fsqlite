---
type: is
id: is-01kyxzga9evzgswq5dp18za0wr
title: "PR #1 review D5c: surface and sweep root-level transient files"
kind: bug
status: closed
priority: 3
version: 4
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels: []
dependencies: []
parent_id: is-01kyxzayw4jqyc0tty925kttr0
created_at: 2026-08-01T06:17:10.701Z
updated_at: 2026-08-01T06:31:41.568Z
closed_at: 2026-08-01T06:31:41.568Z
close_reason: Implemented with focused recovery and failure-path regression tests; the affected test files and focused lint pass.
---
Owner engineering review D5c. publishPointer writes current.<hex>.tmp (packages/fsqlite/src/fsutil.ts:36-41) and createStoreMarker writes fsqlite.json.<uuid>.tmp (storeFormat.ts:147-165). These satisfy docs/fsql-format-spec.md:113-116 transient grammar, but gc sweeps only snapshots/pending (snapshotStore.ts:779-799), validate only reports those dirs (:865-874), and repair only deletes those dirs (:1069-1080). Include root transients consistently or explicitly narrow the normative grammar; test leaked pointer/marker temps.
