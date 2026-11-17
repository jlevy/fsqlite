---
type: is
id: is-01m7m6hfavt5ym9nz0yf2x8wve
title: "PR #9 B1: the npx fallback runs get-tbd's unpinned third-party tree with no cool-off"
kind: bug
status: closed
priority: 2
version: 2
labels: []
dependencies: []
parent_id: is-01m7m6hdd644jqw5x1wwj4axxn
created_at: 2026-11-17T07:29:00.763Z
updated_at: 2026-11-17T08:15:24.896Z
closed_at: 2026-11-17T08:15:24.896Z
close_reason: "Fixed in 02d018a: all four launchers look up the pin's publish time with npm view --registry=https://registry.npmjs.org/ get-tbd@<pin> time --json, parse it with node, and pass --before=<time> plus --registry; a failed lookup fails closed. check-project-hooks.mjs mocks the lookup, asserts exact argv, and runs mutation checks. Real lookup returns 2026-10-02T07:04:22.880Z; a lockfile-only resolve at that bound gives 68 packages."
resolution: null
duplicate_of: null
---
Review B https://github.com/jlevy/fsqlite/pull/9#pullrequestreview-5934384031. Medium. .claude/scripts/tbd-session.sh:73-75, .claude/hooks/tbd-closing-reminder.sh:67-69, .codex copies, SUPPLY-CHAIN-SECURITY.md:83-85. Fix option 1: --before at the pin's publish time.
