#!/usr/bin/env node
// fsqlite CLI: operate a store from the shell with no server and no app code.
//
// The info, validate, gc, seal, and repair commands work on any fsqlite store without
// knowing the caller's schema or merge policy. They operate on snapshots, pointers,
// envelopes, and leases rather than table data. Reconcile remains a library call because
// folding envelopes needs the application's per-table merge policy.
//
// Usage:
//   fsqlite info      <dir>
//   fsqlite validate  <dir>            # exit 0 sealed/live, 2 in-flight, 3 corrupt
//   fsqlite stats     <path> [--json]  # facts about any SQLite file OR fsqlite store
//   fsqlite gc        <dir> [--retain N]
//   fsqlite seal      <dir> <out.sqlite>
//   fsqlite repair    <dir>
//   fsqlite fsinspect <dir> [--json]   # probe a path's filesystem for fsqlite-safety
//   fsqlite doctor    <path> [--json] [--fix]  # health of any SQLite file OR fsqlite store

import { existsSync, readdirSync } from 'node:fs'
import { SnapshotStore } from '../snapshotStore.ts'
import { inspect, formatReport } from '../fsinspect.ts'
import { capabilities } from '../driver.ts'
import { isSqliteFile, sqliteFacts, integrityReport, type SqliteFacts } from '../sqliteFacts.ts'
import { hasStoreMarker } from '../storeFormat.ts'
import type { StoreValidationState } from '../types.ts'

// Exit cleanly when output is piped to a closed reader (e.g. `fsqlite info <dir> | head`).
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      process.exit(0)
    }
    throw err
  })
}

const [cmd, dir, ...rest] = process.argv.slice(2)
const fail = (msg: string): never => {
  console.error(`fsqlite: ${msg}`)
  process.exit(64)
}
const flag = (name: string, dflt: string): string => {
  const i = rest.indexOf(name)
  if (i < 0) {
    return dflt
  }
  const val = rest[i + 1]
  // `--retain` with no value (or another flag as the value) must not silently become NaN.
  if (val === undefined || val.startsWith('-')) {
    return fail(`${name} requires a value`)
  }
  return val
}
const json = rest.includes('--json')

const exitCodeForState = (state: StoreValidationState): number => {
  switch (state) {
    case 'sealed':
    case 'live':
      return 0
    case 'in-flight-capture':
      return 2
    case 'invalid':
    case 'corrupt':
      return 3
    case 'unsupported':
      return 4
    case 'not-a-store':
      return 64
  }
}

// stats/doctor span any SQLite path: an fsqlite store directory, a plain SQLite file, or
// neither. A store declares itself with fsqlite.json; a plain file carries the SQLite header.
function classifyPath(p: string): 'store' | 'sqlite-file' | 'unknown' {
  if (hasStoreMarker(p)) {
    return 'store'
  }
  return isSqliteFile(p) ? 'sqlite-file' : 'unknown'
}
const countDir = (p: string, suffix: string): number =>
  existsSync(p) ? readdirSync(p).filter((f) => f.endsWith(suffix)).length : 0

function printSqliteFacts(f: SqliteFacts, indent: string): void {
  console.log(`${indent}sqlite_version: ${f.sqliteVersion}`)
  console.log(`${indent}page_size: ${f.pageSize}`)
  console.log(`${indent}page_count: ${f.pageCount}`)
  console.log(`${indent}file_bytes: ${f.fileBytes}`)
  console.log(`${indent}application_id: ${f.applicationId}`)
  console.log(`${indent}user_version: ${f.userVersion}`)
  console.log(`${indent}journal_mode: ${f.journalMode}`)
  console.log(
    `${indent}tables: ${f.tables.map((t) => `${t.name}=${t.rows}`).join(' ') || '(none)'}`,
  )
}

function main(): void {
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(
      'usage: fsqlite <info|validate|stats|gc|seal|repair|fsinspect|doctor> <path> [args]',
    )
    process.exit(cmd ? 0 : 64)
    return
  }
  if (!dir) {
    return fail(`'${cmd}' needs a <path>`)
  }

  // fsinspect works on any path (no store required), so handle it before constructing a store.
  if (cmd === 'fsinspect') {
    const report = inspect(dir)
    console.log(rest.includes('--json') ? JSON.stringify(report, null, 2) : formatReport(report))
    process.exit(report.verdict.fsqliteSafe ? 0 : 1)
  }

  // stats/doctor work on any SQLite path, so classify before assuming a store.
  if (cmd === 'stats') {
    const kind = classifyPath(dir)
    if (kind === 'unknown') {
      fail(`'${dir}' is neither an fsqlite store nor a SQLite file`)
    }
    if (kind === 'sqlite-file') {
      const f = sqliteFacts(dir)
      if (json) {
        console.log(JSON.stringify({ path: dir, kind: 'plain-sqlite', sqlite: f }, null, 2))
      } else {
        console.log(`fsqlite stats: ${dir}`)
        console.log('  kind: plain-sqlite (no fsqlite layer)')
        printSqliteFacts(f, '  ')
      }
      process.exit(0)
    }
    const store = new SnapshotStore(dir)
    const v = store.validate()
    let cur: number | null = null
    try {
      cur = store.currentVersion()
    } catch {
      /* a corrupt pointer leaves the version unreadable; report what we can */
    }
    const fsqlite = {
      current: cur,
      snapshots: store.snapshotVersions().length,
      pending: store.pendingTxns().length,
      applied: countDir(store.txApplied, '.txn'),
      quarantine: countDir(store.txQuarantine, '.txn'),
      leases: countDir(store.leaseDir, '.lease'),
      state: v.state,
    }
    const snapshot =
      cur !== null && existsSync(store.snapshotPath(cur))
        ? sqliteFacts(store.snapshotPath(cur))
        : null
    if (json) {
      console.log(JSON.stringify({ path: dir, kind: 'fsqlite-store', fsqlite, snapshot }, null, 2))
    } else {
      console.log(`fsqlite stats: ${dir}`)
      console.log('  kind: fsqlite-store')
      console.log(`  current: ${fsqlite.current ?? '(unreadable)'}`)
      console.log(`  snapshots: ${fsqlite.snapshots}`)
      console.log(
        `  pending: ${fsqlite.pending}  applied: ${fsqlite.applied}  quarantine: ${fsqlite.quarantine}`,
      )
      console.log(`  leases: ${fsqlite.leases}`)
      console.log(`  state: ${fsqlite.state}`)
      if (snapshot) {
        console.log(`  current snapshot (SQLite):`)
        printSqliteFacts(snapshot, '    ')
      }
    }
    process.exit(0)
  }

  if (cmd === 'doctor') {
    const kind = classifyPath(dir)
    if (kind === 'unknown') {
      fail(`'${dir}' is neither an fsqlite store nor a SQLite file`)
    }
    if (kind === 'sqlite-file') {
      const problems = integrityReport(dir)
      const ok = problems.length === 0
      if (json) {
        console.log(
          JSON.stringify(
            { path: dir, kind: 'plain-sqlite', integrity: ok ? 'ok' : problems },
            null,
            2,
          ),
        )
      } else {
        console.log(`fsqlite doctor: ${dir}`)
        console.log('  kind: plain-sqlite (no fsqlite layer)')
        console.log(`  integrity: ${ok ? 'ok' : problems.join('; ')}`)
      }
      process.exit(ok ? 0 : 3)
    }
    const caps = capabilities()
    const store = new SnapshotStore(dir)
    let v = store.validate()
    const actions: string[] = []
    if (rest.includes('--fix') && (v.state === 'in-flight-capture' || v.state === 'corrupt')) {
      actions.push(...store.repair().actions)
      v = store.validate()
    }
    const out = {
      dir,
      kind: 'fsqlite-store',
      capabilities: caps,
      store: v,
      ...(actions.length ? { repaired: actions } : {}),
    }
    if (json) {
      console.log(JSON.stringify(out, null, 2))
    } else {
      console.log(`fsqlite doctor: ${dir}`)
      console.log(
        `  binding: session=${caps.session} backup=${caps.backup} rebaser=${caps.rebaser}`,
      )
      if (actions.length) {
        console.log(`  repaired: ${actions.join('; ')}`)
      }
      console.log(`  store: ${v.state}${v.issues.length ? ': ' + v.issues.join('; ') : ''}`)
      if (v.constraints) {
        console.log(`  constraints: foreign_key_violations=${v.constraints.foreignKeyViolations}`)
      }
    }
    process.exit(exitCodeForState(v.state))
  }

  if (!hasStoreMarker(dir)) {
    fail(`'${dir}' is not an fsqlite store (missing fsqlite.json)`)
  }
  const store = new SnapshotStore(dir) // no schema/policy needed for these ops
  switch (cmd) {
    case 'info': {
      const v = store.validate()
      console.log(
        JSON.stringify(
          {
            dir,
            current: store.currentVersion(),
            state: v.state,
            snapshots: store.snapshotVersions(),
            pending: store.pendingTxns().length,
            issues: v.issues,
          },
          null,
          2,
        ),
      )
      break
    }
    case 'validate': {
      const v = store.validate()
      console.log(`${v.state}${v.issues.length ? ': ' + v.issues.join('; ') : ''}`)
      process.exit(exitCodeForState(v.state))
      break
    }
    case 'gc': {
      const retain = Number(flag('--retain', '3'))
      if (!Number.isInteger(retain) || retain < 0) {
        fail('--retain must be a non-negative integer')
      }
      const r = store.gc({ retain })
      console.log(JSON.stringify(r))
      break
    }
    case 'seal': {
      const out = rest[0]
      if (!out) {
        return fail('seal needs <out.sqlite>')
      }
      store.seal(out)
      console.log(`sealed → ${out}`)
      break
    }
    case 'repair': {
      console.log(JSON.stringify(store.repair(), null, 2))
      break
    }
    default:
      fail(`unknown command '${cmd}'`)
  }
}

try {
  main()
} catch (e: unknown) {
  console.error(`fsqlite: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}
