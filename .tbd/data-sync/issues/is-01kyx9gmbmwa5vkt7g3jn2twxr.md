---
type: is
id: is-01kyx9gmbmwa5vkt7g3jn2twxr
title: "Decide format open issue O1: catalog-root nesting"
kind: feature
status: open
priority: 1
version: 2
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase3
dependencies:
  - type: blocks
    target: is-01kyx9gmsmz1kh69vpkm0n53kp
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:52:52.339Z
updated_at: 2026-07-31T23:53:10.571Z
---
fsql-format-spec.md:54-55 and :465 describe <storeDir>/data/catalog/ as 'a layout inherited from its first consumer' and say it should be either flattened or made explicit BEFORE PUBLISH. This is format-breaking, so alpha is the cheapest moment to resolve it. Either flatten to <storeDir>/ or keep data/catalog/ and document it as intentional rather than inherited.
