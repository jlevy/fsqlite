---
type: is
id: is-01kyy5hynrwba2nzksk7s465jr
title: "PR #1 review R1: include TEMP protection triggers in callback boundary"
kind: bug
status: closed
priority: 2
version: 3
spec_path: docs/fsqlite-design.md
labels:
  - pr-review
  - pre-release
dependencies: []
parent_id: is-01kyy5hqpztck8eb19h2nz1300
created_at: 2026-08-01T08:02:55.799Z
updated_at: 2026-08-01T08:11:28.147Z
closed_at: 2026-08-01T08:11:28.147Z
close_reason: "Fixed in 5e1f609: persistent and temporary schemas are fingerprinted across callbacks, DirectStore and SnapshotStore regressions prove synchronous rejection, the public and normative contracts are explicit, all eight CI checks pass, and the PR disposition is posted."
---
PR #1 owner comment at 2026-08-01T07:53:03Z. packages/fsqlite/src/driver.ts captureCallbackBoundary fingerprints only main.sqlite_schema. A callback can explicitly DROP the fsqlite_protect_* TEMP triggers, then mutate applied_tx or fsqlite_meta without the existing DML guard or main-schema fingerprint noticing. Independently reproduce the behavior and decide whether the documented cooperative trust boundary warrants rejecting TEMP schema changes. If fixed, use red-green TDD and cover both DirectStore and SnapshotStore callback paths.
