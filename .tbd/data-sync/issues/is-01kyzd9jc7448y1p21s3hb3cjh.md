---
type: is
id: is-01kyzd9jc7448y1p21s3hb3cjh
title: Bind or verify conflict-policy identity for each store epoch
kind: feature
status: open
priority: 1
version: 1
labels: []
dependencies: []
created_at: 2026-08-01T19:37:24.102Z
updated_at: 2026-08-01T19:37:24.102Z
---
The f1.0 conflict policy is deployment configuration rather than stamped store identity. In a multi-agent deployment, two reconcilers with different normalized policies can produce different valid merge outcomes, so deterministic reconciliation currently depends on out-of-band configuration consistency. Design a compatible policy identity or admission mechanism, specify policy transitions during schema migration, add mismatch tests, and decide whether this is an f1.x feature or a later format revision.
