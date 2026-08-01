---
type: is
id: is-01kyxzfgej0vdw8w621b4nn5ky
title: "PR #1 review RD1: assert DirectStore transaction pragmas and S5 side-file invariant"
kind: bug
status: closed
priority: 2
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels: []
dependencies: []
parent_id: is-01kyxzayw4jqyc0tty925kttr0
created_at: 2026-08-01T06:16:44.241Z
updated_at: 2026-08-01T06:32:13.103Z
closed_at: 2026-08-01T06:32:13.102Z
close_reason: "Fixed on PR #1 branch with focused red-green coverage: writer opens assert rollback journal, FULL synchronous, foreign keys, and a bounded busy timeout; DirectStore forwards repair and transientStaleMs; the required-features predicate is accurately named; failed stale-lock removal backs off on pollMs. Focused affected suites and static checks pass."
---
Owner engineering review RD1. packages/fsqlite/src/driver.ts:21-24 opens a bare DatabaseSync, while DirectStore relies on inherited defaults for journal mode, sync, FK enforcement, and busy timeout; docs/fsql-format-spec.md:162-165 makes WAL/SHM absence normative (S5). Decide a portable explicit pragma contract (at least rollback-journal mode and foreign keys) and test that a DirectStore write leaves no -wal/-shm and preserves expected constraint behavior.
