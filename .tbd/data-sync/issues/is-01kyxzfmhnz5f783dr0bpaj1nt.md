---
type: is
id: is-01kyxzfmhnz5f783dr0bpaj1nt
title: "PR #1 review B2/D2a/I9: quarantine nonreplaceable changeset conflicts"
kind: bug
status: closed
priority: 1
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - pr-review
dependencies: []
parent_id: is-01kyxzayw4jqyc0tty925kttr0
created_at: 2026-08-01T06:16:48.436Z
updated_at: 2026-08-01T06:26:23.555Z
closed_at: 2026-08-01T06:26:23.554Z
close_reason: "Fixed on PR #1 branch: nonreplaceable changeset conflicts now quarantine the atomic envelope; foreign keys are checked per envelope and at publication/validation boundaries; policy passes use normative replace, omit, strict order. Added behavioral regressions and updated f1.0 spec/design/package docs. Focused package suite passes 100/100."
---
PR #1 owner engineering review at commit 5ea2ef7. B2/D2a/I9: packages/fsqlite/src/conflictPolicy.ts:44-126 silently maps UNIQUE/CONSTRAINT and other nonreplaceable conflicts to OMIT, after which packages/fsqlite/src/snapshotStore.ts:669-674 records the envelope in applied_tx. Add a failing behavioral regression test, then quarantine the atomic envelope instead of partially applying and ledgering it. Preserve f1.0 directory format. Relevant docs: docs/fsql-format-spec.md:310-329, docs/fsqlite-design.md:90-105, packages/fsqlite/README.md:130-145.
