---
type: is
id: is-01m6yzjw5z38hf28a5bgxn95ey
title: "PR #5 A10: At 2,030 lines, `snapshotStore.ts` holds capture, reconcile, reads, leases, gc, validate, repair, planRepair, seal, and schema admission. A follow-up could move maintenance (v"
kind: task
status: open
priority: 3
version: 1
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
created_at: 2026-11-09T01:43:23.582Z
updated_at: 2026-11-09T01:43:23.582Z
---
Review A at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-PRR_kwDOS5UOe88AAAABWu-f2Q

  - the seven module-level `set*ForTest` seams in five files could live in one internal test-hooks module;
  - the `<hex10>` transient suffix is built in four places (`snapshotStore.ts:88`, `directStore.ts:52`, `fsutil.ts:74`, `lock.ts:274`), and spec §2 defines it, so it deserves one helper;
  - the "caller tables" `sqlite_schema` query is repeated three times (`validatePrimaryKeys`, `rejectKeyConflictResolution`, `assertPolicyTables`).
