---
type: is
id: is-01kyx98qbw638v53gpf5pd2pyy
title: Remove monorepo toolchain hacks from tsconfig and tsdown config
kind: task
status: open
priority: 1
version: 2
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase1
dependencies:
  - type: blocks
    target: is-01kyx98ted2c7qjf30ba4nre4m
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:48:33.275Z
updated_at: 2026-07-31T23:53:10.172Z
---
Delete the tsconfig typeRoots escape into ../../node_modules/.pnpm/@types+node@22.19.19/ and its rationale comment. Restore tsdown.config.ts to defineConfig (it is currently a plain object specifically to resolve without a package-local node_modules).
