---
type: is
id: is-01kyz3mhppyqgtb2pzk3bj89ms
title: "PR #1 review R1: Fail closing hooks when no CLI is available"
kind: bug
status: closed
priority: 2
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - pr-review
dependencies: []
parent_id: is-01kyz3mbeqn31d9c1v1n63079r
created_at: 2026-08-01T16:48:38.101Z
updated_at: 2026-08-01T16:55:39.312Z
closed_at: 2026-08-01T16:55:39.311Z
close_reason: "Fixed PR review: both closing hooks now fail with install guidance when no CLI is available, preserve tbd and npx failures, and have hermetic regression coverage."
---
Cursor Bugbot Medium finding 56936955-ecae-43a0-841e-326f9c4ac59b at .claude/hooks/tbd-closing-reminder.sh:27-36 and .codex/tbd-closing-reminder.sh:27-36. When a git push matches and .tbd exists, emit install guidance and fail if neither tbd nor the pinned npx fallback exists. Cover both generated hook copies without using the network.
