---
type: is
id: is-01m6yzjtrfwqrd07q2drzd0ssn
title: "PR #5 A5 (Low): three public names for one union, plus a compatibility field with no released consumer"
kind: task
status: open
priority: 3
version: 1
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
created_at: 2026-11-09T01:43:22.126Z
updated_at: 2026-11-09T01:43:22.126Z
---
Review A at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-PRR_kwDOS5UOe88AAAABWu-f2Q

`StoreRecognitionFailure` (`src/storeFormat.ts:39`), `StoreFormatErrorState` (`src/errors.ts:80`), and `StoreRecognitionState` (`src/types.ts:60`) are the same `'not-a-store' | 'invalid' | 'unsupported'` union, and all three are exported from the root. `StoreFormatError.state` duplicates `code` "for callers that already branch on it" (`src/errors.ts:82-84`). The package was never published, so there are no such callers (`backward-compatibility-rules`: DO NOT MAINTAIN).
**Fix:** keep one exported alias (for example `StoreRecognitionState`) and use it in all three places. Either drop `StoreFormatError.state` or narrow `code`'s type on the subclass, and remove the "kept for callers" wording.
