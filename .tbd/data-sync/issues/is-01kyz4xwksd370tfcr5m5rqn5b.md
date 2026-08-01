---
type: is
id: is-01kyz4xwksd370tfcr5m5rqn5b
title: Upstream closing-hook hardening to get-tbd
kind: task
status: open
priority: 3
version: 1
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - follow-up
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-08-01T17:11:12.760Z
updated_at: 2026-08-01T17:11:12.760Z
---
The fsqlite hook copies are project-maintained adaptations because get-tbd@0.4.2 still generates git-dependent, limited command matching and can overwrite the fixes during tbd setup --auto. Port the validated no-git root lookup, shell-aware push detection, explicit JSON/CLI failures, and hermetic regression cases to the get-tbd generator; release a new pinned version; regenerate both fsqlite hook surfaces; and retain the project guard against drift.
