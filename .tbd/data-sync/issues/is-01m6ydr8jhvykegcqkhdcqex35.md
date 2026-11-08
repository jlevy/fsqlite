---
type: is
id: is-01m6ydr8jhvykegcqkhdcqex35
title: Refuse init over an existing lineage whose current pointer is missing
kind: bug
status: open
priority: 1
version: 2
labels: []
dependencies:
  - type: blocks
    target: is-01kyx9gpj0yvtab58tgxy5ezk1
parent_id: is-01m6yd8g37a4pkt9xb3pw7x8tf
created_at: 2026-11-08T20:31:45.745Z
updated_at: 2026-11-08T20:32:19.042Z
---
From fable-core.md finding C4: init republishes snapshot 0 over a mature store when the current pointer is missing. Detect the existing lineage and refuse.
