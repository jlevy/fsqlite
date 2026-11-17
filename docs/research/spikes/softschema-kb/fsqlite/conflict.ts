// C20 conflicting writes: two SnapshotStore writers capture from the same head and update
// the same record with different values. For each conflict policy, report the published
// value and whether both values stay recoverable from the store's own envelopes.
//
// Usage: node conflict.ts <base-store> --scale S0 [--work <dir>]
//
// Recovery reads a kept envelope (tx/applied or tx/quarantine, the f1.0 layout) and
// applies its changeset to a scratch copy of the base snapshot with node:sqlite's
// applyChangeset, so it needs no fsqlite internals.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SnapshotStore } from './fsq.ts'
import { WORK_DIR, cloneStore, isMain, parseArgs, writeResult } from './common.ts'
import { GENERIC_POLICY, GENERIC_SCHEMA_VERSION, genericDdl } from './mapping.ts'
import { queryInstances } from './w3.ts'

type Action = 'lww' | 'union' | 'strict'

function bioOf(db: DatabaseSync, id: string): string | null {
  const row = db.prepare("SELECT payload ->> '$.bio' AS bio FROM entity WHERE id = ?").get(id) as
    { bio: string | null } | undefined
  return row?.bio ?? null
}

/** Each kept envelope's value for the record, replayed onto a copy of the base snapshot. */
function recoverable(dir: string, baseSnapshot: string, id: string, scratch: string) {
  const out: { where: string; writer: string; bio: string | null }[] = []
  for (const where of ['applied', 'quarantine']) {
    const root = join(dir, 'tx', where)
    if (!existsSync(root)) {
      continue
    }
    for (const txn of readdirSync(root).sort()) {
      const changeset = join(root, txn, 'changeset.bin')
      if (!existsSync(changeset)) {
        continue
      }
      copyFileSync(baseSnapshot, scratch)
      const db = new DatabaseSync(scratch)
      db.applyChangeset(readFileSync(changeset), { onConflict: () => 2 })
      const manifest = JSON.parse(readFileSync(join(root, txn, 'manifest.json'), 'utf8')) as {
        writer_id: string
      }
      out.push({ where, writer: manifest.writer_id, bio: bioOf(db, id) })
      db.close()
      rmSync(scratch, { force: true })
    }
  }
  return out
}

function main(): void {
  const { flags, args } = parseArgs(process.argv.slice(2))
  const [base] = args
  const scale = flags.scale ?? 'S0'
  const work = join(flags.work ?? WORK_DIR, scale, 'conflict')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const id = String(queryInstances(scale).find((q) => q.name === 'record.person')?.params.id)
  const results: Record<string, unknown> = {}
  for (const action of ['lww', 'union', 'strict'] as Action[]) {
    const dir = join(work, action)
    cloneStore(base ?? '', dir)
    const policy = Object.fromEntries(Object.keys(GENERIC_POLICY).map((t) => [t, action]))
    const store = new SnapshotStore(dir, {
      schema: genericDdl(),
      schemaVersion: GENERIC_SCHEMA_VERSION,
      conflictPolicy: policy,
    }).init()
    const baseSnapshot = store.snapshotPath(store.currentVersion())
    const before = store.read((db) => bioOf(db, id))
    const update = (value: string) => (db: DatabaseSync) => {
      db.prepare("UPDATE entity SET payload = json_set(payload, '$.bio', ?) WHERE id = ?").run(
        value,
        id,
      )
      db.prepare('UPDATE search_text SET text = ? WHERE id = ? AND rank = 2').run(
        value.toLowerCase(),
        id,
      )
    }
    // Both capture from the same head before either is reconciled.
    const txA = store.write('agentA', update('Bio from agent A.'))
    const txB = store.write('agentB', update('Bio from agent B.'))
    const reconcile = store.reconcile()
    const published = store.read((db) => bioOf(db, id))
    results[action] = {
      envelope_order: [txA, txB].sort(),
      reconcile,
      before,
      published,
      winner:
        published === 'Bio from agent A.'
          ? 'agentA'
          : published === 'Bio from agent B.'
            ? 'agentB'
            : 'neither',
      recoverable: recoverable(dir, baseSnapshot, id, join(work, 'scratch.sqlite')),
      quarantine: existsSync(join(dir, 'tx', 'quarantine'))
        ? readdirSync(join(dir, 'tx', 'quarantine'))
        : [],
    }
    rmSync(dir, { recursive: true, force: true })
  }
  rmSync(work, { recursive: true, force: true })
  console.log(
    writeResult(scale, 'w2-conflict', {
      workflow: 'W2 conflicting writes (C20)',
      record: id,
      field: 'payload.bio (and its search_text rank 2 row)',
      note: 'Envelopes apply in byte-sorted tx-id order; tx ids start with a millisecond timestamp, so agentA (captured first) applies first.',
      results,
    }),
  )
}

if (isMain(import.meta.url)) {
  main()
}
