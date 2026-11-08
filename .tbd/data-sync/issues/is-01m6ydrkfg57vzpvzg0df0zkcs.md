---
type: is
id: is-01m6ydrkfg57vzpvzg0df0zkcs
title: Publish builds under unique snapshot filenames (f1.1)
kind: feature
status: open
priority: 2
version: 4
spec_path: docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md
labels:
  - post-alpha
dependencies: []
parent_id: is-01kyxmrxxwhdr0a5f90akc73a4
created_at: 2026-11-08T20:31:56.912Z
updated_at: 2026-11-08T22:23:27.404Z
---
From fable-core.md finding C1, structural fix 4: publish each build as <version>-<hex10>.fsqlite.sqlite and have current name the file, gated by required_features. The in-format C1 fix is tracked under fsq-rz37.

## Notes

2026-11-08 (core pass 1): spec O6 records a remaining f1.0 window. A holder frozen between its last checks and its pointer rename, while two or more newer versions are published, can move current backward. Unique snapshot names alone do not close it; it also needs a pointer that cannot move backward (for example a monotonic pointer protocol). Cover both here.
