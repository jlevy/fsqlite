---
type: is
id: is-01m6ydr9as0httfjzws5cf10n1
title: Keep failure exit codes when stdout or stderr is closed
kind: bug
status: open
priority: 1
version: 2
labels: []
dependencies:
  - type: blocks
    target: is-01kyx9gpj0yvtab58tgxy5ezk1
parent_id: is-01m6yd8g37a4pkt9xb3pw7x8tf
created_at: 2026-11-08T20:31:46.521Z
updated_at: 2026-11-08T20:32:19.049Z
---
From opus-ts.md finding T2: the broken-pipe handler exits 0, which masks failures when stdout or stderr is closed. Keep the failure exit code.
