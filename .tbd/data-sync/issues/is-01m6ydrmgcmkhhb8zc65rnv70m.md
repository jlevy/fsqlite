---
type: is
id: is-01m6ydrmgcmkhhb8zc65rnv70m
title: Review and freeze the 1.0 public API surface
kind: feature
status: open
priority: 1
version: 4
spec_path: docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md
labels:
  - post-alpha
dependencies: []
parent_id: is-01kyxmrxxwhdr0a5f90akc73a4
created_at: 2026-11-08T20:31:57.964Z
updated_at: 2026-11-09T00:36:15.168Z
---
From the opus-docs.md bead table: a settled public API is on the 1.0 bar but had no bead. Review and freeze the public API surface before 1.0.

## Notes

2026-11-09 (PR #5 CLI/API pass, opus-ts T10): open API design calls for 1.0: SnapshotStore and DirectStore expose different write signatures; ReconcileResult.published is ambiguous (count vs version). Typed errors, @internal layout fields, named option types, planRepair(), disposable ReadLease, and the fsqlite/cli main() export already landed.
