---
type: is
id: is-01kyx98pbh8g37xk0534w9xbjc
title: Import fsqlite package tree into packages/fsqlite
kind: task
status: closed
priority: 1
version: 4
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase1
dependencies:
  - type: blocks
    target: is-01kyx98pmmk1k8eran9a8ks43a
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:48:32.239Z
updated_at: 2026-08-01T01:25:31.957Z
closed_at: 2026-08-01T01:25:31.953Z
close_reason: Imported the 57-file package tree as one faithful snapshot, applied Joshua Levy attribution, and verified the repository contains no Finterm references.
---
Bring packages/fsqlite from finterm-main PR #27 (branch claude/vibrant-mendel-sfd27, commit 02cb4ad3) into this repo at packages/fsqlite. 57 files: src/, test/, workers/, examples/, scripts/, docs/, configs. Preserve the 26 commits of history where practical (git filter-repo onto a branch) since the design rationale is dense. Faithful lift: no behavior changes in this bead.
