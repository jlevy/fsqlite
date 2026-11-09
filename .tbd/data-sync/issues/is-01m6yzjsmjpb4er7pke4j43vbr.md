---
type: is
id: is-01m6yzjsmjpb4er7pke4j43vbr
title: "PR #5 A1 (High): `in-flight` means \"safe to retry\" in one place and \"never retry\" in another, and the README's remedy re-applies a write"
kind: task
status: closed
priority: 1
version: 4
delegate: codex@spud10
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
hold: null
hold_until: null
created_at: 2026-11-09T01:43:20.977Z
updated_at: 2026-11-09T02:06:34.717Z
started_at: 2026-11-09T01:48:24.701Z
closed_at: 2026-11-09T02:06:34.717Z
close_reason: "Addressed in the reviewed 6d628b6 head. PRs #3 and #5 are merged into main at 40149ee. pnpm verify passed locally and all seven PR #5 checks passed."
resolution: null
duplicate_of: null
---
Review A at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-5820620761

- `packages/fsqlite/src/errors.ts:27-28,54,62`: `in-flight` is documented as a mid-flight operation and is in `RETRYABLE_CODES`, so it defaults to `retryable: true`.
- `packages/fsqlite/src/errors.ts:170-194` and `packages/fsqlite/src/snapshotStore.ts:1058-1066`: `TransactionError` reuses code `in-flight` with `retryable: false` for a captured envelope that is still pending.
- `packages/fsqlite/README.md:451`: the `in-flight` row says "Wait, then retry (see `TransactionError`)".
