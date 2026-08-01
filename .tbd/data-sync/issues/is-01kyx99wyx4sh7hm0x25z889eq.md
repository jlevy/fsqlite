---
type: is
id: is-01kyx99wyx4sh7hm0x25z889eq
title: Defuse the three test flake risks
kind: bug
status: closed
priority: 1
version: 2
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase2
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:49:11.772Z
updated_at: 2026-08-01T04:31:40.807Z
closed_at: 2026-08-01T04:31:40.807Z
close_reason: Implemented the correctness repair with focused regression coverage; the 95-case Node suite and full local verification gate pass.
---
(1) seed.test.ts:81-82 asserts wall-clock benchmark comparisons inside the correctness gate; margins are wide locally but a throttled shared runner can redden a PR that changed nothing - move it out or make it byte-count based. (2) kill.test.ts:60 sleeps 15ms before SIGKILL, far less than Node cold-start, so on CI the child is almost certainly killed before doing any work: it passes as a SILENT FALSE GREEN and the mid-build property is likely never exercised - gate on an observable (.build-* appearing) instead. (3) fsinspect.test.ts:66-72 asserts typeof resolutionMs === 'number' but the probe legitimately returns null on a 1-second-mtime filesystem.
