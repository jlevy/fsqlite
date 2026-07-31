---
type: is
id: is-01kyx99waty66nfkw3s57j60rp
title: Remove the orphaned lock directory when the owner.json write fails
kind: bug
status: open
priority: 1
version: 1
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase2
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:49:11.129Z
updated_at: 2026-07-31T23:49:11.129Z
---
lock.ts:64-71 does mkdirSync then writeFileSync(owner.json). If the write throws (ENOSPC, EACCES, EROFS) the catch rethrows with held still false, so the try/finally release at :96-104 never runs - leaving a lock dir with no owner.json that blocks every writer and reconciler until staleMs elapses, and for which ownerOf() returns null. Clean up the just-created directory before rethrowing.
