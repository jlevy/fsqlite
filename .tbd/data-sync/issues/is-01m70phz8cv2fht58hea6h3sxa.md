---
type: is
id: is-01m70phz8cv2fht58hea6h3sxa
title: "PR #7 C3 (Low): gc holds the publish lock through each snapshot unlink"
kind: task
status: open
priority: 3
version: 1
labels:
  - pr-7-review
dependencies: []
parent_id: is-01m6yd8g37a4pkt9xb3pw7x8tf
created_at: 2026-11-09T17:44:05.644Z
updated_at: 2026-11-09T17:44:05.644Z
---
Review C (performance, round 1) at 4881939, finding C3: https://github.com/jlevy/fsqlite/pull/7#pullrequestreview-5829678589

Where: packages/fsqlite/src/snapshotStore.ts gcLocked -> collectSnapshot (the unlinkSync of each tombstone runs while gc holds publish.lock).

Measured on the review host (one 4-vCPU cloud VM, ext4): collectSnapshot took 35 ms per deletion at a 39.7 MiB head; at 393 MiB it took 322 ms of a 532 ms collecting gc, more than the 197 ms full check. A bare unlinkSync of a page-cached 39.7 MiB file took 12.5 ms. Publishers, reconcile, and readLease all wait on that lock.

Option: unlink each decided tombstone after the lock is released. Tombstones are .gc- transients, so if the process dies first a later full-check gc sweeps them. Waits on a spec decision: G0's 'every deletion' must name the rename (tombstone) as the deletion, which changes the normative text, and the tombstone-sweep rules (fsq-7zke) must still hold.
