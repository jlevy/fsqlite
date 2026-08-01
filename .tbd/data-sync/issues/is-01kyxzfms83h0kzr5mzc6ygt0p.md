---
type: is
id: is-01kyxzfms83h0kzr5mzc6ygt0p
title: "PR #1 review B3/D2b/I9: reject and report dangling foreign keys"
kind: bug
status: closed
priority: 1
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - pr-review
dependencies: []
parent_id: is-01kyxzayw4jqyc0tty925kttr0
created_at: 2026-08-01T06:16:48.679Z
updated_at: 2026-08-01T06:26:23.566Z
closed_at: 2026-08-01T06:26:23.566Z
close_reason: "Fixed on PR #1 branch: nonreplaceable changeset conflicts now quarantine the atomic envelope; foreign keys are checked per envelope and at publication/validation boundaries; policy passes use normative replace, omit, strict order. Added behavioral regressions and updated f1.0 spec/design/package docs. Focused package suite passes 100/100."
---
PR #1 owner engineering review at commit 5ea2ef7. B3/D2b/I9: packages/fsqlite/src/driver.ts:68-97 checks quick_check/integrity_check but never foreign_key_check, so packages/fsqlite/src/snapshotStore.ts:669-692 can publish merged dangling FKs and validate at lines 905-926 can report sealed. Add a failing concurrent-writer regression test, identify and quarantine the offending envelope at apply time, protect final publication and validate/seal, and document constraint semantics without changing the f1.0 directory format. Relevant docs: docs/fsql-format-spec.md:266-329, docs/fsqlite-design.md:90-105, packages/fsqlite/README.md:130-145.
