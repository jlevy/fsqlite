---
type: is
id: is-01kyz5j2qwab5zvafnj6ypzxpe
title: "PR #1 review R1: Recognize pushes after shell keywords"
kind: bug
status: closed
priority: 2
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - pr-review
dependencies: []
parent_id: is-01kyz5hqnh3xm0qwmxje7bn3dz
created_at: 2026-08-01T17:22:14.395Z
updated_at: 2026-08-01T17:24:52.736Z
closed_at: 2026-08-01T17:24:52.735Z
close_reason: "Fixed PR review: the non-evaluating detector now preserves command-start recognition across shell control keywords and grouping boundaries, with positive and negative compound-shell regressions."
---
Cursor Bugbot Medium finding c53ccfd5-5d07-4b30-9575-1ec01a46afff at scripts/detect-git-push.mjs:108-166. Recognize git push commands that follow compound-shell keywords such as then and do without evaluating caller input; add positive and negative regression cases.
