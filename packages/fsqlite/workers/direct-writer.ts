// Child-process direct writer for the direct-mode concurrency test. Each process does N
// synchronous copy, mutate, and publish operations; the publish lock serializes them across
// processes. Every write becomes its own published version; zero loss.
//
// argv: <dir> <writerId> <count>

import { DirectStore } from '../src/index.ts'
import { STORE_OPTS } from '../test/fixture.ts'

const [dir = '', writerId = 'd', countStr = '0'] = process.argv.slice(2)
const count = Number(countStr)
const store = new DirectStore(dir, STORE_OPTS)

let written = 0
for (let i = 0; i < count; i++) {
  store.write(
    (db) => {
      db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run(
        `art-${writerId}-${i}`,
        `${writerId}#${i}`,
        new Date().toISOString(),
      )
    },
    { lockOpts: { timeoutMs: 20_000, staleMs: 8_000, pollMs: 8 } },
  )
  written++
}
process.stdout.write(JSON.stringify({ writerId, written }) + '\n')
