---
type: is
id: is-01kyyyjfvmmfpm8m623fj40yj3
title: "PR #1 review R1: resolve Codex hooks from the repository root"
kind: bug
status: closed
priority: 3
version: 3
labels:
  - pr-review
dependencies: []
parent_id: is-01kyyyj9wq430ffygd94qmj7dj
created_at: 2026-08-01T15:20:07.795Z
updated_at: 2026-08-01T15:24:00.846Z
closed_at: 2026-08-01T15:24:00.846Z
close_reason: "Fixed in 1b77d1e: every Codex hook resolves its script from the Git root, and pnpm verify now enforces the behavior from packages/fsqlite."
---
Cursor Bugbot review R1 at .codex/hooks.json:44 (https://github.com/jlevy/fsqlite/pull/1#discussion_r3695873020): Codex hook commands use repository-relative .codex paths but execute from the session current directory, so a Bash tool run from packages/fsqlite can leave PostToolUse unable to locate .codex/tbd-closing-reminder.sh. Independently reproduce, fix every affected Codex hook entry, add a regression check, and account for tbd 0.4.2 setup regeneration.
