---
type: is
id: is-01kyx99x5hf0pg17ggysvkbqvm
title: Make fuzz failures reproducible
kind: task
status: open
priority: 2
version: 1
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase2
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:49:11.984Z
updated_at: 2026-07-31T23:49:11.984Z
---
test/fuzz.test.ts:14 uses unseeded Math.random() for writers/per/reconcilers/readers/stagger, so a failure cannot be re-run. Log the drawn parameters on failure at minimum; better, accept a seed from the environment so the case can be replayed and a nightly soak can vary it deliberately.
