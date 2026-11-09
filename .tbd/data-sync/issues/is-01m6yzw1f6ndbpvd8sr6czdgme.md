---
type: is
id: is-01m6yzw1f6ndbpvd8sr6czdgme
title: "PR #5 E2: refuse stale lock takeover across the pointer rename and snapshot reclamation"
kind: bug
status: closed
priority: 0
version: 3
delegate: codex@spud10
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
hold: null
hold_until: null
created_at: 2026-11-09T01:48:23.909Z
updated_at: 2026-11-09T02:06:34.830Z
started_at: 2026-11-09T01:54:01.109Z
closed_at: 2026-11-09T02:06:34.830Z
close_reason: "Addressed in the reviewed 6d628b6 head. PRs #3 and #5 are merged into main at 40149ee. pnpm verify passed locally and all seven PR #5 checks passed."
resolution: null
duplicate_of: null
---
Astra architecture review at f40a530. A contender can observe an unreferenced stale slot, pause before unlink, then replace a snapshot after the previous holder published and returned. A paused publisher can also regress current. Age-based takeover cannot fence unconditional filesystem operations.
