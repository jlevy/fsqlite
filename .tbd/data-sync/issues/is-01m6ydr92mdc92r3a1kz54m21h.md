---
type: is
id: is-01m6ydr92mdc92r3a1kz54m21h
title: Look up conflict policies by own property only
kind: bug
status: closed
priority: 1
version: 3
labels: []
dependencies:
  - type: blocks
    target: is-01kyx9gpj0yvtab58tgxy5ezk1
parent_id: is-01m6yd8g37a4pkt9xb3pw7x8tf
created_at: 2026-11-08T20:31:46.260Z
updated_at: 2026-11-09T02:06:35.104Z
closed_at: 2026-11-09T02:06:35.104Z
close_reason: "Implemented by the comprehensive update merged in PR #5 and verified with pnpm verify and GitHub CI."
resolution: null
duplicate_of: null
---
From opus-ts.md finding T1: conflict-policy lookup walks the prototype chain, so changes for tables named like Object.prototype members are silently dropped. Use own-property lookup.
