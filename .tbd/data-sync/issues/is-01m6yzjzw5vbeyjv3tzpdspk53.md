---
type: is
id: is-01m6yzjzw5vbeyjv3tzpdspk53
title: "PR #5 C7: Assert the effective pnpm policy floor. `scripts/check-supply-chain.mjs` checks audit ignores and trust-policy exclusions, but not the settings they depend on. Any of these edi"
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
created_at: 2026-11-09T01:43:27.364Z
updated_at: 2026-11-09T01:59:38.751Z
started_at: 2026-11-09T01:48:24.833Z
---
Review C at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-5820649883

  - `minimumReleaseAge: 0`;
  - adding `minimumReleaseAgeExclude`;
  - dropping `trustPolicy`, `strictDepBuilds`, or `blockExoticSubdeps`;
