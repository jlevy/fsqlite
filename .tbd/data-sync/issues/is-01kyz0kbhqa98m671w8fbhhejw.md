---
type: is
id: is-01kyz0kbhqa98m671w8fbhhejw
title: Fail closed when required directory fsync is unavailable
kind: bug
status: closed
priority: 1
version: 3
spec_path: docs/fsql-format-spec.md
labels:
  - design-review
dependencies: []
parent_id: is-01kyz0jk4e1tn8vfct59gw53ya
created_at: 2026-08-01T15:55:33.302Z
updated_at: 2026-08-01T16:30:42.357Z
closed_at: 2026-08-01T16:30:42.357Z
close_reason: Implemented, documented, and verified by the complete pnpm verify gate; independent final review found no remaining actionable design issue.
---
Make directory fsync errors abort publication instead of being silently ignored, include fsyncDir in the fsinspect safe verdict, and add focused regression coverage consistent with the alpha power-loss contract.
