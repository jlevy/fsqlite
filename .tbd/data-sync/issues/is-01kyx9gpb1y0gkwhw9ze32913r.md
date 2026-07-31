---
type: is
id: is-01kyx9gpb1y0gkwhw9ze32913r
title: Add tag-triggered publish workflow with npm provenance
kind: task
status: open
priority: 1
version: 2
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase3
dependencies:
  - type: blocks
    target: is-01kyx9gpj0yvtab58tgxy5ezk1
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:52:54.368Z
updated_at: 2026-07-31T23:53:10.764Z
---
Single-package repo, so skip Changesets (its value is multi-package coordination and per-PR changelog accumulation; the ceremony remains without the payoff). Tag-triggered OIDC publishing on v* tags with NPM_CONFIG_PROVENANCE: true. Provenance requires the repository field from the metadata bead.
