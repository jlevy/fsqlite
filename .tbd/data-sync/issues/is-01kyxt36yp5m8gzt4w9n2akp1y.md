---
type: is
id: is-01kyxt36yp5m8gzt4w9n2akp1y
title: Tolerate concurrent envelope consumption during quarantine
kind: bug
status: closed
priority: 0
version: 2
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase2
  - ci-finding
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-08-01T04:42:38.418Z
updated_at: 2026-08-01T04:45:33.279Z
closed_at: 2026-08-01T04:45:33.278Z
close_reason: Fixed the racing-reconciler ENOENT without weakening fail-closed quarantine writes; deterministic regression, 20 repeated seeded chaos runs, and the full 96-test local gate pass.
---
GitHub macOS CI reproduced a racing-reconciler failure: one reconciler classified an envelope for quarantine, another consumed it, and the first then failed writing QUARANTINE with ENOENT. Preserve fail-closed behavior for real reason-write failures, but treat a now-absent pending directory as a benign concurrent resolution. Add deterministic regression coverage and rerun the seeded chaos test plus the full matrix.
