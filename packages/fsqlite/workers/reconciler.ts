// Child-process reconciler for the racing-reconciler tests. Runs reconcile in a loop
// until the pending tail is empty, then exits. Multiple of these run at once to prove
// exactly-once publish under optimistic concurrency on `current`.
//
// argv: <dir> <maxPasses>

import { SnapshotStore } from '../src/index.ts'
import { STORE_OPTS } from '../test/fixture.ts'

const [dir = '', maxPassesStr = '50'] = process.argv.slice(2)
const maxPasses = Number(maxPassesStr)
const store = new SnapshotStore(dir, STORE_OPTS)

let totalApplied = 0
let passes = 0
for (let p = 0; p < maxPasses; p++) {
  passes++
  const res = store.reconcile({ lockOpts: { timeoutMs: 10_000, staleMs: 5_000, pollMs: 10 } })
  totalApplied += res.applied
  if (store.pendingTxns().length === 0) {
    break
  }
}
process.stdout.write(JSON.stringify({ pid: process.pid, totalApplied, passes }) + '\n')
