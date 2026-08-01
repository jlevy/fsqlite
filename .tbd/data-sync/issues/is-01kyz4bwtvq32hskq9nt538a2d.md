---
type: is
id: is-01kyz4bwtvq32hskq9nt538a2d
title: "PR #1 review R1: Locate repository without git"
kind: bug
status: closed
priority: 2
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - pr-review
dependencies: []
parent_id: is-01kyz4bp2219yptgksss5enb4b
created_at: 2026-08-01T17:01:23.162Z
updated_at: 2026-08-01T17:17:07.703Z
closed_at: 2026-08-01T17:17:07.702Z
close_reason: "Fixed PR review: both configured closing hooks now locate the repository without git and recognize common direct, decorated, absolute-path, and multi-command push forms with hermetic positive and negative coverage."
---
Cursor Bugbot Medium finding c82b423d-fd82-47c8-962c-d128ff263b93 at .claude/hooks/tbd-closing-reminder.sh:20-24 and .codex/tbd-closing-reminder.sh:20-24. A detected push must not silently skip tbd closing when git or git rev-parse is unavailable; locate the store root from the installed hook path and cover both copies hermetically.
