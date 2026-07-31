---
type: is
id: is-01kyx99v911n334wgvgy2ty8zn
title: repair() deletes every snapshot before discovering none is clean
kind: bug
status: open
priority: 0
version: 1
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase2
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:49:10.048Z
updated_at: 2026-07-31T23:49:10.048Z
---
snapshotStore.ts:759-767 unlinks each snapshot as it fails integrity_check, then throws 'no integrity-clean snapshot exists' - by which point all of them are gone. The operator is left with an empty store and no forensic evidence. A partially readable snapshot is often hand-salvageable; this removes that option and directly undercuts the R1 bounded-loss invariant the README advertises. Make the scan non-destructive: identify a good version first, delete only after.
