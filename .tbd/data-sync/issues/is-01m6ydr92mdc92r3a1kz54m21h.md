---
type: is
id: is-01m6ydr92mdc92r3a1kz54m21h
title: Look up conflict policies by own property only
kind: bug
status: open
priority: 1
version: 2
labels: []
dependencies:
  - type: blocks
    target: is-01kyx9gpj0yvtab58tgxy5ezk1
parent_id: is-01m6yd8g37a4pkt9xb3pw7x8tf
created_at: 2026-11-08T20:31:46.260Z
updated_at: 2026-11-08T20:32:19.047Z
---
From opus-ts.md finding T1: conflict-policy lookup walks the prototype chain, so changes for tables named like Object.prototype members are silently dropped. Use own-property lookup.
