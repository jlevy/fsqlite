---
type: is
id: is-01kyx99v203625pmbtk0gabacz
title: "Fix engines floor: backup is a static import that fails at link time"
kind: bug
status: closed
priority: 0
version: 2
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase2
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:49:09.823Z
updated_at: 2026-08-01T04:31:40.738Z
closed_at: 2026-08-01T04:31:40.734Z
close_reason: Implemented the correctness repair with focused regression coverage; the 95-case Node suite and full local verification gate pass.
---
src/driver.ts:15 is 'import { DatabaseSync, constants, backup } from node:sqlite'. ESM resolves named imports at LINK time, so on a Node where node:sqlite exists but lacks backup, the entire module graph fails to load - not a lazy failure a capability check can absorb. The typeof backup === 'function' probe at driver.ts:122 is unreachable on exactly the versions it defends. Three floors: node:sqlite unflagged 22.13, backup export later, type-stripping 22.18. Declared engines is >=22.13.0 and satisfies only the weakest. Confirm the exact release that added backup against the Node changelog, set an honest floor, and pin a CI job AT the floor (node-version: 22 resolves to latest 22.x and hides this).
