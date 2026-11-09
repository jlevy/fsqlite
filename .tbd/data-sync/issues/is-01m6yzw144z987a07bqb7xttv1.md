---
type: is
id: is-01m6yzw144z987a07bqb7xttv1
title: "PR #5 E1: preserve transaction identity when the post-capture ledger read fails"
kind: bug
status: closed
priority: 1
version: 3
delegate: codex@spud10
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
hold: null
hold_until: null
created_at: 2026-11-09T01:48:23.555Z
updated_at: 2026-11-09T02:06:34.825Z
started_at: 2026-11-09T01:54:01.099Z
closed_at: 2026-11-09T02:06:34.825Z
close_reason: "Addressed in the reviewed 6d628b6 head. PRs #3 and #5 are merged into main at 40149ee. pnpm verify passed locally and all seven PR #5 checks passed."
resolution: null
duplicate_of: null
---
Astra implementation review at f40a530. A retryable reconcile error or raw read error can escape after capture if disposition cannot be read. Preserve the captured transaction ID and report a non-retryable, uncertain outcome.
