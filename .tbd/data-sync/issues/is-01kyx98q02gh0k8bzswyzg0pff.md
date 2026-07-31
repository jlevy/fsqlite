---
type: is
id: is-01kyx98q02gh0k8bzswyzg0pff
title: First dependency resolution and committed lockfile
kind: task
status: open
priority: 1
version: 7
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase1
dependencies:
  - type: blocks
    target: is-01kyx98qbw638v53gpf5pd2pyy
  - type: blocks
    target: is-01kyx98qka3sw1nj9r49fqe6jz
  - type: blocks
    target: is-01kyx98r0gfyvtx3rrpq9n94c4
  - type: blocks
    target: is-01kyx98r9x73s1szjw21bzn4mp
  - type: blocks
    target: is-01kyx98t42td7swxva57kfdaaz
  - type: blocks
    target: is-01kyx98srj03h0xyjm7psw4k1j
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:48:32.897Z
updated_at: 2026-07-31T23:53:09.961Z
---
The package has NEVER had a lockfile (it was excluded from the monorepo workspace via '!packages/fsqlite'), so all 7 devDeps are unresolved. This is a genuinely new resolution and the riskiest step in the plan. Expect friction from the tsdown -> rolldown transitive, documented in the QA runbook as blocked by the cool-off. Commit pnpm-lock.yaml; CI installs --frozen-lockfile.
