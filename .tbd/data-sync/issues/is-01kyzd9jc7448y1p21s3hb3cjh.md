---
type: is
id: is-01kyzd9jc7448y1p21s3hb3cjh
title: Bind or verify conflict-policy identity for each store epoch
kind: feature
status: open
priority: 1
version: 2
spec_path: docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md
labels: []
dependencies: []
parent_id: is-01kyxmrxxwhdr0a5f90akc73a4
created_at: 2026-08-01T19:37:24.102Z
updated_at: 2026-11-08T20:32:16.658Z
---
The f1.0 conflict policy is deployment configuration rather than stamped store identity. In a multi-agent deployment, two reconcilers with different normalized policies can produce different valid merge outcomes, so deterministic reconciliation currently depends on out-of-band configuration consistency. Design a compatible policy identity or admission mechanism, specify policy transitions during schema migration, add mismatch tests, and decide whether this is an f1.x feature or a later format revision.

## Notes

2026-11-08: fable-core.md finding C13 agrees with P1 for this bead.
