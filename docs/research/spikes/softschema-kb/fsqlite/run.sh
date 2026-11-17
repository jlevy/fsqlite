#!/usr/bin/env bash
# Run every fsqlite workflow at one scale, in order, and delete working stores once each
# is measured.
#
# Usage: fsqlite/run.sh S0|S1|S2 [--skip-direct-w2]
#
# Results go to results/fsqlite/<scale>/. Working stores go to $KB_SCRATCH/fsqlite-spike.
set -euo pipefail

SCALE=${1:?usage: run.sh <scale>}
HERE=$(cd "$(dirname "$0")" && pwd)
SCRATCH=${KB_SCRATCH:?set KB_SCRATCH to a private scratch directory}
WORK=$SCRATCH/fsqlite-spike/$SCALE
DELTAS=$SCRATCH/kb-corpora/$SCALE/deltas
NODE=(node --disable-warning=ExperimentalWarning)
cd "$HERE"
# The scale names directories this script deletes, so only known names pass.
case "$SCALE" in S0 | S1 | S2) ;; *) echo "run.sh: unknown scale $SCALE" >&2 && exit 2 ;; esac

# W1 (DirectStore and SnapshotStore), then the plain SQLite control for W1 and W3.
"${NODE[@]}" w1.ts --scale "$SCALE"
"${NODE[@]}" control.ts "$WORK/rows.jsonl" "$WORK" --scale "$SCALE"
# Disk budget: from S2 up, drop the intermediate rows once W1 and the control are measured.
# W6 then skips its crash tests, which need them (they run at S0 and S1).
case "$SCALE" in S0 | S1) ;; *) rm -f "$WORK/rows.jsonl" ;; esac

# W3: canonical (substring scan, shared BFS), FTS5 sidecar, plan audit, and the in-engine
# recursive-CTE path with a timeout.
"${NODE[@]}" w3.ts "$WORK/store-direct" --scale "$SCALE"
"${NODE[@]}" w3.ts "$WORK/store-direct" --scale "$SCALE" --name w3-fts --fts "$WORK/search-fts.sqlite"
"${NODE[@]}" plans.ts "$WORK/store-direct" --scale "$SCALE"
"${NODE[@]}" w3.ts "$WORK/store-direct" --scale "$SCALE" --name w3-path-cte --only path \
  --path-cte --warm 5 --timeout-ms 60000

# W2: delta batches with 4 writers and a reader, trickle and sustained runs, conflicts.
"${NODE[@]}" w2.ts "$WORK/store-direct" --scale "$SCALE" --deltas "$DELTAS"
if [ "${2:-}" != --skip-direct-w2 ]; then
  "${NODE[@]}" w2.ts "$WORK/store-direct" --scale "$SCALE" --deltas "$DELTAS" --strategy direct
fi
"${NODE[@]}" trickle.ts "$WORK/store-direct" --scale "$SCALE" --delta "$DELTAS/p20" \
  --seconds "${TRICKLE_SECONDS:-20}" --reps "${TRICKLE_REPS:-3}"
"${NODE[@]}" conflict.ts "$WORK/store-direct" --scale "$SCALE"

# W4 (with a full-rebuild check below S2), W5, W6.
VERIFY=--verify
[ "$SCALE" = S2 ] && VERIFY=
"${NODE[@]}" w4.ts --scale "$SCALE" $VERIFY
"${NODE[@]}" w5.ts --scale "$SCALE"
"${NODE[@]}" w6.ts --scale "$SCALE"
