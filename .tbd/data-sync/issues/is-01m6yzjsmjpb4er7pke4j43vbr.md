---
type: is
id: is-01m6yzjsmjpb4er7pke4j43vbr
title: "PR #5 A1 (High): `in-flight` means \"safe to retry\" in one place and \"never retry\" in another, and the README's remedy re-applies a write"
kind: task
status: open
priority: 1
version: 1
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
created_at: 2026-11-09T01:43:20.977Z
updated_at: 2026-11-09T01:43:20.977Z
---
Review A at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-PRR_kwDOS5UOe88AAAABWu-f2Q

- `packages/fsqlite/src/errors.ts:27-28,54,62`: `in-flight` is documented as a mid-flight operation and is in `RETRYABLE_CODES`, so it defaults to `retryable: true`.
- `packages/fsqlite/src/errors.ts:170-194` and `packages/fsqlite/src/snapshotStore.ts:1058-1066`: `TransactionError` reuses code `in-flight` with `retryable: false` for a captured envelope that is still pending.
- `packages/fsqlite/README.md:451`: the `in-flight` row says "Wait, then retry (see `TransactionError`)".
