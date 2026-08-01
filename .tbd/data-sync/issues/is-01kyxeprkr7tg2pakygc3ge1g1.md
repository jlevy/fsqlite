---
type: is
id: is-01kyxeprkr7tg2pakygc3ge1g1
title: Remove external product references from the standalone repository
kind: task
status: closed
priority: 1
version: 4
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase3
dependencies:
  - type: blocks
    target: is-01kyx9gpj0yvtab58tgxy5ezk1
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-08-01T01:23:36.183Z
updated_at: 2026-08-01T03:15:27.711Z
closed_at: 2026-08-01T03:15:27.711Z
close_reason: Aligned the QA, research, format, design-adjacent source-confirmation, release-plan, and tracker surfaces with the standalone f1.0 project. Removed obsolete paths and external product context; updated current runtime/layout/test claims; defined recognition and upgrade semantics; formatted with flowmark; verified relative links, repository searches, and git diff checks.
---
Search all tracked source, docs, package metadata, tests, and tbd records for references to the code snapshot's former product context. Replace or remove them so this repository describes only the standalone fsqlite project. Validate with an unrestricted case-insensitive search before closing.
