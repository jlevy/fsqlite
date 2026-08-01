---
type: is
id: is-01kyxzfvggfsd4tethq5gaghxx
title: "PR #1 review D3/D5b: make repair stale-lock recovery fenced and race-free"
kind: bug
status: closed
priority: 2
version: 4
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels: []
dependencies: []
parent_id: is-01kyxzayw4jqyc0tty925kttr0
created_at: 2026-08-01T06:16:55.567Z
updated_at: 2026-08-01T06:31:41.552Z
closed_at: 2026-08-01T06:31:41.551Z
close_reason: Implemented with focused recovery and failure-path regression tests; the affected test files and focused lint pass.
---
Owner engineering review D3 and D5b. packages/fsqlite/src/snapshotStore.ts:970-986 refuses whenever publish.lock exists, yet the repair procedure needs an operator path for abandoned locks; the pre-check then withLock is a TOCTOU because a lock can appear after existsSync and withLock may stale-break it. docs/fsql-format-spec.md:468-471 currently mandates refusal/break-never. Define a single fenced policy: refuse a fresh live lock, recover stale lease via auditable acquisition/revalidation, and test stale lock, fresh lock, and appearance-between-check-and-acquire.
