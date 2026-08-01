---
type: is
id: is-01kyyyz5h8fzeaaw552g6sknfg
title: "PR #1 review R2: resolve Claude hooks from the project root"
kind: bug
status: closed
priority: 2
version: 4
labels:
  - pr-review
dependencies: []
parent_id: is-01kyyyyy4sa4s7y98f4wecrg5d
created_at: 2026-08-01T15:27:03.207Z
updated_at: 2026-08-01T15:29:18.397Z
closed_at: 2026-08-01T15:29:18.396Z
close_reason: "Fixed in 01c8ff4: Claude lifecycle hooks resolve from CLAUDE_PROJECT_DIR, and pnpm verify exercises PreCompact from packages/fsqlite."
---
Cursor Bugbot review R2 at .claude/settings.json:30 (https://github.com/jlevy/fsqlite/pull/1#discussion_r3695908169): Claude SessionStart and PreCompact commands use relative .claude script paths, so they can fail if the hook cwd is not the repository root. Validate against the existing CLAUDE_PROJECT_DIR convention, fix every affected Claude command, extend the project-hook regression check, and account for tbd 0.4.2 setup regeneration.
