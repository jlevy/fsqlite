---
type: is
id: is-01kyxzdtymyb777sp6hm4jf5mt
title: "PR #1 review I4: avoid CLI output truncation from process.exit"
kind: bug
status: closed
priority: 1
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels: []
dependencies: []
parent_id: is-01kyxzayw4jqyc0tty925kttr0
created_at: 2026-08-01T06:15:49.459Z
updated_at: 2026-08-01T06:18:04.693Z
closed_at: 2026-08-01T06:18:04.692Z
close_reason: "Fixed: CLI records exit codes without forcing immediate termination after output."
---
PR #1 engineering review I4. File: packages/fsqlite/src/cli/index.ts. Set process.exitCode and return after console output so piped JSON output can flush.
