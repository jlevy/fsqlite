---
type: is
id: is-01kyxzj4cwfhedqey70wc2p1wg
title: "PR #1 review D1: disclose snapshot-seed write amplification and sizing limits"
kind: task
status: closed
priority: 2
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels: []
dependencies: []
parent_id: is-01kyxzayw4jqyc0tty925kttr0
created_at: 2026-08-01T06:18:10.203Z
updated_at: 2026-08-01T06:30:10.897Z
closed_at: 2026-08-01T06:30:10.896Z
close_reason: "Fixed: package README and design disclose reviewer-local write-seeding measurements, safe schema-only scope, and fsq-fp06 follow-up."
---
Owner engineering review D1. SnapshotStore.write documents O(snapshot size) only in its API comment (packages/fsqlite/src/snapshotStore.ts:461-465); measured write amplification/sizing guidance is absent from README limitations, docs/fsqlite-design.md tradeoffs, and the format spec. Carry a reproducible sizing rule and mitigation guidance (schema-only only for safe insert-new-key workloads; shard/compact/overlay roadmap) into adopter-facing docs. Related future implementation research: fsq-fp06.
