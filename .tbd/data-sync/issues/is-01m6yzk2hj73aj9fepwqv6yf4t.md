---
type: is
id: is-01m6yzk2hj73aj9fepwqv6yf4t
title: "PR #5 B6 (Low): `init()` refuses after a first open that crashed between the snapshot-0 commit and the pointer publish, and the comment says that cannot happen"
kind: task
status: in_progress
priority: 3
version: 3
delegate: codex@spud10
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
hold: null
hold_until: null
created_at: 2026-11-09T01:43:30.097Z
updated_at: 2026-11-09T01:59:40.231Z
started_at: 2026-11-09T01:54:01.140Z
---
Review B at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-5820668230

`packages/fsqlite/src/snapshotStore.ts:598-601`, `:635-641`; `docs/fsql-format-spec.md:239-244`.
A crash between `linkSync(tmp, snapshotPath(0))` and `publishPointer` leaves snapshot 0 and no `current`. Every later `init()` throws `corrupt: refusing to initialize … run repair` until an operator runs `repair()`, which re-points to 0 (reproduced, `init-crashed-first-open.ts`). This matches the spec ("Only a marked store with no snapshot … may be initialized again"), so the behaviour is a defensible fail-closed choice, but the comment "a first open … leaves no snapshot" is false, and a brand-new store that crashed at the wrong millisecond needs an operator action its error message attributes to a lost pointer.
