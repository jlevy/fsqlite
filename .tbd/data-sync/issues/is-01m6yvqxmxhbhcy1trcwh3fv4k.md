---
type: is
id: is-01m6yvqxmxhbhcy1trcwh3fv4k
title: Decide whether repair should age-gate transients (spec 11 step 3)
kind: task
status: open
priority: 3
version: 1
spec_path: docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md
labels: []
dependencies: []
parent_id: is-01kyxmrxxwhdr0a5f90akc73a4
created_at: 2026-11-09T00:36:14.621Z
updated_at: 2026-11-09T00:36:14.621Z
---
opus-ts T20: spec §11 step 3 says repair deletes all transients, which can remove a live writer's in-progress files. The PR #5 pass only documented this in help and README; deciding on an age gate is a spec change.
