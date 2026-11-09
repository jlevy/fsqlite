---
type: is
id: is-01m70pj00k8t8vhnjknz317wb1
title: "PR #7 C6 (info): per-envelope foreign_key_check cost is pinned by the D2 test; speed it up only by checking touched rows"
kind: task
status: open
priority: 4
version: 1
labels:
  - pr-7-review
dependencies: []
parent_id: is-01m6yd8g37a4pkt9xb3pw7x8tf
created_at: 2026-11-09T17:44:06.418Z
updated_at: 2026-11-09T17:44:06.418Z
---
Review C (performance, round 1) at 4881939, suggestion C6: https://github.com/jlevy/fsqlite/pull/7#pullrequestreview-5829678589

Measured on the review host: one PRAGMA foreign_key_check took 1.0 ms with 10k child rows and 10.1 ms with 100k, so a batch of 100 envelopes on a 100k-row child table spends about 1 s in these checks.

The PR #7 D2 test (packages/fsqlite/test/merge-constraints.test.ts, 'foreign keys close at each envelope, even when a later envelope in the batch would cure it') forbids batching the check, so any speedup must keep per-envelope closure, for example by checking only the parent and child rows the envelope's changeset touched. The design doc already documents this term; no action was needed in PR #7. Same cost as fsq-3tta (PR #5 D2); this bead records the constraint the D2 test now imposes on that work.
