---
type: is
id: is-01m6yvqxcgmxkk2pg86dysxzfy
title: Retry the reconcile build copy when gc collects its base snapshot
kind: task
status: open
priority: 3
version: 1
labels: []
dependencies: []
parent_id: is-01m6yd8g37a4pkt9xb3pw7x8tf
created_at: 2026-11-09T00:36:14.352Z
updated_at: 2026-11-09T00:36:14.352Z
---
From the PR #5 CLI/API pass: readers now re-read current and retry when gc removes the snapshot between pointer read and open (spec U3), but the reconcile build copy has no such retry.
