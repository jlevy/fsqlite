// Runnable end-to-end walkthrough of the fsqlite engine. Shows: two writers off the same
// base (incl. a same-PK clash resolved by last-writer-wins), a reconcile that publishes
// an immutable snapshot, the on-disk shape, idempotent replay, and a sealed single-file
// export.
//
//   node examples/demo.ts

import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnapshotStore } from '../src/index.ts'

const SCHEMA = `
CREATE TABLE artifacts (artifact_id TEXT PRIMARY KEY NOT NULL, title TEXT, updated_at TEXT NOT NULL);
CREATE TABLE url_index (url_hash TEXT PRIMARY KEY NOT NULL, normalized_url TEXT NOT NULL, blob_id TEXT NOT NULL, fetched_at TEXT NOT NULL);
`
const POLICY = { url_index: 'lww', artifacts: 'lww', '*': 'strict' } as const

const dir = mkdtempSync(join(tmpdir(), 'fsqlite-demo-'))
const store = new SnapshotStore(dir, {
  schema: SCHEMA,
  schemaVersion: 1,
  conflictPolicy: { ...POLICY },
}).init()

const tree = (label: string): void => {
  console.log(`\n# ${label}`)
  for (const sub of ['', 'snapshots', 'tx/pending', 'tx/applied']) {
    const p = join(dir, sub)
    if (!existsSync(p)) {
      continue
    }
    const entries = readdirSync(p).filter((e) => !e.startsWith('.'))
    console.log(`  ${sub || '.'}:`, entries.join('  ') || '(empty)')
  }
  console.log('  current →', store.currentVersion())
}

// Two writers seed off the SAME base (v0) with no coordination; B clashes on art_1.
store.write('agentA', (db) => {
  db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('art_1', 'Alpha (by A)', 't1')
  db.prepare('INSERT INTO url_index VALUES (?,?,?,?)').run('u_a', 'https://a', 'blob_a', 't1')
})
store.write('agentB', (db) => {
  db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('art_1', 'Alpha (by B)', 't2') // last-writer-wins
  db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('art_2', 'Beta', 't2')
})
tree('after two concurrent writers — envelopes pending, catalog NOT yet updated')

const res = store.reconcile()
console.log('\nreconcile:', JSON.stringify(res))
tree('after reconcile — folded into an immutable snapshot, envelopes archived')

console.log(
  '\nartifacts now:',
  JSON.stringify(
    store.read((db) =>
      db.prepare('SELECT artifact_id, title FROM artifacts ORDER BY artifact_id').all(),
    ),
  ),
)

const res2 = store.reconcile()
console.log('\nreplay reconcile (nothing pending):', JSON.stringify(res2))

console.log('\nvalidate:', JSON.stringify(store.validate()))
const sealed = join(dir, 'sealed.sqlite')
store.seal(sealed)
console.log(
  'sealed single-file export →',
  sealed,
  existsSync(sealed) ? '(openable by any sqlite3)' : '(MISSING)',
)

rmSync(dir, { recursive: true, force: true })
