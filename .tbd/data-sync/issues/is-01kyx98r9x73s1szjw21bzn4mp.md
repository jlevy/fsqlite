---
type: is
id: is-01kyx98r9x73s1szjw21bzn4mp
title: Add flowmark for Markdown and lefthook hooks
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
created_at: 2026-07-31T23:48:34.236Z
updated_at: 2026-07-31T23:53:10.188Z
---
flowmark for Markdown formatting. lefthook: pre-commit auto-fixes staged files sequentially with stage_fixed (parallel: false, since stage_fixed contends on .git/index.lock); pre-push runs the full verify-only gate. CI repeats the gate so a --no-verify commit cannot land unchecked.
