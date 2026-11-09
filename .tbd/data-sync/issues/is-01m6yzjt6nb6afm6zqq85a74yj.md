---
type: is
id: is-01m6yzjt6nb6afm6zqq85a74yj
title: "PR #5 A3 (Low): `fsqlite/cli` publishes undocumented exports"
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
created_at: 2026-11-09T01:43:21.557Z
updated_at: 2026-11-09T01:59:33.962Z
started_at: 2026-11-09T01:48:24.718Z
---
Review A at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-5820620761

`packages/fsqlite/src/cli/main.ts:26,32,42,60,78,299` export `CliIo`, `processIo`, `EXIT`, `exitCodeForState`, `exitCodeForError`, and `main(argv, io)`. They all appear in `dist/cli/main.d.mts`. `packages/fsqlite/README.md:385-386` documents only `main(argv)`. In a PR whose goal is a deliberately narrowed public surface, these become compatibility obligations nobody chose.
**Fix (pick one):** document `main(argv, io?)`, `CliIo`, and `EXIT` as the in-process CLI contract and mark `processIo` and the two mapping functions `@internal`; or move the mapping helpers to a non-exported module that the tests import directly.
