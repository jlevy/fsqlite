---
type: is
id: is-01m6yzk1bv2dnv1r4c2j3fff20
title: "PR #5 B2 (Medium): `seal()` replacing an existing destination corrupts the export when a hot SQLite journal sits beside it"
kind: task
status: open
priority: 2
version: 1
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
created_at: 2026-11-09T01:43:28.890Z
updated_at: 2026-11-09T01:43:28.890Z
---
Review B at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-PRR_kwDOS5UOe88AAAABWvBZRg

`packages/fsqlite/src/snapshotStore.ts:1699-1701`; `packages/fsqlite/README.md:425-427`; `docs/fsql-format-spec.md:739-746`.
SQLite pairs a rollback journal with its database by name. If `dest` was a live SQLite database whose writer crashed, `dest-journal` is hot. `seal()` renames the fsynced export over `dest`, and the first open of the export replays the old journal's pages into the new file. Reproduced (`seal-hot-journal.ts`): `seal returned; export passed its integrity check before the rename`, then the first open fails with `database disk image is malformed` (SQLITE_CORRUPT 11). The README's promise that the destination "holds either the previous file or the complete export" does not hold, and a backup that turns to garbage on first open is the failure a conforming backup exists to prevent. The precondition (a hot journal beside a path someone chose as an export target) is unusual, so Medium.
