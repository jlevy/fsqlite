---
type: is
id: is-01kyx9gnnxt3y62ej73wxr5h5f
title: Scrub the format spec and reframe attic/ in upstream-source-confirmations
kind: task
status: open
priority: 2
version: 1
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase3
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:52:53.692Z
updated_at: 2026-07-31T23:52:53.692Z
---
Format spec: :4 (tracks the reference implementation at packages/fsqlite/), :54-55 and :465 (first-consumer heritage, folded into the O1 decision), :492-493 (link text names the internal plan spec but the target is fsqlite-design.md - broken AND internal), :495 (relative path breaks once the file moves into docs/). upstream-source-confirmations.md: :4 mislabels fsqlite-design.md as 'spec'; :7-19 and the section headings at :21, :81, :132, :170 frame attic/ via an internal agent workflow name - reframe as a reproducible 'clone these repos at these commits into a local scratch dir' instruction so an outside reviewer can re-verify; :224 refers to monorepo Phase-2 numbering.
