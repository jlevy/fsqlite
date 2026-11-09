---
type: is
id: is-01m70phzgm0pt4k3tdhs4pmz3x
title: "PR #7 C4 (Low): check archived transactions against the ledger in one query"
kind: task
status: open
priority: 3
version: 1
labels:
  - pr-7-review
dependencies: []
parent_id: is-01m6yd8g37a4pkt9xb3pw7x8tf
created_at: 2026-11-09T17:44:05.907Z
updated_at: 2026-11-09T17:44:05.907Z
---
Review C (performance, round 1) at 4881939, suggestion C4: https://github.com/jlevy/fsqlite/pull/7#pullrequestreview-5829678589

Where: packages/fsqlite/src/snapshotStore.ts countMissingArchived (one SELECT 1 FROM applied_tx WHERE tx_id = ? per archived envelope) and repair's copy of the same loop.

Measured on the review host: at 30k archived transactions the per-entry lookups took 107.4 ms and a single statement (SELECT count(*) FROM json_each(?) ... against applied_tx) took 9.4 ms with the same count; the readdir of tx/applied (15.1 ms) remains. Every gc and validate pays this, including a no-op gc: on one cloud VM a no-op gc took 123 to 126 ms at 30k archived (about 4 us per lookup) against 0.7 to 0.9 ms with none.

Use NOT EXISTS rather than NOT IN so the result cannot depend on NULL semantics, and keep repair's copy in step. Deferred from PR #7 because it is a pre-existing hot spot whose fix changes no observable behavior, so it has no failing test to pin it; it needs a measured benchmark instead. Related: fsq-bllj (bound the ledger).
