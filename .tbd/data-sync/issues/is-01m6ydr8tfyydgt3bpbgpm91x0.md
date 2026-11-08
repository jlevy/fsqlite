---
type: is
id: is-01m6ydr8tfyydgt3bpbgpm91x0
title: Close the gc and read-lease race with a two-phase unlink
kind: bug
status: open
priority: 1
version: 2
labels: []
dependencies:
  - type: blocks
    target: is-01kyx9gpj0yvtab58tgxy5ezk1
parent_id: is-01m6yd8g37a4pkt9xb3pw7x8tf
created_at: 2026-11-08T20:31:45.998Z
updated_at: 2026-11-08T20:32:19.045Z
---
From fable-core.md finding C5: gc can race read-lease acquisition and delete a snapshot a reader is about to open. Use a two-phase unlink.
