---
type: is
id: is-01kyxn8ffpjs5p46pm2g114pr3
title: Add URI and path portability validation
kind: task
status: open
priority: 2
version: 1
spec_path: docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md
labels:
  - post-alpha
dependencies: []
parent_id: is-01kyxmrxxwhdr0a5f90akc73a4
created_at: 2026-08-01T03:18:08.117Z
updated_at: 2026-08-01T03:18:08.117Z
---
Test normal and supported SQLite URI modes plus store paths containing symlinks, spaces, Unicode, and Windows drive or UNC forms. Define canonicalization and identity rules without relying on platform-specific realpath behavior, and add packed-artifact tests to the platform matrix.
