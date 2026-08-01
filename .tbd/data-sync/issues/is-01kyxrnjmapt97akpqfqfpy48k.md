---
type: is
id: is-01kyxrnjmapt97akpqfqfpy48k
title: Fail closed when a quarantine reason cannot be persisted
kind: bug
status: closed
priority: 1
version: 2
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase2
  - review-finding
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-08-01T04:17:43.049Z
updated_at: 2026-08-01T04:31:40.819Z
closed_at: 2026-08-01T04:31:40.819Z
close_reason: Implemented the correctness repair with focused regression coverage; the 95-case Node suite and full local verification gate pass.
---
Precommit review found _quarantine and repair swallow QUARANTINE reason write failures, then move the envelope anyway. This loses the operator-visible reason and breaks writeWithRetry outcome classification. Leave the envelope in place and surface the write error; cover the failure path.
