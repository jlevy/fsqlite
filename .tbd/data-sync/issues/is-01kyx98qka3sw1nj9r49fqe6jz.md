---
type: is
id: is-01kyx98qka3sw1nj9r49fqe6jz
title: Bring tsconfig to the guideline floor
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
created_at: 2026-07-31T23:48:33.513Z
updated_at: 2026-08-01T04:31:41.301Z
closed_at: 2026-08-01T04:31:41.300Z
close_reason: Completed the standalone toolchain and repository foundation with strict type/lint/format gates, local dev dependencies, metadata, and root documentation layout; full local verification passes.
---
Add noUncheckedIndexedAccess, noImplicitOverride, noImplicitReturns, noFallthroughCasesInSwitch, forceConsistentCasingInFileNames. Also erasableSyntaxOnly (Node type-stripping rejects enums/namespaces/parameter properties, so this makes it a compile error rather than a runtime surprise) and moduleResolution NodeNext (NOT Bundler: .ts specifiers are resolved by Node at runtime).
