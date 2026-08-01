---
type: is
id: is-01kyx99xcafjpj59c1zkbc3xtn
title: Extract correctness-bearing magic numbers into named constants
kind: task
status: closed
priority: 2
version: 2
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase2
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:49:12.201Z
updated_at: 2026-08-01T04:31:40.831Z
closed_at: 2026-08-01T04:31:40.831Z
close_reason: Implemented the correctness repair with focused regression coverage; the 95-case Node suite and full local verification gate pass.
---
The general-coding-rules guideline bans hardcoded numerics, and every tunable here is an inline destructuring default: lock.ts:58 (timeoutMs 30000, pollMs 25, staleMs 20000), snapshotStore.ts:317/427/456 (maxRetries 8/5/8), :578-580 (retain 3, leaseStaleMs 60000, transientStaleMs 60000), :731 (lockStaleMs 30000), directStore.ts:75 (maxRetries 8), fsinspect.ts:127/209/214. The correctness argument rests on staleMs >> max critical section, and those two numbers currently sit 500 lines apart in unnamed defaults. DEFAULT_MAX_ENVELOPE_BYTES at :74 shows the target shape.
