#!/usr/bin/env bash
# Run every fsqlite workflow at one scale: W1, W3 (and its variants), W2, W4, W5, W6.
#
# Usage: fsqlite/run.sh S0|S1|S2 [--skip-direct-w2]
#
# Results go to results/fsqlite/<scale>/. Working stores go to $KB_SCRATCH/fsqlite-spike.
set -euo pipefail

SCALE=${1:?usage: run.sh <scale>}
HERE=$(cd "$(dirname "$0")" && pwd)
SCRATCH=${KB_SCRATCH:-/tmp/claude-0/-home-user/bac81f03-965b-51f3-b055-bed7bf70e318/scratchpad}
WORK=$SCRATCH/fsqlite-spike/$SCALE
CORPORA=$SCRATCH/kb-corpora
NODE=(node --disable-warning=ExperimentalWarning)
PY=(uv run -q --no-project --with pyyaml --exclude-newer 2026-11-03 python)
cd "$HERE"

"${NODE[@]}" w1.ts --scale "$SCALE"
"${NODE[@]}" w3.ts "$WORK/store-direct" --scale "$SCALE"
"${NODE[@]}" w3.ts "$WORK/store-direct" --scale "$SCALE" --name w3-fts --fts "$WORK/search-fts.sqlite"
if [ "$SCALE" != S2 ] && [ "$SCALE" != S3 ]; then
  "${NODE[@]}" w3.ts "$WORK/store-direct" --scale "$SCALE" --name w3-cte --path-cte --warm 10
fi

# W2 deltas: the shared corpus's batches when present, else generated with its generator.
DELTAS=$CORPORA/$SCALE/deltas
if [ ! -d "$DELTAS" ]; then
  DELTAS=$SCRATCH/fsqlite-spike/$SCALE-corpus/deltas
  if [ ! -d "$DELTAS" ]; then
    mkdir -p "$SCRATCH/fsqlite-spike/$SCALE-corpus"
    KB=$CORPORA/$SCALE/kb
    [ "$SCALE" = S0 ] && KB=$HERE/../../../../../attic/paraverse/vendor/universe2026-md/kb
    ln -sfn "$(cd "$KB" && pwd)" "$SCRATCH/fsqlite-spike/$SCALE-corpus/kb"
    "${PY[@]}" "$HERE/../corpus/delta.py" --scale "$SCALE" --corpus "$SCRATCH/fsqlite-spike/$SCALE-corpus"
  fi
fi
"${NODE[@]}" w2.ts "$WORK/store-direct" --scale "$SCALE" --deltas "$DELTAS"
if [ "${2:-}" != --skip-direct-w2 ]; then
  "${NODE[@]}" w2.ts "$WORK/store-direct" --scale "$SCALE" --deltas "$DELTAS" --strategy direct
fi

"${NODE[@]}" w4.ts --scale "$SCALE"
"${NODE[@]}" w5.ts --scale "$SCALE"
"${NODE[@]}" w6.ts --scale "$SCALE"
