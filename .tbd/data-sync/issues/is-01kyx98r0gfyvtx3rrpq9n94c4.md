---
type: is
id: is-01kyx98r0gfyvtx3rrpq9n94c4
title: Raise ESLint to the lint-format floor and add Prettier
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
created_at: 2026-07-31T23:48:33.935Z
updated_at: 2026-07-31T23:53:10.182Z
---
Current config sits below the floor: recommendedTypeChecked (needs strictTypeChecked + js.configs.recommended), curly multi-line (needs 'all'), and a brace-style rule that must be dropped as deprecated. There is no formatter at all. Add Prettier + eslint-config-prettier, ordered so floor rules are re-asserted AFTER the prettier entry or they are silently disabled. Verify with eslint --print-config that curly is severity 2. Keep the existing stricter additions (no-unsafe-* family, no dynamic import, no optional booleans).
