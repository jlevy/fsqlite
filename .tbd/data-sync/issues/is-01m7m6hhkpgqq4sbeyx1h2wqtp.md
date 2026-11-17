---
type: is
id: is-01m7m6hhkpgqq4sbeyx1h2wqtp
title: "PR #9 B9: process.kill(child.pid ?? 0) kills the caller's process group when spawn fails"
kind: bug
status: closed
priority: 3
version: 2
labels: []
dependencies: []
parent_id: is-01m7m6hdd644jqw5x1wwj4axxn
created_at: 2026-11-17T07:29:03.094Z
updated_at: 2026-11-17T08:15:26.526Z
closed_at: 2026-11-17T08:15:26.526Z
close_reason: "Fixed in 97b63c2: w6.ts killChild throws when the child has no pid instead of signalling pid 0; the spike3 and combined patches no longer probe pid 0 in the owner wait."
resolution: null
duplicate_of: null
---
Review B https://github.com/jlevy/fsqlite/pull/9#pullrequestreview-5934384031. Low. fsqlite/w6.ts:228, 232.
