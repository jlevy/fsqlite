---
type: is
id: is-01kyx9gn0ex11h62ydp3y60sxw
title: Write the root README, CONTRIBUTING.md and CHANGELOG.md
kind: task
status: closed
priority: 2
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase3
dependencies:
  - type: blocks
    target: is-01kyx9gpj0yvtab58tgxy5ezk1
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:52:53.005Z
updated_at: 2026-08-01T04:31:41.073Z
closed_at: 2026-08-01T04:31:41.073Z
close_reason: Completed the standalone public API, package documentation, format identity, backup validation, roadmap, claim guard, and release runbook; full local verification passes.
---
Root README is a short repo overview linking to packages/fsqlite (GitHub renders the root, npm renders the package; keep the package README canonical so the two cannot drift). CONTRIBUTING.md absorbs the Develop section currently inlined in the README. CHANGELOG.md is required once published.
