---
type: is
id: is-01kyx98rm2gtzbsx08gg3gkbmm
title: Bring scripts/ into lint and typecheck scope
kind: task
status: closed
priority: 2
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase1
dependencies:
  - type: blocks
    target: is-01kyx98ted2c7qjf30ba4nre4m
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:48:34.561Z
updated_at: 2026-08-01T04:31:41.322Z
closed_at: 2026-08-01T04:31:41.322Z
close_reason: Completed the standalone toolchain and repository foundation with strict type/lint/format gates, local dev dependencies, metadata, and root documentation layout; full local verification passes.
---
eslint.config.mjs ignores scripts/** and tsconfig includes only src/test/workers/examples, so scripts/package-smoke.mjs is neither linted nor typechecked despite being the ONLY test that proves the published contract.
