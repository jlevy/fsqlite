---
type: is
id: is-01kyx98qbw638v53gpf5pd2pyy
title: Remove inherited toolchain hacks from tsconfig and tsdown config
kind: task
status: open
priority: 1
version: 4
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase1
dependencies:
  - type: blocks
    target: is-01kyx98ted2c7qjf30ba4nre4m
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:48:33.275Z
updated_at: 2026-08-01T03:15:21.174Z
---
Remove standalone-hostile toolchain assumptions. The hardcoded tsconfig typeRoots path has been removed and package-local @types/node resolution now typechecks; restore tsdown.config.ts to defineConfig and validate build resolution from the workspace install.
