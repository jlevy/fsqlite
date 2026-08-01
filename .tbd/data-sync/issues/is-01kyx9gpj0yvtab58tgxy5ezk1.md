---
type: is
id: is-01kyx9gpj0yvtab58tgxy5ezk1
title: Publish 0.1.0 and verify a clean install from the registry
kind: task
status: in_progress
priority: 1
version: 7
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase3
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:52:54.592Z
updated_at: 2026-08-01T07:01:23.055Z
---
Publish unscoped fsqlite 0.1.0 from the jlevy npm owner account under the alpha dist-tag so an ordinary npm install does not select it by default. README must state plainly that the project and format are in an alpha phase, the API may move, and the cross-host concurrency gate is pending. Then verify: install from the registry into an empty ESM project, import the library, and run the CLI bin. This is the exit criterion for the whole epic.

## Notes

Release verification at 2026-08-01 07:01 PDT: PR #1 review is fully addressed, final CI is green, and the registry still returns 404 for fsqlite. Local npm authentication is unavailable: npm whoami returns E401 Unauthorized. The remaining owner action is npm login/authentication for jlevy, followed by the documented first publish under alpha, registry smoke, v0.1.0 tag, and tag-workflow verification.
