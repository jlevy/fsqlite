---
type: is
id: is-01m7m6hdn9jvzwk8rkp38d9tv8
title: "PR #9 A1: a W3 match after a batch does not show the stored state is right"
kind: bug
status: closed
priority: 1
version: 2
labels: []
dependencies: []
parent_id: is-01m7m6hdd644jqw5x1wwj4axxn
created_at: 2026-11-17T07:28:59.049Z
updated_at: 2026-11-17T08:15:23.502Z
closed_at: 2026-11-17T08:15:23.501Z
close_reason: "Fixed in 0f4d1c0: harness/state_check.py and results/state-check.json check every after-batch W3 file's stored rows against the delta2.py --apply reference (12 verified, 6 known different, 4 unverified); harness/README.md State Check section. Tests in harness/test_harness.py."
resolution: null
duplicate_of: null
---
High. Review A https://github.com/jlevy/fsqlite/pull/9#pullrequestreview-5934446288. harness/compare.py, harness/slim_results.py:60-64, corpus/delta2.py:144-146. Fix: a row-level state check against delta2.py --apply output, with a table of verified, unverified, or known-different after-batch W3 files.
