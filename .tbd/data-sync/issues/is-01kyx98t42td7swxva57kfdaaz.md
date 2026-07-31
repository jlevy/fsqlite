---
type: is
id: is-01kyx98t42td7swxva57kfdaaz
title: Resolve tryscript from devDeps instead of a network runner
kind: task
status: open
priority: 2
version: 2
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase1
dependencies:
  - type: blocks
    target: is-01kyx98srj03h0xyjm7psw4k1j
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:48:36.097Z
updated_at: 2026-07-31T23:53:09.971Z
---
package.json declares tryscript ^0.1.6 but CI runs 'npx -y tryscript@0.1.6', bypassing the devDep, drifting the version, and fetching over the network on every run. The supply-chain guideline bans download-capable runners in configs, hooks and CI.
