---
type: is
id: is-01kyx99vxc02bmak7yeqecc2k9
title: Make lease reads fail safe so gc cannot collect a pinned snapshot
kind: bug
status: open
priority: 1
version: 1
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase2
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:49:10.699Z
updated_at: 2026-07-31T23:49:10.699Z
---
snapshotStore.ts:626-634 swallows JSON.parse failures on lease files and omits the version from the pinned set, so gc proceeds to delete a snapshot that IS pinned. Lease files are written non-atomically (writeFileSync at :328) so a torn read is reachable. This fails OPEN on the destructive side. Either block collection on a fresh-but-unparseable lease, or write leases temp+rename the way _publishPointer already does at :855-861.
