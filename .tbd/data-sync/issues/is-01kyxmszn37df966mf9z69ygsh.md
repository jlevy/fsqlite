---
type: is
id: is-01kyxmszn37df966mf9z69ygsh
title: Implement explicit side-by-side whole-format upgrades
kind: feature
status: open
priority: 1
version: 2
spec_path: docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md
labels:
  - post-alpha
dependencies:
  - type: blocks
    target: is-01kyxmt12065w1n82gnk1z41ef
parent_id: is-01kyxmrxxwhdr0a5f90akc73a4
created_at: 2026-08-01T03:10:13.154Z
updated_at: 2026-08-01T03:10:29.857Z
---
Specify and implement an explicit upgrade command. Pin or quiesce a validated source, build a target-format destination, preserve store_id for the same logical store, validate the destination, survive interruption at each metadata write boundary, and leave the source untouched until operator cutover. Normal open must never invoke it.
