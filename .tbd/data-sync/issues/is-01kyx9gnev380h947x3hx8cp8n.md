---
type: is
id: is-01kyx9gnev380h947x3hx8cp8n
title: Scrub the research doc for public release
kind: task
status: open
priority: 2
version: 1
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase3
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:52:53.466Z
updated_at: 2026-07-31T23:52:53.466Z
---
1529 lines, valuable and mostly public-safe, but: attic/ paths at :536, :1109, :1376, :1407-1428, :1508, :1512-1520; citations to an unpublished internal survey at :67-68, :254, :1097, :1371, :1498-1500; references to a SOURCES.md that does not exist at :608 and :1357 (now upstream-source-confirmations.md); stale '55 tests' at :68, :788, :1063, :1366 (actual is 75); an already-answered Next Step at :1344 about whether to extract the package; explicit monorepo path at :1523-1524. Make an explicit keep-or-generalize call on the beads/tbd anecdote at :427-435. Add a status line marking it as dated background not updated with the implementation.
