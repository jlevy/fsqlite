---
type: is
id: is-01kyxmt12065w1n82gnk1z41ef
title: Specify deterministic caller-schema migration
kind: feature
status: open
priority: 1
version: 2
spec_path: docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md
labels:
  - post-alpha
dependencies: []
parent_id: is-01kyxmrxxwhdr0a5f90akc73a4
created_at: 2026-08-01T03:10:14.591Z
updated_at: 2026-08-01T16:14:26.879Z
---
Define migration of caller PRAGMA user_version and exact-DDL schema_hash across immutable schema epochs. Specify writer admission and quiescence or fencing, handling and quarantine of old committed envelopes, deterministic DDL and data transformation, constraint validation, conflict-policy transition, atomic cutover, old-writer behavior, interruption recovery, rollback, and separation from fsqlite directory-format upgrades. Add conformance fixtures for every crash and mixed-version boundary.
