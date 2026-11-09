---
type: is
id: is-01m6ydr7z5dfz7sj5chn5ek2k1
title: Gate gc behind validation and the publish lock
kind: bug
status: closed
priority: 1
version: 3
labels: []
dependencies:
  - type: blocks
    target: is-01kyx9gpj0yvtab58tgxy5ezk1
parent_id: is-01m6yd8g37a4pkt9xb3pw7x8tf
created_at: 2026-11-08T20:31:45.125Z
updated_at: 2026-11-09T02:06:35.078Z
closed_at: 2026-11-09T02:06:35.077Z
close_reason: "Implemented by the comprehensive update merged in PR #5 and verified with pnpm verify and GitHub CI."
resolution: null
duplicate_of: null
---
From fable-core.md finding C2: gc deletes clean predecessors of a corrupt head and races repair. Validate the head before deleting predecessors and run gc under the publish lock.
