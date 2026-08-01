---
type: is
id: is-01kyxmszdhh7hmg3qsa3yth1ar
title: Build format conformance fixtures and an independent verifier
kind: feature
status: open
priority: 1
version: 10
spec_path: docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md
labels:
  - post-alpha
dependencies:
  - type: blocks
    target: is-01kyxmszn37df966mf9z69ygsh
  - type: blocks
    target: is-01kyxmt0bt2mdegv3qbkvps7qg
  - type: blocks
    target: is-01kyxmt0k7dgrtk07b63sytw0x
  - type: blocks
    target: is-01kyxmt0tk8zp3p9jnarvdqeyk
  - type: blocks
    target: is-01kyxmt12065w1n82gnk1z41ef
  - type: blocks
    target: is-01kyxmt04b7dn0ny9131jbwkd3
  - type: blocks
    target: is-01kyxn8exk3ea5wgarck167rh7
  - type: blocks
    target: is-01kyxn8f768vrn4jsk7jmt4nqx
  - type: blocks
    target: is-01kyxn8ffpjs5p46pm2g114pr3
parent_id: is-01kyxmrxxwhdr0a5f90akc73a4
created_at: 2026-08-01T03:10:12.912Z
updated_at: 2026-08-01T03:21:31.406Z
---
Publish golden fsqlite stores covering not-a-store, invalid, unsupported, sealed, live, in-flight, corrupt, mixed-store, and envelope quarantine outcomes. Build a verifier independent of the Node implementation under test. Version fixtures against f<major>.<minor> and make them the gate for every implementation.
