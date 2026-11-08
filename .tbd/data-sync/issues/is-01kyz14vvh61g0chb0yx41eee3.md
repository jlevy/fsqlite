---
type: is
id: is-01kyz14vvh61g0chb0yx41eee3
title: Bound and checkpoint the applied transaction ledger
kind: feature
status: open
priority: 2
version: 2
spec_path: docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md
labels:
  - post-alpha
  - performance
dependencies: []
parent_id: is-01kyxmrxxwhdr0a5f90akc73a4
created_at: 2026-08-01T16:05:07.056Z
updated_at: 2026-11-08T20:32:16.987Z
---
Design a crash-safe bound for applied_tx so reconcile time, memory, and snapshot bytes do not grow without limit. Preserve exactly-once behavior when old envelopes or archived transaction directories reappear. Define checkpoint identity, retention assumptions, repair behavior, upgrade compatibility, and conformance tests.

## Notes

2026-11-08: fable-core.md finding C14 proposes a ledger-floor watermark design; see fable-core.md section 5.
