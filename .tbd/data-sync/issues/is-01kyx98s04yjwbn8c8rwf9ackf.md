---
type: is
id: is-01kyx98s04yjwbn8c8rwf9ackf
title: Add package metadata and correct LICENSE attribution
kind: task
status: open
priority: 2
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase1
dependencies:
  - type: blocks
    target: is-01kyx98ted2c7qjf30ba4nre4m
  - type: blocks
    target: is-01kyx9gpb1y0gkwhw9ze32913r
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:48:34.947Z
updated_at: 2026-07-31T23:53:10.385Z
---
package.json has no repository (with directory field for the workspace), homepage, bugs, or author. publint is already wired via tsdown and will demand them; npm provenance requires repository. Without it the README's relative doc links do not resolve on npmjs.com. LICENSE currently reads 'Copyright (c) 2026 finterm' while this repo is jlevy/fsqlite.
