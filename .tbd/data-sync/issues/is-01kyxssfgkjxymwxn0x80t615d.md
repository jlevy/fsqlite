---
type: is
id: is-01kyxssfgkjxymwxn0x80t615d
title: Make the tag workflow safe for the bootstrap version
kind: bug
status: closed
priority: 1
version: 5
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase3
  - review-finding
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-08-01T04:37:19.506Z
updated_at: 2026-08-01T05:19:30.985Z
closed_at: 2026-08-01T05:19:30.984Z
close_reason: The v0.1.0 tag path verifies the owner-authenticated registry release and its alpha dist-tag through the consumer smoke test, while later tags retain OIDC publication. Both packed and external-package smoke modes pass locally.
---
The first unclaimed-package publication must use owner authentication before npm trusted publishing can be configured. Once 0.1.0 exists, pushing v0.1.0 would make the tag workflow attempt to publish the immutable version again and fail. Add an explicit bootstrap-tag verification path for v0.1.0 while preserving OIDC publication for later tags, and align the release runbook.
