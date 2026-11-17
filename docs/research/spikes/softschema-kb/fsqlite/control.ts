// C15 control arm: plain SQLite through node:sqlite, with the same DDL, loader and W3
// queries as the fsqlite arm but no store, so the results separate what SQLite does from
// what the fsqlite protocol costs.
//
// Usage: node control.ts <rows.jsonl> <work-dir> --scale S0 [--warm 50]
//
// W1 runs twice: `indexes-first` declares every index before the load, which is the only
// order fsqlite allows (DDL is fixed at init); `indexes-after` loads the tables and then
// creates the indexes, SQLite's usual bulk-load order. Both commit one transaction with
// the default rollback journal and synchronous = FULL, so COMMIT is durable. W3 then runs
// on the indexes-first file. Writes w1-plain-sqlite.json and w3-plain-sqlite.json.

import { rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  forEachLineSync,
  isMain,
  maxRssMiB,
  nowMs,
  parseArgs,
  round,
  writeResult,
} from './common.ts'
import type { KbRow } from './common.ts'
import { BULK_PRAGMAS, countProblems } from './load.ts'
import { GenericLoader, genericDdl } from './mapping.ts'
import { runOnSnapshot } from './w3.ts'

function statements(ddl: string): { tables: string[]; indexes: string[] } {
  const all = ddl
    .split(/;\s*\n/)
    .map((s) => s.trim().replace(/;$/, ''))
    .filter(Boolean)
  return {
    tables: all.filter((s) => !s.startsWith('CREATE INDEX')),
    indexes: all.filter((s) => s.startsWith('CREATE INDEX')),
  }
}

export function plainLoad(
  rows: string,
  file: string,
  indexesFirst: boolean,
): Record<string, unknown> {
  rmSync(file, { force: true })
  rmSync(`${file}-journal`, { force: true })
  const t0 = nowMs()
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; ${BULK_PRAGMAS}`)
  const { tables, indexes } = statements(genericDdl())
  db.exec('BEGIN')
  for (const sql of indexesFirst ? [...tables, ...indexes] : tables) {
    db.exec(sql)
  }
  const tDdl = nowMs()
  const loader = new GenericLoader(db, true)
  let decodeMs = 0
  let addMs = 0
  forEachLineSync(rows, (line) => {
    const t = nowMs()
    const row = JSON.parse(line) as KbRow
    decodeMs += nowMs() - t
    const t2 = nowMs()
    loader.add(row)
    addMs += nowMs() - t2
  })
  const tLoad = nowMs()
  let indexMs = 0
  if (!indexesFirst) {
    for (const sql of indexes) {
      db.exec(sql)
    }
    indexMs = nowMs() - tLoad
  }
  const tIndex = nowMs()
  const problems = countProblems(db)
  const tVerify = nowMs()
  db.exec('COMMIT')
  const tCommit = nowMs()
  db.close()
  return {
    arm: `plain SQLite (${indexesFirst ? 'indexes-first' : 'indexes-after'})`,
    counts: loader.counts,
    count_problems: problems,
    phases: {
      ddl_ms: round(tDdl - t0),
      decode_ms: round(decodeMs),
      transform_ms: round(loader.transformMs),
      ingest_ms: round(addMs - loader.transformMs),
      index_ms: round(indexMs),
      verify_counts_ms: round(tVerify - tIndex),
      commit_durable_ms: round(tCommit - tVerify),
      ingest_through_durable_ms: round(tCommit - t0 - decodeMs),
    },
    total_ms: round(tCommit - t0),
    file_bytes: statSync(file).size,
    config: {
      journal_mode: 'DELETE',
      synchronous: 'FULL',
      bulk_pragmas: BULK_PRAGMAS,
      node: process.version,
    },
  }
}

function main(): void {
  const { flags, args } = parseArgs(process.argv.slice(2))
  const [rows, work] = args
  const scale = flags.scale ?? 'S0'
  if (!rows || !work) {
    throw new Error('usage: control.ts <rows.jsonl> <work-dir> --scale S0')
  }
  const after = plainLoad(rows, join(work, 'plain-after.sqlite'), false)
  rmSync(join(work, 'plain-after.sqlite'), { force: true })
  const file = join(work, 'plain.sqlite')
  const first = plainLoad(rows, file, true)
  console.log(
    writeResult(scale, 'w1-plain-sqlite', {
      workflow: 'W1 control (C15)',
      indexes_first: first,
      indexes_after: after,
      max_rss_mib: maxRssMiB(),
    }),
  )
  if (flags['skip-w3'] !== 'true') {
    const report = runOnSnapshot(file, scale, { warm: Number(flags.warm ?? 50) })
    console.log(
      writeResult(scale, 'w3-plain-sqlite', {
        workflow: 'W3',
        arm: 'plain SQLite file, held read connection, same SQL',
        ...report,
      }),
    )
  }
  rmSync(file, { force: true })
}

if (isMain(import.meta.url)) {
  main()
}
