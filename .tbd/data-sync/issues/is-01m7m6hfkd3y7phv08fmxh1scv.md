---
type: is
id: is-01m7m6hfkd3y7phv08fmxh1scv
title: "PR #9 B2: the first-party record check accepts records that do not say a package is first-party"
kind: bug
status: closed
priority: 2
version: 2
labels: []
dependencies: []
parent_id: is-01m7m6hdd644jqw5x1wwj4axxn
created_at: 2026-11-17T07:29:01.037Z
updated_at: 2026-11-17T08:15:25.104Z
closed_at: 2026-11-17T08:15:25.104Z
close_reason: "Fixed in d7c7e53: closed whole-line record grammar under the exact '## First-Party Packages' heading, ignoring code fences, indented code, and HTML comments; dependency records need a recorded first-party parent. Review B's cases (a) to (d) are rejecting tests (75 pass; 11 fail on the old grammar)."
resolution: null
duplicate_of: null
---
Review B https://github.com/jlevy/fsqlite/pull/9#pullrequestreview-5934384031. Medium. scripts/supply-chain-exceptions.mjs:30, 34, 340-377; SUPPLY-CHAIN-SECURITY.md. Fix: closed record grammar with rejecting tests (a) to (d).
