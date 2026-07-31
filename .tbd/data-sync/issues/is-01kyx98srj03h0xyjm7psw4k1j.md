---
type: is
id: is-01kyx98srj03h0xyjm7psw4k1j
title: Build standalone CI workflow with OS and Node matrix
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
created_at: 2026-07-31T23:48:35.728Z
updated_at: 2026-07-31T23:53:10.163Z
---
Replace the monorepo job that calls ../../node_modules/.bin/tsc, ../../node_modules/.bin/eslint and ../../node_modules/.pnpm/node_modules/.bin/tsdown. Matrix ubuntu + macos. Use pnpm/action-setup@v6 (v4 mishandles pnpm 11 ESM-only distribution). REQUIRED flags: --test-timeout (node:test has NO default timeout, so a wedged lock hangs to the 6-hour job ceiling) and --test-concurrency=2 (default is CPU count; on a 2-core runner the spawn-heavy files co-schedule dozens of processes and every timing budget shrinks). Verify-only commands throughout; never auto-fix in CI.
