---
type: is
id: is-01kyx99vfpy5rqjfb6mmkje2sn
title: repair() performs destructive deletes with no lock
kind: bug
status: closed
priority: 0
version: 2
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase2
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:49:10.261Z
updated_at: 2026-08-01T04:31:40.760Z
closed_at: 2026-08-01T04:31:40.760Z
close_reason: Implemented the correctness repair with focused regression coverage; the 95-case Node suite and full local verification gate pass.
---
Unlike init() (fenced at :211) and reconcile()'s publish (fenced at :543), repair() takes no lock while deleting snapshots at :773-777. A concurrent reconcile() or DirectStore.write() that has renameSync'd its snapshot but not yet swapped the pointer loses that file, and the swap then lands naming a nonexistent path - a store validate() reports as corrupt. It also removes publish.lock at :805-810 on mtime alone, which can free the lock while a live holder is inside its critical section. Either fence repair under the publish lock or make it refuse to run against a store with a live lock.
