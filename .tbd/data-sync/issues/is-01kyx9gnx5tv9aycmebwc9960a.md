---
type: is
id: is-01kyx9gnx5tv9aycmebwc9960a
title: Write docs/roadmap.md from the mined open items
kind: task
status: open
priority: 2
version: 1
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase3
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:52:53.924Z
updated_at: 2026-07-31T23:52:53.924Z
---
The monorepo plan spec is NOT ported (it is explicitly the finterm-side build plan, with 24 fin-* bead IDs, packages/dataroom references and DR/0.3 coupling). Mine it for what remains and write a fresh public roadmap with no inherited tracker IDs, no monorepo phase numbering and no downstream-consumer references. Sources: the spec's unchecked Phase 2/3 items, format spec open issues O1-O6, the research doc's eight Areas of Further Research, and QA runbook Part C. Headline post-alpha items: conformance fixtures + verifier, the real NFSv4.1/EFS concurrency gate, protocol-level design validation, cross-platform matrix, schema migration across snapshot versions.
