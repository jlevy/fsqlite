---
type: is
id: is-01m7m6hk180zyf7kav1ja5bdsj
title: "PR #9 B14: uv run in the fsqlite arm lacks --no-build and an exact pyyaml pin"
kind: bug
status: closed
priority: 4
version: 2
labels: []
dependencies: []
parent_id: is-01m7m6hdd644jqw5x1wwj4axxn
created_at: 2026-11-17T07:29:04.552Z
updated_at: 2026-11-17T08:15:27.328Z
closed_at: 2026-11-17T08:15:27.328Z
close_reason: "Fixed in 97b63c2: the fsqlite arm's uv run adds --no-build and pyyaml==6.0.3 (w1.ts, w2.ts, README); confirmed the pinned run resolves pyyaml 6.0.3."
resolution: null
duplicate_of: null
---
Review B https://github.com/jlevy/fsqlite/pull/9#pullrequestreview-5934384031. Suggestion. fsqlite/w1.ts:27-37, w2.ts:48-58.
