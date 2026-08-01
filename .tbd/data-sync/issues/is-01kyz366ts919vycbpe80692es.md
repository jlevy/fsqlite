---
type: is
id: is-01kyz366ts919vycbpe80692es
title: "PR #1 review R1: Remove silent jq dependency from closing hooks"
kind: bug
status: closed
priority: 3
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - pr-review
dependencies: []
parent_id: is-01kyz35wkhe6qef79gcvpd0dy3
created_at: 2026-08-01T16:40:48.217Z
updated_at: 2026-08-01T16:47:53.059Z
closed_at: 2026-08-01T16:47:53.059Z
close_reason: Fixed in ffb917b with Node-based parsing, explicit malformed-input failure, and regressions for both generated hook copies; local and GitHub gates passed and the inline thread was answered and resolved.
---
Cursor Bugbot Low finding c7ef453d-be53-4341-b973-005d6af9b18d at .claude/hooks/tbd-closing-reminder.sh:4-6 and .codex/tbd-closing-reminder.sh:4-6. Validate that missing jq or malformed input currently exits successfully without running tbd closing. Replace the silent dependency or fail explicitly, and add a regression for both generated hook copies.
