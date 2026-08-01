---
type: is
id: is-01kyz4c2cwqcpaavmtzks07aew
title: "PR #1 review R2: Recognize common git push forms"
kind: bug
status: closed
priority: 2
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - pr-review
dependencies: []
parent_id: is-01kyz4bp2219yptgksss5enb4b
created_at: 2026-08-01T17:01:28.859Z
updated_at: 2026-08-01T17:17:07.717Z
closed_at: 2026-08-01T17:17:07.717Z
close_reason: "Fixed PR review: both configured closing hooks now locate the repository without git and recognize common direct, decorated, absolute-path, and multi-command push forms with hermetic positive and negative coverage."
---
Cursor Bugbot Medium finding 373bfa1f-a107-4390-b5e6-273956740b19 at .codex/tbd-closing-reminder.sh:20-21 and .claude/hooks/tbd-closing-reminder.sh:20-21. Recognize newline-separated git push commands, git -C <dir> push, and absolute-path git invocations without evaluating caller input; cover both hook copies.
