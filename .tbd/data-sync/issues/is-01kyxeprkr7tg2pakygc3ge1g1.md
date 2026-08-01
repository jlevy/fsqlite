---
type: is
id: is-01kyxeprkr7tg2pakygc3ge1g1
title: Remove all Finterm references from the standalone repository
kind: task
status: open
priority: 1
version: 2
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase3
dependencies:
  - type: blocks
    target: is-01kyx9gpj0yvtab58tgxy5ezk1
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-08-01T01:23:36.183Z
updated_at: 2026-08-01T01:23:39.800Z
---
Before release, remove every case-insensitive reference to Finterm from tracked source, documentation, metadata, planning artifacts, and release files. Verify with a repository-wide scan that excludes only generated dependency/build directories. Joshua Levy is the sole copyright holder.
