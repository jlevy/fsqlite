---
type: is
id: is-01kyx98rm2gtzbsx08gg3gkbmm
title: Bring scripts/ into lint and typecheck scope
kind: task
status: open
priority: 2
version: 2
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase1
dependencies:
  - type: blocks
    target: is-01kyx98ted2c7qjf30ba4nre4m
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:48:34.561Z
updated_at: 2026-07-31T23:53:10.200Z
---
eslint.config.mjs ignores scripts/** and tsconfig includes only src/test/workers/examples, so scripts/package-smoke.mjs is neither linted nor typechecked despite being the ONLY test that proves the published contract.
