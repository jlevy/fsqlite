---
type: is
id: is-01kyxzdtpec4ba271jdy6y1dgb
title: "PR #1 review I3: make permission regression portable under root"
kind: bug
status: closed
priority: 2
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels: []
dependencies: []
parent_id: is-01kyxzayw4jqyc0tty925kttr0
created_at: 2026-08-01T06:15:49.197Z
updated_at: 2026-08-01T06:18:04.474Z
closed_at: 2026-08-01T06:18:04.473Z
close_reason: "Fixed: the DAC permission regression is skipped only for root."
---
PR #1 engineering review I3. File: packages/fsqlite/test/unit.test.ts:166-186. Skip the DAC-permission assertion when the test process is root.
