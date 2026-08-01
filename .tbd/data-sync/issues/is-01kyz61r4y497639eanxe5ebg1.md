---
type: is
id: is-01kyz61r4y497639eanxe5ebg1
title: "PR #1 review R2: Eval and builtin push detection"
kind: bug
status: closed
priority: 3
version: 5
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - pr-review
dependencies: []
parent_id: is-01kyz61b5na6w5h0fgjszvv4y8
created_at: 2026-08-01T17:30:47.837Z
updated_at: 2026-08-01T18:11:36.395Z
closed_at: 2026-08-01T18:11:36.395Z
close_reason: "Fixed after owner correction: literal unquoted eval is recognized as a lexical command decorator, with positive and opaque or non-push negative regressions. Quoted and dynamically constructed eval programs remain intentionally outside the detector boundary."
---
Cursor Bugbot Medium finding 2100c1f3-82f8-4809-8bd9-9014103db73f at scripts/detect-git-push.mjs:119-177. Validate eval and builtin examples and determine whether indirect code evaluation belongs in the safe lexical detector.

## Notes

Owner follow-up at 2026-08-01T17:42:24Z correctly distinguishes literal eval git push from quoted or dynamically constructed eval input. Reopened for independent validation and explicit disposition.
