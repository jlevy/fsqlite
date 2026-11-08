---
type: is
id: is-01m6ydr88rrm1dg0ndf6f274xk
title: Support or reject FK actions and triggers in SnapshotStore reconciliation
kind: bug
status: open
priority: 1
version: 2
labels: []
dependencies:
  - type: blocks
    target: is-01kyx9gpj0yvtab58tgxy5ezk1
parent_id: is-01m6yd8g37a4pkt9xb3pw7x8tf
created_at: 2026-11-08T20:31:45.431Z
updated_at: 2026-11-08T20:32:19.040Z
---
From fable-core.md finding C3: applyChangeset re-fires foreign-key cascades and triggers during reconciliation, which permanently quarantines valid envelopes. Either support these schemas correctly or reject them up front.
