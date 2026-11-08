---
type: is
id: is-01kyxmt04b7dn0ny9131jbwkd3
title: Add power-loss fault injection and durable-envelope mode
kind: feature
status: open
priority: 1
version: 2
spec_path: docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md
labels:
  - post-alpha
dependencies: []
parent_id: is-01kyxmrxxwhdr0a5f90akc73a4
created_at: 2026-08-01T03:10:13.642Z
updated_at: 2026-11-08T20:32:17.666Z
---
Validate snapshot and pointer fsync ordering with block-device or VM-level power-loss injection, not only process termination. Specify and implement an opt-in mode that durably fsyncs accepted envelopes before returning for callers that need a pre-reconcile durability receipt.

## Notes

2026-11-08: fable-research.md research section (c) item 8: also cover container filesystems (overlayfs volatile, tmpfs). On macOS, libuv fsync already uses F_FULLFSYNC.
