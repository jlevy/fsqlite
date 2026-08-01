// Child-process initializer for the concurrent-init test: each process opens the same
// fresh store dir and calls init(). Fenced init must let exactly one process build
// snapshot 0 while the rest converge on it, with no corruption or partial state.
//
// argv: <dir>

import { SnapshotStore } from '../src/index.ts'
import { STORE_OPTS } from '../test/fixture.ts'

const [dir = ''] = process.argv.slice(2)
new SnapshotStore(dir, STORE_OPTS).init()
process.stdout.write(JSON.stringify({ ok: true, pid: process.pid }) + '\n')
