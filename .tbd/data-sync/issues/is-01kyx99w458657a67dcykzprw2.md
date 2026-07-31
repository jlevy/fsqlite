---
type: is
id: is-01kyx99w458657a67dcykzprw2
title: Make heartbeat() report loss of the lease instead of silently no-opping
kind: bug
status: open
priority: 1
version: 1
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase2
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:49:10.916Z
updated_at: 2026-07-31T23:49:10.916Z
---
snapshotStore.ts:340-347 discards the ENOENT from utimesSync once the lease file has been swept as stale. The holder keeps calling heartbeat() believing its snapshot is pinned; it is not, and gc will collect it. The caller has no way to learn it lost the lease. Return a boolean or throw so a packager can re-acquire. lock.ts:108-115 has the identical problem for the publish lock.
