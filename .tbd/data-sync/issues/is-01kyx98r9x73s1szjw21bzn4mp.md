---
type: is
id: is-01kyx98r9x73s1szjw21bzn4mp
title: Add flowmark for Markdown and lefthook hooks
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
created_at: 2026-07-31T23:48:34.236Z
updated_at: 2026-08-01T04:31:41.317Z
closed_at: 2026-08-01T04:31:41.317Z
close_reason: Completed the standalone toolchain and repository foundation with strict type/lint/format gates, local dev dependencies, metadata, and root documentation layout; full local verification passes.
---
flowmark for Markdown formatting. lefthook: pre-commit auto-fixes staged files sequentially with stage_fixed (parallel: false, since stage_fixed contends on .git/index.lock); pre-push runs the full verify-only gate. CI repeats the gate so a --no-verify commit cannot land unchecked.
