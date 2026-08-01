---
type: is
id: is-01kyz0kbtmpw6xjkx93q5cy6nb
title: Pin the source snapshot during seal
kind: bug
status: closed
priority: 2
version: 3
spec_path: docs/fsql-format-spec.md
labels:
  - design-review
dependencies: []
parent_id: is-01kyz0jk4e1tn8vfct59gw53ya
created_at: 2026-08-01T15:55:33.587Z
updated_at: 2026-08-01T16:30:42.404Z
closed_at: 2026-08-01T16:30:42.404Z
close_reason: Implemented, documented, and verified by the complete pnpm verify gate; independent final review found no remaining actionable design issue.
---
Close the GC availability race by having seal hold an internal read lease while VACUUM INTO reads the selected immutable snapshot, or document an equivalent safe contract with a regression.
