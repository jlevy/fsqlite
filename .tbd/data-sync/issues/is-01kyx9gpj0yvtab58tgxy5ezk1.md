---
type: is
id: is-01kyx9gpj0yvtab58tgxy5ezk1
title: Publish 0.1.0-alpha.1 and verify a clean install from the registry
kind: task
status: open
priority: 1
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase3
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:52:54.592Z
updated_at: 2026-08-01T04:52:26.736Z
---
Publish under the alpha dist-tag so 'npm install fsqlite' does not resolve to it by default. README must state plainly that the format is draft, the API may move, and the cross-host concurrency gate is pending. Then verify: install from the registry into an empty ESM project, import the library, run the CLI bin. This is the exit criterion for the whole epic.
