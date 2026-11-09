---
type: is
id: is-01m6yzw1s82c9ak2axzmfbfgjg
title: "PR #3 A1: qualify transient SQLite NFS lock errors in the README"
kind: task
status: open
priority: 3
version: 1
labels: []
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
created_at: 2026-11-09T01:48:24.231Z
updated_at: 2026-11-09T01:48:24.231Z
---
The cited VFS calls ENOLCK retryable. A timeout can ride out transient faults or contention, but cannot fix a persistent mount locking problem. Fold the README wording into PR #5 with the rest of #3.
