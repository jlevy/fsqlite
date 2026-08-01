---
type: is
id: is-01kyxzh8dme2b2b3m4f5je6sw9
title: "PR #1 review I8a: make publishPointer temp creation cleanup failure-safe"
kind: bug
status: closed
priority: 3
version: 4
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels: []
dependencies: []
parent_id: is-01kyxzayw4jqyc0tty925kttr0
created_at: 2026-08-01T06:17:41.555Z
updated_at: 2026-08-01T06:31:41.576Z
closed_at: 2026-08-01T06:31:41.576Z
close_reason: Implemented with focused recovery and failure-path regression tests; the affected test files and focused lint pass.
---
Owner engineering review I8a. packages/fsqlite/src/fsutil.ts:36-41 writes a randomly named pointer temp without wx and does not remove it if write/fsync/rename fails, unlike marker and lease publication. Use exclusive creation and finally/catch cleanup; add injected fsync/rename failure coverage.
