---
type: is
id: is-01m7m6hhxhdk7bt2ndghp44wcs
title: "PR #9 B10: spike scratch defaults and deletion scope"
kind: bug
status: closed
priority: 3
version: 2
labels: []
dependencies: []
parent_id: is-01m7m6hdd644jqw5x1wwj4axxn
created_at: 2026-11-17T07:29:03.409Z
updated_at: 2026-11-17T08:15:27.526Z
closed_at: 2026-11-17T08:15:27.526Z
close_reason: "Fixed in b8dde0c, 97b63c2, and c9c3dcd, except falkordb/w1_load.py's --data deletion, deferred to fsq-lyu3 while the quiet pass runs that script in place: KB_SCRATCH required everywhere (common.ts throws on unset or empty, run.sh and run_r2.sh use :?, falkordb/run.py reads KB_SCRATCH in place of SPIKE_SCRATCH), --scale checked against known names, output directories deleted only with a marker the tool wrote, node -e paths passed as argv and KB_SCRATCH assigned before export in the spike3 and combined patches; the patched copies' remaining defaults are noted in the READMEs."
resolution: null
duplicate_of: null
---
Review B https://github.com/jlevy/fsqlite/pull/9#pullrequestreview-5934384031. Low. common.ts, run.sh, run_r2.sh, falkordb/run.py, rmtree sites, node -e interpolation.
