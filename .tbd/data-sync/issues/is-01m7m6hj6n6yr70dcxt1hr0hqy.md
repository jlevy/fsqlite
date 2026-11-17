---
type: is
id: is-01m7m6hj6n6yr70dcxt1hr0hqy
title: "PR #9 B11: excluded output files carry machine-local paths and no check reads them"
kind: bug
status: closed
priority: 3
version: 2
labels: []
dependencies: []
parent_id: is-01m7m6hdd644jqw5x1wwj4axxn
created_at: 2026-11-17T07:29:03.701Z
updated_at: 2026-11-17T08:15:26.730Z
closed_at: 2026-11-17T08:15:26.730Z
close_reason: "Fixed in 60361a4: 210 result and expected JSON files rewritten (repo root to repo-relative, session scratchpad to <scratch>); check-docs parses every .json under docs/ and applies the machine-local path rule, now including /tmp/claude-N/ scratch paths."
resolution: null
duplicate_of: null
---
Review B https://github.com/jlevy/fsqlite/pull/9#pullrequestreview-5934384031. Low. check-doc-claims.mjs, .prettierignore, result JSON.
