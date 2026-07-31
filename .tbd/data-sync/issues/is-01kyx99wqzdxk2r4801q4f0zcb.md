---
type: is
id: is-01kyx99wqzdxk2r4801q4f0zcb
title: Cover the session-capability failure branch
kind: task
status: open
priority: 1
version: 1
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase2
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:49:11.548Z
updated_at: 2026-07-31T23:49:11.548Z
---
test/hardening.test.ts:17-23 states outright that CI always has sessions so it asserts only the positive. The loud-failure branch of requireWriterCapabilities() (src/driver.ts:145-155) - the guard preventing a session-less binding from silently recording an empty changeset and DROPPING WRITES - is never executed. Needs an injection seam or a capabilities() monkeypatch.
