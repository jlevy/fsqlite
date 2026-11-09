---
type: is
id: is-01m6yzjv1gh5vy0rbh0z1bgw8w
title: "PR #5 A6 (Low): the CHANGELOG's migration list leaves out several new rejections"
kind: task
status: open
priority: 3
version: 1
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
created_at: 2026-11-09T01:43:22.415Z
updated_at: 2026-11-09T01:43:22.415Z
---
Review A at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-PRR_kwDOS5UOe88AAAABWu-f2Q

`CHANGELOG.md:52-70`, "Changes From the July 2026 Repository Snapshot", lists trigger schemas, but code written against the snapshot will also hit these:
- `SnapshotStore` rejects key `ON CONFLICT REPLACE|IGNORE` clauses and nullable `INTEGER PRIMARY KEY DESC` keys;
- a `conflictPolicy` key that names no caller table now fails `init()` with `incompatible` (`snapshotStore.ts:708-743`);
