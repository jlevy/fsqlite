---
type: is
id: is-01kyy1jq46z3a7mf3bqx4awr0s
title: "PR #1 follow-up: defer foreign keys across envelope policy passes"
kind: bug
status: closed
priority: 1
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - pr-review
dependencies: []
parent_id: is-01kyxzayw4jqyc0tty925kttr0
created_at: 2026-08-01T06:53:26.533Z
updated_at: 2026-08-01T06:57:53.662Z
closed_at: 2026-08-01T06:57:53.661Z
close_reason: "Fixed in 9abfa3b: foreign-key enforcement spans the whole envelope across filtered passes, public applyWithPolicy performs the mandatory final check, inverted action order is covered, and protocol docs match durability and fencing order."
---
The owner follow-up comment demonstrates that deterministic action order alone does not preserve an internally valid parent-child envelope when the child table belongs to an earlier policy pass. Enable deferred foreign-key enforcement for the outer envelope transaction, validate after all passes before the ledger row, add an inverted-action regression, and align the format/design docs with actual publication ordering.
