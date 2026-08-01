---
type: is
id: is-01kyx98ted2c7qjf30ba4nre4m
title: Verify a clean-room install reproduces green from scratch
kind: task
status: closed
priority: 1
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase1
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:48:36.427Z
updated_at: 2026-08-01T04:33:32.064Z
closed_at: 2026-08-01T04:33:32.064Z
close_reason: A fresh no-node_modules clone of commit 69b5648 passed frozen install and the complete format, lint, typecheck, 95-test, 24-golden, build, publint, and packed-package smoke gate without npm config warnings.
---
Confirm pnpm install --frozen-lockfile followed by the full gate (format check, markdown check, zero-warning lint, tsc --noEmit, node:test suite, tryscript goldens, build with publint, package smoke test) passes from a fresh clone with nothing preinstalled. Remove the current nested-npm 'Unknown env config minimum-release-age/frozen-lockfile' warnings or use a toolchain-supported invocation, so clean-room success is warning-free. This is the exit criterion for Phase 1.
