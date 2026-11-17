---
type: is
id: is-01m7m6he71vqzrkcr0k49ry02h
title: "PR #9 A3: compare.py can print MATCH for results that differ"
kind: bug
status: closed
priority: 2
version: 2
labels: []
dependencies: []
parent_id: is-01m7m6hdd644jqw5x1wwj4axxn
created_at: 2026-11-17T07:28:59.617Z
updated_at: 2026-11-17T08:15:23.943Z
closed_at: 2026-11-17T08:15:23.943Z
close_reason: "Fixed in 26020b3: compare.py counts differences independently of --max-diffs, exits 2 on empty files or duplicate names, treats a path result without hops as a difference; FalkorDB _norm keys on category. harness/test_harness.py covers each case (red on the old compare.py)."
resolution: null
duplicate_of: null
---
Medium. Review A https://github.com/jlevy/fsqlite/pull/9#pullrequestreview-5934446288. harness/compare.py:28-45, 155-161. Fix: count differences independently of --max-diffs, fail on zero queries or duplicate names, require hops in path results, add tests.
