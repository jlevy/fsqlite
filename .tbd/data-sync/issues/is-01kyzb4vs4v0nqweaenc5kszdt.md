---
type: is
id: is-01kyzb4vs4v0nqweaenc5kszdt
title: "PR #1 review R2: PreCompact check can contact npm"
kind: bug
status: closed
priority: 2
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - pr-review
dependencies: []
parent_id: is-01kyzatzypbfhfbw26azqcyhq8
created_at: 2026-08-01T18:59:52.739Z
updated_at: 2026-08-01T19:02:09.781Z
closed_at: 2026-08-01T19:02:09.780Z
close_reason: "Fixed: removed the contributor-environment PreCompact spawn and replaced it with hermetic Codex/Claude SessionStart and PreCompact coverage that controls HOME and PATH and proves the npx fallback is not contacted."
---
Owner review reply at 2026-08-01T18:59:01Z. The standalone Claude PreCompact assertion inherits the contributor environment and can fall through to npx, causing pnpm verify to contact the registry or fail offline. Replace or subsume it with a hermetic hook test that controls HOME, PATH, and TBD_HOOK_PATH_PREFIX, then verify all session entry points.
