---
type: is
id: is-01m7m6hdydzrwjxjqtz91hwj23
title: "PR #9 A2: slimming removed what a reader needs to repeat the oracle check"
kind: bug
status: closed
priority: 2
version: 2
labels: []
dependencies: []
parent_id: is-01m7m6hdd644jqw5x1wwj4axxn
created_at: 2026-11-17T07:28:59.341Z
updated_at: 2026-11-17T08:15:23.715Z
closed_at: 2026-11-17T08:15:23.715Z
close_reason: "Fixed in 26020b3 (slim_results.py keeps path results, digests compare.py's canonical form, passes --kb, records expected sha256; README), d003010 (restored full answers), c81e121 (re-slimmed: compare.py expected/S1/w3.json results/fsqlite/S1/w3.json MATCH 24; FalkorDB vs fsqlite S2-r2 MATCH 124 with --kb), 60361a4 (expected_sha256 after path rewrite)."
resolution: null
duplicate_of: null
---
Medium. Review A https://github.com/jlevy/fsqlite/pull/9#pullrequestreview-5934446288. harness/slim_results.py:48-65, harness/README.md:64-65. Fix: keep path results, digest compare.py's equality, pass --kb, record the expected file's sha256, document the tool, restore and re-slim.
