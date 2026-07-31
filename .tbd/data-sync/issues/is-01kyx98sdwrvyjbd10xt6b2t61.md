---
type: is
id: is-01kyx98sdwrvyjbd10xt6b2t61
title: Move format, design, runbook and research docs to repo-root docs/
kind: task
status: open
priority: 2
version: 1
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase1
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:48:35.387Z
updated_at: 2026-07-31T23:48:35.387Z
---
These span implementations rather than belonging to the Node library, so they live at repo-root docs/ rather than inside packages/fsqlite/. Move upstream-source-confirmations.md from the package root into docs/ as a spec/design appendix. Fix all cross-links, including the broken link at fsql-format-spec.md:492-493 whose text names the internal plan spec but points at fsqlite-design.md.
