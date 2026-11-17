#!/usr/bin/env bash
# Round 2: run the fsqlite arm on a round-2 corpus (S1-r2 or S2-r2) and its v2 batches,
# then delete the working stores.
#
# Usage: fsqlite/run_r2.sh S1-r2|S2-r2
set -euo pipefail

SCALE=${1:?usage: run_r2.sh <scale>-r2}
HERE=$(cd "$(dirname "$0")" && pwd)
SCRATCH=${KB_SCRATCH:-/tmp/claude-0/-home-user/bac81f03-965b-51f3-b055-bed7bf70e318/scratchpad}
WORK=$SCRATCH/fsqlite-spike/$SCALE
DELTAS=$SCRATCH/kb-corpora/$SCALE/deltas
NODE=(node --disable-warning=ExperimentalWarning)
cd "$HERE"

# W1 with the schema check as a phase, then the plain SQLite control (W1 and W3 v2).
"${NODE[@]}" w1.ts --scale "$SCALE" --validate
"${NODE[@]}" control.ts "$WORK/rows.jsonl" "$WORK" --scale "$SCALE"
rm -f "$WORK/rows.jsonl"

# W3 v2: the substring scan, the FTS5 sidecar, and the table-plan audit.
"${NODE[@]}" w3.ts "$WORK/store-direct" --scale "$SCALE"
"${NODE[@]}" w3.ts "$WORK/store-direct" --scale "$SCALE" --name w3-fts --fts "$WORK/search-fts.sqlite"
"${NODE[@]}" plans.ts "$WORK/store-direct" --scale "$SCALE"

# W2 v2: 4 writers with a reader (p05 checked against the oracle), then one writer in line
# order through both arms, the trickle batches, and the invalid-record batch.
"${NODE[@]}" w2.ts "$WORK/store-direct" --scale "$SCALE" --deltas "$DELTAS"
"${NODE[@]}" w2v2.ts "$WORK/store-direct" --scale "$SCALE"

rm -rf "$WORK"
