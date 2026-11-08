// fsqlite CLI: operate a store from the shell with no server and no app code.
//
// This module has no import-time effects: `main(argv, io)` runs one invocation and
// returns its exit code. The `fsqlite` bin (bin.ts) wires it to the process.
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

/** Where one CLI invocation writes its output, one line per call. */
export interface CliIo {
  out: (line: string) => void
  err: (line: string) => void
}

/** The process streams, for the bin. */
export const processIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
}

class CliExit extends Error {
  readonly code: number

  constructor(code: number) {
    super()
    this.code = code
  }
}

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

function printSqliteFacts(log: (line: string) => void, f: SqliteFacts, indent: string): void {
  log(`${indent}sqlite_version: ${f.sqliteVersion}`)
  log(`${indent}page_size: ${f.pageSize}`)
  log(`${indent}page_count: ${f.pageCount}`)
  log(`${indent}file_bytes: ${f.fileBytes}`)
  log(`${indent}application_id: ${f.applicationId}`)
  log(`${indent}user_version: ${f.userVersion}`)
  log(`${indent}journal_mode: ${f.journalMode}`)
  log(`${indent}tables: ${f.tables.map((t) => `${t.name}=${t.rows}`).join(' ') || '(none)'}`)
}

/** Run one CLI invocation (`argv` excludes the node and script paths). */
export function main(argv: readonly string[], io: CliIo = processIo): number {
  try {
    return run(argv, io)
  } catch (e: unknown) {
    if (e instanceof CliExit) {
      return e.code
    }
    io.err(`fsqlite: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

function run(argv: readonly string[], io: CliIo): number {
  const [cmd, dir, ...rest] = argv
  const log = io.out
  const fail = (msg: string): never => {
    io.err(`fsqlite: ${msg}`)
    throw new CliExit(64)
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
  let exitCode = 0
  if (!cmd || cmd === '--help' || cmd === '-h') {
    log('usage: fsqlite <info|validate|stats|gc|seal|repair|fsinspect|doctor> <path> [args]')
    exitCode = cmd ? 0 : 64
    return exitCode
  }
  if (!dir) {
    return fail(`'${cmd}' needs a <path>`)
  }

  // fsinspect works on any path (no store required), so handle it before constructing a store.
  if (cmd === 'fsinspect') {
    const report = inspect(dir)
    log(rest.includes('--json') ? JSON.stringify(report, null, 2) : formatReport(report))
    exitCode = report.verdict.fsqliteSafe ? 0 : 1
    return exitCode
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
        log(JSON.stringify({ path: dir, kind: 'plain-sqlite', sqlite: f }, null, 2))
      } else {
        log(`fsqlite stats: ${dir}`)
        log('  kind: plain-sqlite (no fsqlite layer)')
        printSqliteFacts(log, f, '  ')
      }
      exitCode = 0
      return exitCode
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
      log(JSON.stringify({ path: dir, kind: 'fsqlite-store', fsqlite, snapshot }, null, 2))
    } else {
      log(`fsqlite stats: ${dir}`)
      log('  kind: fsqlite-store')
      log(`  current: ${fsqlite.current ?? '(unreadable)'}`)
      log(`  snapshots: ${fsqlite.snapshots}`)
      log(
        `  pending: ${fsqlite.pending}  applied: ${fsqlite.applied}  quarantine: ${fsqlite.quarantine}`,
      )
      log(`  leases: ${fsqlite.leases}`)
      log(`  state: ${fsqlite.state}`)
      if (snapshot) {
        log(`  current snapshot (SQLite):`)
        printSqliteFacts(log, snapshot, '    ')
      }
    }
    exitCode = 0
    return exitCode
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
        log(
          JSON.stringify(
            { path: dir, kind: 'plain-sqlite', integrity: ok ? 'ok' : problems },
            null,
            2,
          ),
        )
      } else {
        log(`fsqlite doctor: ${dir}`)
        log('  kind: plain-sqlite (no fsqlite layer)')
        log(`  integrity: ${ok ? 'ok' : problems.join('; ')}`)
      }
      exitCode = ok ? 0 : 3
      return exitCode
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
      log(JSON.stringify(out, null, 2))
    } else {
      log(`fsqlite doctor: ${dir}`)
      log(`  binding: session=${caps.session} backup=${caps.backup} rebaser=${caps.rebaser}`)
      if (actions.length) {
        log(`  repaired: ${actions.join('; ')}`)
      }
      log(`  store: ${v.state}${v.issues.length ? ': ' + v.issues.join('; ') : ''}`)
    }
    exitCode = exitCodeForState(v.state)
    return exitCode
  }

  if (!hasStoreMarker(dir)) {
    fail(`'${dir}' is not an fsqlite store (missing fsqlite.json)`)
  }
  const store = new SnapshotStore(dir) // no schema/policy needed for these ops
  switch (cmd) {
    case 'info': {
      const v = store.validate()
      log(
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
      log(`${v.state}${v.issues.length ? ': ' + v.issues.join('; ') : ''}`)
      exitCode = exitCodeForState(v.state)
      return exitCode
    }
    case 'gc': {
      const retain = Number(flag('--retain', '3'))
      if (!Number.isInteger(retain) || retain < 0) {
        fail('--retain must be a non-negative integer')
      }
      try {
        log(JSON.stringify(store.gc({ retain })))
      } catch (error) {
        // gc fails closed on a store that does not validate. Report the refusal with the
        // validate exit code (3 invalid or corrupt, 4 unsupported); other failures exit 1.
        io.err(`fsqlite: ${error instanceof Error ? error.message : String(error)}`)
        const code = exitCodeForState(store.validate().state)
        exitCode = code === 3 || code === 4 ? code : 1
        return exitCode
      }
      break
    }
    case 'seal': {
      const out = rest[0]
      if (!out) {
        return fail('seal needs <out.sqlite>')
      }
      store.seal(out)
      log(`sealed → ${out}`)
      break
    }
    case 'repair': {
      log(JSON.stringify(store.repair(), null, 2))
      break
    }
    default:
      fail(`unknown command '${cmd}'`)
  }
  return exitCode
}
