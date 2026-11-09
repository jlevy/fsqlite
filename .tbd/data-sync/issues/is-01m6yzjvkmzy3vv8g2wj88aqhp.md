---
type: is
id: is-01m6yzjvkmzy3vv8g2wj88aqhp
title: "PR #5 A8 (Low): the PR description disagrees with the code and runbook in two places"
kind: task
status: open
priority: 3
version: 1
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
created_at: 2026-11-09T01:43:22.995Z
updated_at: 2026-11-09T01:43:22.995Z
---
Review A at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-PRR_kwDOS5UOe88AAAABWu-f2Q

- "Maintainer setup before the first release" lists configuring the npm trusted publisher, but `docs/releasing.md` (First Publish) correctly requires the owner's bootstrap `npm publish` of `0.1.0` first, because npm cannot attach a trusted publisher to a package that does not exist yet.
- "`fsinspect` … refuses overlayfs and tmpfs": the code refuses tmpfs, ramfs, and only `volatile` overlayfs. Other overlayfs mounts get a warning (`src/fsinspect.ts:453-476`), as the package README says.
