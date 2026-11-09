---
type: is
id: is-01m70phzrjkh20f4j73jhk9v6t
title: "PR #7 C5 (Low): clone the working copy with COPYFILE_FICLONE where the filesystem supports it"
kind: task
status: open
priority: 3
version: 1
labels:
  - pr-7-review
dependencies: []
parent_id: is-01m6yd8g37a4pkt9xb3pw7x8tf
created_at: 2026-11-09T17:44:06.161Z
updated_at: 2026-11-09T17:44:06.161Z
---
Review C (performance, round 1) at 4881939, suggestion C5: https://github.com/jlevy/fsqlite/pull/7#pullrequestreview-5829678589

Where: packages/fsqlite/src/snapshotStore.ts write(), copyFileSync(path, work) seeding the writer working copy.

Measured on the review host at a 21.6 MiB head: a capture took 11.3 ms, of which copyFileSync was 4.85 ms, removing the working copy 4.96 ms, and SQLite's work 0.3 ms. journal_mode = MEMORY saves nothing (0.27 vs 0.32 ms).

Option: copyFileSync(path, work, constants.COPYFILE_FICLONE), which falls back to a plain copy where cloning is unsupported; on reflink filesystems (XFS with reflink, btrfs, APFS) both the copy and the unlink become metadata-only. Waits on a reflink-capable host to measure it: ext4 has no reflink, so neither the review host nor the PR #7 host could measure the gain.
