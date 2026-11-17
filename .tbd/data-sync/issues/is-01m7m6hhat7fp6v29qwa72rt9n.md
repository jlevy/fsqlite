---
type: is
id: is-01m7m6hhat7fp6v29qwa72rt9n
title: "PR #9 B8: batch path values reach the filesystem without containment"
kind: bug
status: closed
priority: 3
version: 2
labels: []
dependencies: []
parent_id: is-01m7m6hdd644jqw5x1wwj4axxn
created_at: 2026-11-17T07:29:02.810Z
updated_at: 2026-11-17T08:15:26.323Z
closed_at: 2026-11-17T08:15:26.322Z
close_reason: "Fixed in b8dde0c: corpus/safepath.rel_path rejects absolute and .. paths; delta2.apply_batch and parse_kb.emit_delta2 refuse them at admission before any read or write, and both exporters check stored paths before writing. Probed with a ../../etc/passwd batch: refused, nothing written."
resolution: null
duplicate_of: null
---
Review B https://github.com/jlevy/fsqlite/pull/9#pullrequestreview-5934384031. Low. corpus/delta2.py:313-314, fsqlite/parse_kb.py:518, fsqlite/export_kb.py:115-131, falkordb/w5_export.py:94-100.
