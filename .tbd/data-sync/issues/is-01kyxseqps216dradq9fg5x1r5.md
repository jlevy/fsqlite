---
type: is
id: is-01kyxseqps216dradq9fg5x1r5
title: Document first-publish bootstrap and trusted publishing handoff
kind: task
status: closed
priority: 1
version: 2
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase3
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-08-01T04:31:27.449Z
updated_at: 2026-08-01T04:31:41.095Z
closed_at: 2026-08-01T04:31:41.095Z
close_reason: Completed the standalone public API, package documentation, format identity, backup validation, roadmap, claim guard, and release runbook; full local verification passes.
---
Document the one-time owner-authenticated bootstrap required for an unclaimed npm package, the exact clean-checkout verification and alpha dist-tag steps, and the transition to GitHub Actions OIDC trusted publishing without a long-lived token. Keep tag creation behind identity, package-name, and reviewed-commit confirmation.
