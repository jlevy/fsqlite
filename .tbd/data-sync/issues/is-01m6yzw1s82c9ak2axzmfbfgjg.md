---
type: is
id: is-01m6yzw1s82c9ak2axzmfbfgjg
title: "PR #3 A1: qualify transient SQLite NFS lock errors in the README"
kind: task
status: closed
priority: 3
version: 3
delegate: codex@spud10
labels: []
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
hold: null
hold_until: null
created_at: 2026-11-09T01:48:24.231Z
updated_at: 2026-11-09T02:06:34.706Z
started_at: 2026-11-09T01:54:01.119Z
closed_at: 2026-11-09T02:06:34.706Z
close_reason: "Addressed in the reviewed 6d628b6 head. PRs #3 and #5 are merged into main at 40149ee. pnpm verify passed locally and all seven PR #5 checks passed."
resolution: null
duplicate_of: null
---
The cited VFS calls ENOLCK retryable. A timeout can ride out transient faults or contention, but cannot fix a persistent mount locking problem. Fold the README wording into PR #5 with the rest of #3.
