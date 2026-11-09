---
type: is
id: is-01m6yzk1n2gkxw8f929sjdtd8y
title: "PR #5 B3 (Medium): the DirectStore heartbeat test passes with the heartbeat removed"
kind: task
status: closed
priority: 2
version: 4
delegate: codex@spud10
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
hold: null
hold_until: null
created_at: 2026-11-09T01:43:29.185Z
updated_at: 2026-11-09T02:06:34.798Z
started_at: 2026-11-09T01:48:24.787Z
closed_at: 2026-11-09T02:06:34.798Z
close_reason: "Addressed in the reviewed 6d628b6 head. PRs #3 and #5 are merged into main at 40149ee. pnpm verify passed locally and all seven PR #5 checks passed."
resolution: null
duplicate_of: null
---
Review B at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-5820668230

`packages/fsqlite/test/direct.test.ts:352-390`; `packages/fsqlite/src/directStore.ts:152-154`, `:179`, `:183`.
Reverting `if (!lease.heartbeat()) return abandon()` after the copy leaves all 18 tests in `direct.test.ts` green. The test ages the lock inside the callback and after the build fsync, but both observation points (`fsyncPath` of the `.direct-` file and `fsyncDir` of `snapshots/`) come after the fences at `:179`/`:183` and inside `linkBuild`, which refresh the lock anyway. The step boundary the heartbeat guards, copy → callback, is never observed, so the only renewal the PR added (C8) has no proof; the fences were already there.
