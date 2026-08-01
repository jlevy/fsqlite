---
type: is
id: is-01kyxmt1ggdxq7kkcbrjpn73bz
title: Define and test Worker Thread coordination
kind: task
status: open
priority: 2
version: 1
spec_path: docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md
labels:
  - post-alpha
dependencies: []
parent_id: is-01kyxmrxxwhdr0a5f90akc73a4
created_at: 2026-08-01T03:10:15.056Z
updated_at: 2026-08-01T03:10:15.056Z
---
Define the one-connection-per-thread and process-local serialization contract for multi-step operations. Add Worker Thread races for write, reconcile, DirectStore, repair, seal, and lock ownership without sharing node:sqlite connection objects.
