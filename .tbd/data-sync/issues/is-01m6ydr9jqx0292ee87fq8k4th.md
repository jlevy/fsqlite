---
type: is
id: is-01m6ydr9jqx0292ee87fq8k4th
title: Reject invalid gc retention and lease options
kind: bug
status: open
priority: 1
version: 2
labels: []
dependencies:
  - type: blocks
    target: is-01kyx9gpj0yvtab58tgxy5ezk1
parent_id: is-01m6yd8g37a4pkt9xb3pw7x8tf
created_at: 2026-11-08T20:31:46.775Z
updated_at: 2026-11-08T20:32:19.052Z
---
From opus-ts.md finding T3: --retain "", NaN, or a negative value deletes history, and leaseStaleMs -1 deletes live leases. Validate and reject these options.
