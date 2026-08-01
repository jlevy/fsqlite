---
type: is
id: is-01kyxzfn0ss7v595zjbqk2d36c
title: "PR #1 review D2c/I9: make merge policy pass order deterministic"
kind: bug
status: closed
priority: 1
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - pr-review
dependencies: []
parent_id: is-01kyxzayw4jqyc0tty925kttr0
created_at: 2026-08-01T06:16:48.920Z
updated_at: 2026-08-01T06:26:23.571Z
closed_at: 2026-08-01T06:26:23.571Z
close_reason: "Fixed on PR #1 branch: nonreplaceable changeset conflicts now quarantine the atomic envelope; foreign keys are checked per envelope and at publication/validation boundaries; policy passes use normative replace, omit, strict order. Added behavioral regressions and updated f1.0 spec/design/package docs. Focused package suite passes 100/100."
---
PR #1 owner engineering review at commit 5ea2ef7. D2c/I9: packages/fsqlite/src/conflictPolicy.ts:121 derives filtered apply pass order from Object.values(policy), so JS object key insertion order changes results. Add a failing policy-permutation regression test, define a deterministic action order in code and docs, and preserve the f1.0 directory format. Relevant docs: docs/fsql-format-spec.md:310-329 and docs/fsqlite-design.md:90-105.
