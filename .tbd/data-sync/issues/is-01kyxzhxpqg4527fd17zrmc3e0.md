---
type: is
id: is-01kyxzhxpqg4527fd17zrmc3e0
title: "PR #1 review I8e: back off after failed stale lock break"
kind: bug
status: closed
priority: 3
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels: []
dependencies: []
parent_id: is-01kyxzayw4jqyc0tty925kttr0
created_at: 2026-08-01T06:18:03.350Z
updated_at: 2026-08-01T06:32:13.128Z
closed_at: 2026-08-01T06:32:13.128Z
close_reason: "Fixed on PR #1 branch with focused red-green coverage: writer opens assert rollback journal, FULL synchronous, foreign keys, and a bounded busy timeout; DirectStore forwards repair and transientStaleMs; the required-features predicate is accurately named; failed stale-lock removal backs off on pollMs. Focused affected suites and static checks pass."
---
Owner engineering review I8e. packages/fsqlite/src/lock.ts:96-112 immediately continues after rmSync of a stale lock; if removal fails/does not remove (e.g. EPERM/race), repeated EEXIST/stale attempts can spin until timeout. Treat failed stale break as a poll/backoff path and test it with a filesystem seam.
