---
type: is
id: is-01kyx9gmbmwa5vkt7g3jn2twxr
title: Define the standalone store root and self-identifying format marker
kind: feature
status: in_progress
priority: 1
version: 6
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase3
dependencies:
  - type: blocks
    target: is-01kyx9gmsmz1kh69vpkm0n53kp
  - type: blocks
    target: is-01kyxmtrtfxf2sh0badg29wqth
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:52:52.339Z
updated_at: 2026-08-01T03:10:38.926Z
---
Define format f1.0 as a dedicated caller-provided store root with no container-specific nesting or vocabulary. Require a visible fsqlite.json marker containing format='fsqlite', string format_version='f1.0' using the f<major>.<minor> grammar, required_features, and store_id. Major changes are incompatible; minor changes are additive, but readers accept newer minors only when compatibility is explicit. Never infer identity from generic layout names. Repeat store identity and format version in snapshots and envelopes. Distinguish not-a-store, invalid, unsupported, and corrupt states; unknown required features must block operation. Normal opens never upgrade. Whole-format upgrades are explicit and side-by-side by default, preserve store_id, validate the destination, and leave the source untouched. Keep caller schema_version/schema_hash and package semver separate from the directory format version.
