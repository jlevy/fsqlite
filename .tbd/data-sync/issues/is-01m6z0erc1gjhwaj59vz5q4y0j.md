---
type: is
id: is-01m6z0erc1gjhwaj59vz5q4y0j
title: "PR #5 E3: preserve post-publish outcomes when lock or descriptor cleanup fails"
kind: bug
status: in_progress
priority: 1
version: 2
delegate: codex@spud10
labels: []
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
hold: null
hold_until: null
created_at: 2026-11-09T01:58:37.184Z
updated_at: 2026-11-09T01:59:41.257Z
started_at: 2026-11-09T01:59:41.257Z
---
Final Astra review found a cleanup error could replace an acknowledged write with a raw filesystem error. Preserve an existing callback failure or return typed post-publish status with the version in both write strategies.
