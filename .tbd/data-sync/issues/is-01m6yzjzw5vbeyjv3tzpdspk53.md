---
type: is
id: is-01m6yzjzw5vbeyjv3tzpdspk53
title: "PR #5 C7: Assert the effective pnpm policy floor. `scripts/check-supply-chain.mjs` checks audit ignores and trust-policy exclusions, but not the settings they depend on. Any of these edi"
kind: task
status: open
priority: 3
version: 1
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
created_at: 2026-11-09T01:43:27.364Z
updated_at: 2026-11-09T01:43:27.364Z
---
Review C at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-PRR_kwDOS5UOe88AAAABWvARmw

  - `minimumReleaseAge: 0`;
  - adding `minimumReleaseAgeExclude`;
  - dropping `trustPolicy`, `strictDepBuilds`, or `blockExoticSubdeps`;
