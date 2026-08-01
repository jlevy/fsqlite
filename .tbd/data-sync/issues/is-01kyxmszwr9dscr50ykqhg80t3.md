---
type: is
id: is-01kyxmszwr9dscr50ykqhg80t3
title: Run a real multi-host shared-filesystem correctness gate
kind: task
status: open
priority: 1
version: 3
spec_path: docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md
labels:
  - post-alpha
dependencies:
  - type: blocks
    target: is-01kyxmt1qt0vnytwrdcp5eqc5f
parent_id: is-01kyxmrxxwhdr0a5f90akc73a4
created_at: 2026-08-01T03:10:13.399Z
updated_at: 2026-08-01T03:19:00.677Z
---
Exercise writers, readers, reconcilers, stale-lock breaks, clock skew, attribute caching, close-to-open visibility, and fsync durability across at least two hosts on NFSv4.1/EFS and SMB or an equivalent managed shared filesystem. Record mount and runtime configuration with results, and use the evidence to decide whether a monotonic fence or single-host proxy-lock gate is needed.
