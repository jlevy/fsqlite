---
type: is
id: is-01kyxzhczmm6kk6w29dens12p0
title: "PR #1 review I8b: rename required-features array validator accurately"
kind: task
status: closed
priority: 4
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels: []
dependencies: []
parent_id: is-01kyxzayw4jqyc0tty925kttr0
created_at: 2026-08-01T06:17:46.227Z
updated_at: 2026-08-01T06:32:13.120Z
closed_at: 2026-08-01T06:32:13.120Z
close_reason: "Fixed on PR #1 branch with focused red-green coverage: writer opens assert rollback journal, FULL synchronous, foreign keys, and a bounded busy timeout; DirectStore forwards repair and transientStaleMs; the required-features predicate is accurately named; failed stale-lock removal backs off on pollMs. Focused affected suites and static checks pass."
---
Owner engineering review I8b. packages/fsqlite/src/storeFormat.ts:15-17 names a predicate isNonEmptyStringArray even though an empty required_features array is valid and accepted. Rename to reflect array-of-nonempty-strings and retain the current valid-empty-array behavior in a test.
