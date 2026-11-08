---
type: is
id: is-01kyx9gpj0yvtab58tgxy5ezk1
title: Publish 0.1.0 and verify a clean install from the registry
kind: task
status: open
priority: 1
version: 11
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase3
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:52:54.592Z
updated_at: 2026-11-08T20:33:15.752Z
---
Publish unscoped fsqlite 0.1.0 from the jlevy npm owner account under the alpha dist-tag so an ordinary npm install does not select it by default. README must state plainly that the project and format are in an alpha phase, the API may move, and the cross-host concurrency gate is pending. Then verify: install from the registry into an empty ESM project, import the library, and run the CLI bin. This is the exit criterion for the whole epic.

## Notes

Release verification at 2026-08-01 07:42 PDT: design-constraint revision 14af67b is pushed to PR #1, all eight push/PR CI jobs are green, no formal reviews or inline review threads exist, and the latest owner comment says nothing is outstanding. Local npm authentication remains unavailable: npm whoami returns E401 Unauthorized. The remaining owner action is npm login/authentication for jlevy, followed by the documented first publish under alpha, registry smoke, v0.1.0 tag, and tag-workflow verification.

Hold recorded 2026-08-01: keep publishing queued but do not authenticate, publish to npm, create the v0.1.0 tag, or trigger the release workflow until the user explicitly authorizes publication.

2026-11-08: release still on maintainer hold; blocked on the fsq-rz37 children it depends on (the P0/P1 correctness bugs, the dependency/CI refresh, the docs corrections, and the PR #3 integration)
