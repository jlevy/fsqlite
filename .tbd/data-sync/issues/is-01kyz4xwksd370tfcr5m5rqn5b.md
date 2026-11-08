---
type: is
id: is-01kyz4xwksd370tfcr5m5rqn5b
title: Upstream closing-hook hardening to get-tbd
kind: task
status: open
priority: 3
version: 3
spec_path: null
labels:
  - follow-up
dependencies: []
parent_id: is-01m6yd94ch9f0bbczzanqt447n
created_at: 2026-08-01T17:11:12.760Z
updated_at: 2026-11-08T20:32:18.531Z
---
The fsqlite hook copies are project-maintained adaptations because get-tbd@0.4.2 still generates git-dependent, limited command matching and can overwrite the fixes during tbd setup --auto. Port the validated no-git root lookup, shell-aware push detection, explicit JSON/CLI failures, and hermetic regression cases to the get-tbd generator; release a new pinned version; regenerate both fsqlite hook surfaces; and retain the project guard against drift.

## Notes

2026-11-08: tbd 0.10.0 setup still replaces .claude/settings.json hook commands with cwd-relative forms, appends duplicate Codex hooks, and regenerates the jq-based closing hook. The project hooks were re-reconciled onto 0.10.0's config-pinned tbd_fallback_version launcher; CONTRIBUTING.md now documents the post-upgrade reconciliation. Upstreaming remains open.
