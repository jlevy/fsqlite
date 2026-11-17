---
type: is
id: is-01m7m95e8p886atr1ghq9h6hv0
title: "PR #9 B10 follow-up: marker check for falkordb/w1_load.py --data deletion"
kind: task
status: open
priority: 3
version: 1
labels: []
dependencies: []
parent_id: is-01m7m6hdd644jqw5x1wwj4axxn
created_at: 2026-11-17T08:14:52.182Z
updated_at: 2026-11-17T08:14:52.182Z
---
Review B (https://github.com/jlevy/fsqlite/pull/9#pullrequestreview-5934384031) B10 asks every rmtree of a caller-named directory to require a marker the tool created. Done for corpus/, delta2, overlay, both exporters. falkordb/w1_load.py (rmtree of --data, line 122-123) is left: the quiet benchmark pass runs it in place from the working tree with data directories that the current code created without a marker, so the check would stop its next repetition. Apply corpus/safepath.replace_dir there once the quiet pass has finished.
