---
type: is
id: is-01m6ydqs3ean811mzvdqx8pzzs
title: Prevent overlapping publishers from clobbering in-flight or published snapshots
kind: bug
status: closed
priority: 0
version: 4
delegate: codex@spud10
labels: []
dependencies:
  - type: blocks
    target: is-01kyx9gpj0yvtab58tgxy5ezk1
parent_id: is-01m6yd8g37a4pkt9xb3pw7x8tf
hold: null
hold_until: null
created_at: 2026-11-08T20:31:29.902Z
updated_at: 2026-11-09T02:06:34.686Z
started_at: 2026-11-09T01:43:20.833Z
closed_at: 2026-11-09T02:06:34.671Z
close_reason: "Addressed in the reviewed 6d628b6 head. PRs #3 and #5 are merged into main at 40149ee. pnpm verify passed locally and all seven PR #5 checks passed."
resolution: null
duplicate_of: null
---
From fable-core.md finding C1: after a stale-lock break, an overlapping publisher's replacing rename over snapshots/<N+1> can lose committed envelopes while reporting success, in both SnapshotStore reconcile and DirectStore. In-format fix: commit snapshots with a no-replace link, check inode identity before the pointer swap (and after it for DirectStore), and make F6 ledger-verified. The structural follow-up (unique snapshot filenames, f1.1) is tracked under fsq-2hpr.
