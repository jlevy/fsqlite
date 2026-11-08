// Deterministic store seeder for the CLI golden test. Builds a known fsqlite store in
// <dir> via the public API, optionally planting a fault so the CLI's validate exit codes
// (2 in-flight, 3 corrupt) can be exercised from the shell. The `plainfile`/`corrupt-sqlite`
// modes instead write a plain SQLite file (no fsqlite layer) for the stats/doctor goldens.
//
//   fsqlite-seed <dir>  [orphan|corrupt|corrupt-head]
//   fsqlite-seed <file> [plainfile|corrupt-sqlite]

import { copyFileSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs'
import { SnapshotStore } from '../../src/index.ts'
import * as driver from '../../src/driver.ts'
import { STORE_OPTS } from '../fixture.ts'

const [dir = '', fault] = process.argv.slice(2)
if (!dir) {
  console.error('seed: needs <dir>')
  process.exit(64)
}

// Plain-SQLite fixtures: a deterministic file with no fsqlite layer.
if (fault === 'plainfile' || fault === 'corrupt-sqlite') {
  const rows = fault === 'corrupt-sqlite' ? 1000 : 3
  const db = driver.open(dir)
  db.exec('PRAGMA application_id = 305419896;') // 0x12345678
  db.exec('PRAGMA user_version = 7;')
  db.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT);')
  // One transaction: an autocommit insert per row syncs the file each time.
  db.exec('BEGIN')
  const ins = db.prepare('INSERT INTO widgets VALUES (?, ?)')
  for (let i = 0; i < rows; i++) {
    ins.run(i, `w${i}`.padEnd(40, 'x'))
  }
  db.exec('COMMIT')
  db.close()
  if (fault === 'corrupt-sqlite') {
    const fd = openSync(dir, 'r+') // scribble a page deep in the file; header stays valid
    try {
      writeSync(fd, Buffer.alloc(2048, 0xff), 0, 2048, 4096)
    } finally {
      closeSync(fd)
    }
    console.log(`seeded ${dir} (corrupt sqlite)`)
  } else {
    console.log(`seeded ${dir} (plain sqlite)`)
  }
  process.exit(0)
}

const store = new SnapshotStore(dir, STORE_OPTS).init()
store.write('seed', (db) => db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('a', 'A', 't'))
store.reconcile() // sealed v1

if (fault === 'corrupt-head') {
  // A head with a damaged page: identity rows stay readable but integrity_check fails, so
  // the clean v1 is the only recovery point and gc must refuse to collect it.
  store.write('seed', (db) => {
    const ins = db.prepare('INSERT INTO artifacts VALUES (?,?,?)')
    for (let i = 0; i < 400; i++) {
      ins.run(`b${i}`, `t${i}`.repeat(8), 't')
    }
  })
  store.reconcile() // v2
  const fd = openSync(store.snapshotPath(2), 'r+')
  try {
    writeSync(fd, Buffer.alloc(2048, 0xff), 0, 2048, 4096)
  } finally {
    closeSync(fd)
  }
  console.log(`seeded ${dir} (corrupt head v2)`)
  process.exit(0)
}

if (fault === 'orphan') {
  // An orphan snapshot ahead of `current` so in-flight-capture so validate exit 2.
  copyFileSync(store.snapshotPath(1), store.snapshotPath(2))
  console.log(`seeded ${dir} (in-flight: orphan v2)`)
} else if (fault === 'corrupt') {
  // A garbage pointer is corrupt, so validate exits 3.
  writeFileSync(store.currentPath, 'xxx')
  console.log(`seeded ${dir} (corrupt pointer)`)
} else {
  console.log(`seeded ${dir} (sealed v1)`)
}
