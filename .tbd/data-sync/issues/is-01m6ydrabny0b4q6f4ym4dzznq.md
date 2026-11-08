---
type: is
id: is-01m6ydrabny0b4q6f4ym4dzznq
title: Refresh dependencies, pnpm settings, CI matrix, and workflow hardening
kind: task
status: open
priority: 1
version: 2
labels: []
dependencies:
  - type: blocks
    target: is-01kyx9gpj0yvtab58tgxy5ezk1
parent_id: is-01m6yd8g37a4pkt9xb3pw7x8tf
created_at: 2026-11-08T20:31:47.573Z
updated_at: 2026-11-08T20:32:19.054Z
---
From opus-deps.md findings D1-D19 plus fable-research.md research section (c) items 1-2: pnpm 11.28.8, lefthook 2.2.1, eslint/typescript-eslint/prettier/tsdown/publint bumps, engineStrict, Node 26 in CI, engines excluding Node 25, SHA-pinned actions, zizmor fixes, publish job split, Dependabot cooldown, and an exports default condition. Related: fsq-sdph.
