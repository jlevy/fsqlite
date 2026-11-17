---
type: is
id: is-01m7m6herq71h5vr7zb500zh24
title: "PR #9 A13: apply_batch trusts preconditions it does not check"
kind: bug
status: closed
priority: 3
version: 2
labels: []
dependencies: []
parent_id: is-01m7m6hdd644jqw5x1wwj4axxn
created_at: 2026-11-17T07:29:00.183Z
updated_at: 2026-11-17T08:15:24.383Z
closed_at: 2026-11-17T08:15:24.383Z
close_reason: "Fixed in b8dde0c: delta2.check_batch refuses upsert-twice, upsert-and-remove, removed survivors, and unknown ops before apply_batch writes; protected_ids fails when queries.json is missing or empty and manifests record its digest; oracle refuses multi-envelope records. Tested in harness/test_harness.py; real S1-r2 p05/p20 and S2-r2 p05 batches pass and apply byte-identically."
resolution: null
duplicate_of: null
---
Low. Review A https://github.com/jlevy/fsqlite/pull/9#pullrequestreview-5934446288. corpus/delta2.py:296-371. Fix: assert no path both upserted and removed, and no survivor removed.
