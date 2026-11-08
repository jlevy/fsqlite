---
type: is
id: is-01m6ydrkr34khje690777gbd50
title: Fall back to copy-then-remove when envelope moves hit EXDEV
kind: task
status: open
priority: 3
version: 3
spec_path: docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md
labels:
  - post-alpha
dependencies: []
parent_id: is-01kyxmrxxwhdr0a5f90akc73a4
created_at: 2026-11-08T20:31:57.187Z
updated_at: 2026-11-08T20:33:05.809Z
---
From fable-research.md research section (c) item 12: envelope renames can fail with EXDEV on overlayfs lower layers (depending on OVERLAY_FS_REDIRECT_DIR). Fall back to copy-then-remove.
