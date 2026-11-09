---
type: is
id: is-01m6yzk05g4vgewv02g3qzgk2h
title: "PR #5 C8: Restrict who can create `v*` tags. The `npm` environment accepts any `v*` tag, and the workflow that runs is the tagged commit's own `publish.yml`. So anyone with write access "
kind: task
status: open
priority: 3
version: 1
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
created_at: 2026-11-09T01:43:27.663Z
updated_at: 2026-11-09T01:43:27.663Z
---
Review C at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-PRR_kwDOS5UOe88AAAABWvARmw

  - a tag ruleset that limits `v*` creation to the owner, listed in Trusted Publishing step 1;
  - an ancestry check in the `build` job: `git merge-base --is-ancestor "$GITHUB_SHA" origin/main` (`fetch-depth: 0` is already set).
