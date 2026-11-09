---
type: is
id: is-01m6ydra3v1m26y0d0m9m9jza9
title: CLI, API, error-model, and test-suite fixes from the 2026-11 review
kind: task
status: closed
priority: 2
version: 2
labels: []
dependencies: []
parent_id: is-01m6yd8g37a4pkt9xb3pw7x8tf
created_at: 2026-11-08T20:31:47.322Z
updated_at: 2026-11-09T02:06:35.139Z
closed_at: 2026-11-09T02:06:35.138Z
close_reason: "Implemented by the comprehensive update merged in PR #5 and verified with pnpm verify and GitHub CI."
resolution: null
duplicate_of: null
---
From opus-ts.md findings T4-T28, excluding T1-T3 (separate beads) and T12 (folded into the core robustness bead with C11). Covers strict CLI argument parsing, consistent exit codes, typed errors, fsinspect fixes, the cli import side effect, golden/stderr/--json coverage, realistic concurrency tests, coverage gaps, and the slow fixture.
