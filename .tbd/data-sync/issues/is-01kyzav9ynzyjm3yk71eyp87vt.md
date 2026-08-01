---
type: is
id: is-01kyzav9ynzyjm3yk71eyp87vt
title: "PR #1 review R1: Session hooks ignore PATH prefix"
kind: bug
status: closed
priority: 3
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - pr-review
dependencies: []
parent_id: is-01kyzatzypbfhfbw26azqcyhq8
created_at: 2026-08-01T18:54:39.572Z
updated_at: 2026-08-01T19:02:09.561Z
closed_at: 2026-08-01T19:02:09.560Z
close_reason: "Fixed: both SessionStart/PreCompact scripts now honor TBD_HOOK_PATH_PREFIX exactly like the closing hooks; a regression exercises Codex and Claude hooks with an explicit empty override and a shadow HOME-local binary."
---
Cursor Bugbot PR review R1 at 2026-08-01T18:53:29Z. Validate whether SessionStart and PreCompact tbd-session.sh resolve PATH differently from the closing reminder when TBD_HOOK_PATH_PREFIX is set, including empty. Reported locations: .claude/scripts/tbd-session.sh:9-11 and .codex/tbd-closing-reminder.sh:35-38. Add regression coverage and fix if confirmed.
