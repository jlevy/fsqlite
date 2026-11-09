---
type: is
id: is-01m6yzjtffxp3n0x7nb9etvrwe
title: "PR #5 A4 (Low): usage errors ignore `--json`"
kind: task
status: in_progress
priority: 3
version: 2
delegate: codex@spud10
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
hold: null
hold_until: null
created_at: 2026-11-09T01:43:21.838Z
updated_at: 2026-11-09T01:48:24.725Z
started_at: 2026-11-09T01:48:24.725Z
---
Review A at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-PRR_kwDOS5UOe88AAAABWu-f2Q

`packages/fsqlite/src/cli/main.ts:300-312`: `main()` pre-computes `json` but the `UsageError` branch always prints text. `fsqlite info /x --json` prints `{"error":{"code":"not-a-store",...}}`. `fsqlite info --json` (a missing argument) prints `fsqlite: 'info' needs <dir>` as plain text. A script that parses stderr under `--json` gets two formats. The exit code (64) is still reliable, so this is Low.
**Fix:** when `json` is set, print usage errors as `{"error":{"code":"usage","message":...,"causes":[]}}` and add one golden for it.
