---
type: is
id: is-01kyz86337d73wkx51xcqsm98y
title: "PR #1 follow-up R1: Isolate closing-hook test PATH"
kind: bug
status: closed
priority: 2
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - pr-review
dependencies: []
parent_id: is-01kyz61b5na6w5h0fgjszvv4y8
created_at: 2026-08-01T18:08:07.270Z
updated_at: 2026-08-01T18:11:36.179Z
closed_at: 2026-08-01T18:11:36.178Z
close_reason: "Fixed: the primary hook test environment now disables the hook's machine-local path prefix and a shadow-CLI regression proves the hermetic shim wins."
---
Owner follow-up at 2026-08-01T17:41:59Z reports that scripts/check-project-hooks.mjs hookEnv omits TBD_HOOK_PATH_PREFIX='', so the hook's default local path can select a real CLI ahead of the hermetic test shim. Validate against current head, add a regression-safe fix if confirmed, and record a fixed, rebutted, or deferred disposition.

## Notes

Confirmed independently: hookEnv lacks TBD_HOOK_PATH_PREFIX='', so a machine-local CLI under the hook's default prefix can shadow the hermetic shim. TDD regression reproduces the selection before the fix.
