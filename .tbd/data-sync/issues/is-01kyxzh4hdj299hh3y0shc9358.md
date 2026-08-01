---
type: is
id: is-01kyxzh4hdj299hh3y0shc9358
title: "PR #1 review I7: complete DirectStore maintenance API option forwarding"
kind: bug
status: closed
priority: 3
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels: []
dependencies: []
parent_id: is-01kyxzayw4jqyc0tty925kttr0
created_at: 2026-08-01T06:17:37.580Z
updated_at: 2026-08-01T06:32:13.113Z
closed_at: 2026-08-01T06:32:13.113Z
close_reason: "Fixed on PR #1 branch with focused red-green coverage: writer opens assert rollback journal, FULL synchronous, foreign keys, and a bounded busy timeout; DirectStore forwards repair and transientStaleMs; the required-features predicate is accurately named; failed stale-lock removal backs off on pollMs. Focused affected suites and static checks pass."
---
Owner engineering review I7. DirectStore delegates several methods but lacks repair(), and gc only accepts retain/leaseStaleMs (packages/fsqlite/src/directStore.ts:38-62) although SnapshotStore.gc also accepts transientStaleMs (snapshotStore.ts:748-752). Add coherent DirectStore maintenance parity or document intentional exclusions; test repair delegation and transient stale option forwarding.
