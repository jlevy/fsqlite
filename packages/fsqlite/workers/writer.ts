// Child-process writer for the concurrency tests. Emits N transaction envelopes, each
// inserting a uniquely-keyed artifact + url_index row, then exits. Writers never
// coordinate: unique envelope paths make them conflict-free.
//
// argv: <dir> <writerId> <count>

import { SnapshotStore } from '../src/index.ts'
import { STORE_OPTS } from '../test/fixture.ts'

const [dir = '', writerId = 'w', countStr = '0'] = process.argv.slice(2)
const count = Number(countStr)
const store = new SnapshotStore(dir, STORE_OPTS)

let written = 0
for (let i = 0; i < count; i++) {
  const id = `art-${writerId}-${i}`
  const txId = store.write(writerId, (db) => {
    db.prepare('INSERT INTO artifacts VALUES (?, ?, ?)').run(id, `${writerId}#${i}`, new Date().toISOString())
    db.prepare('INSERT INTO url_index VALUES (?, ?, ?, ?)').run(
      `u-${writerId}-${i}`,
      `https://x/${writerId}/${i}`,
      id,
      new Date().toISOString(),
    )
  })
  if (txId) written++
}
process.stdout.write(JSON.stringify({ writerId, written }) + '\n')
