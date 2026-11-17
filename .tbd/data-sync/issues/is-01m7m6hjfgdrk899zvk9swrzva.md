---
type: is
id: is-01m7m6hjfgdrk899zvk9swrzva
title: "PR #9 B12: run the policy gate before any dependency code runs"
kind: bug
status: closed
priority: 4
version: 2
labels: []
dependencies: []
parent_id: is-01m7m6hdd644jqw5x1wwj4axxn
created_at: 2026-11-17T07:29:03.984Z
updated_at: 2026-11-17T08:15:26.931Z
closed_at: 2026-11-17T08:15:26.931Z
close_reason: "Fixed in 4d1d6a8: root verify runs test:supply-chain first, with node scripts/check-supply-chain.mjs before its rule tests and before any step that executes installed packages. CI workflows unchanged."
resolution: null
duplicate_of: null
---
Review B https://github.com/jlevy/fsqlite/pull/9#pullrequestreview-5934384031. Suggestion. package.json verify chain.
