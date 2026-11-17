// W6 operations: artifact count and size, standard-tool readability, serving start-up
// time, crash safety during import, and resident memory at rest.
//
// Usage: node w6.ts --scale S0 [--work <dir>]
//
// Uses the W1 store and intermediate rows under <work>/<scale>/. The crash tests kill a
// fresh import with SIGKILL partway through, then follow the documented recovery: run
// validate, remove the abandoned publish.lock only after confirming no client remains
// (the kill guarantees it here), run repair, validate again, and rerun the import.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DirectStore, SnapshotStore } from './fsq.ts'
import { SPIKE_DIR, WORK_DIR, isMain, nowMs, parseArgs, round, writeResult } from './common.ts'
import { GENERIC_POLICY, GENERIC_SCHEMA_VERSION, genericDdl } from './mapping.ts'
import { NODE, dirBytes } from './w1.ts'
import { KbQueries } from './queries.ts'
import { READER_PRAGMAS, genericStore, openReader, queryInstances } from './w3.ts'

const HERE = join(SPIKE_DIR, 'fsqlite')
const FSQLITE_CLI = join(SPIKE_DIR, '../../../../packages/fsqlite/src/cli/bin.ts')

/** Every file in the store, grouped by its role in the f1.0 layout. */
function artifacts(dir: string): Record<string, unknown> {
  const groups: Record<string, { files: number; bytes: number }> = {}
  let files = 0
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) {
      continue
    }
    const rel = join(entry.parentPath, entry.name).slice(dir.length + 1)
    const group = rel.startsWith('snapshots/')
      ? 'snapshots'
      : rel.startsWith('tx/')
        ? rel.split('/').slice(0, 2).join('/')
        : (rel.split('/')[0] ?? rel)
    const g = (groups[group] ??= { files: 0, bytes: 0 })
    g.files++
    g.bytes += statSync(join(entry.parentPath, entry.name)).size
    files++
  }
  return { files, bytes: dirBytes(dir), groups }
}

/** Open the snapshot with tools that know nothing about fsqlite. */
function standardTools(snapshot: string): Record<string, unknown> {
  const py = spawnSync(
    'python3',
    [
      '-c',
      [
        'import sqlite3, sys, json',
        "db = sqlite3.connect(f'file:{sys.argv[1]}?mode=ro&immutable=1', uri=True)",
        'q = lambda s: db.execute(s).fetchall()',
        "print(json.dumps({'sqlite': sqlite3.sqlite_version,",
        "  'tables': [r[0] for r in q(\"SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name\")],",
        "  'entities': q('SELECT count(*) FROM entity')[0][0],",
        "  'quick_check': q('PRAGMA quick_check')[0][0],",
        "  'application_id': q('PRAGMA application_id')[0][0],",
        "  'sample': q(\"SELECT id, payload ->> '$.stars' FROM entity WHERE kind = 'repository' ORDER BY id LIMIT 1\")}))",
      ].join('\n'),
      snapshot,
    ],
    { encoding: 'utf8' },
  )
  const cli = (args: string[]) => {
    const r = spawnSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', FSQLITE_CLI, ...args],
      {
        encoding: 'utf8',
      },
    )
    return { exit: r.status, out: r.stdout.trim().slice(0, 600) }
  }
  const sqlite3Cli = spawnSync('sqlite3', ['--version'], { encoding: 'utf8' })
  return {
    python_sqlite3: py.status === 0 ? (JSON.parse(py.stdout) as unknown) : py.stderr.slice(-500),
    sqlite3_cli: sqlite3Cli.error ? 'not installed on this VM' : sqlite3Cli.stdout.trim(),
    fsqlite_cli_stats: cli(['stats', snapshot]),
  }
}

/**
 * A fresh serving process: open the store, pin the head, run one record query, then every
 * W3 query, reporting time to first answer and resident memory at rest after each step.
 */
function startup(dir: string, scale: string): Record<string, unknown> {
  const script = `
    const rss = () => process.memoryUsage().rss / 2 ** 20
    const t0 = performance.now()
    const { genericStore, openReader, queryInstances } = await import(${JSON.stringify(join(HERE, 'w3.ts'))})
    const { KbQueries } = await import(${JSON.stringify(join(HERE, 'queries.ts'))})
    const tImport = performance.now()
    const rssImported = rss()
    const store = genericStore(${JSON.stringify(dir)}).init()
    const lease = store.readLease()
    const db = openReader(store.snapshotPath(lease.version))
    const tOpen = performance.now()
    const q = new KbQueries(db)
    q.record(${JSON.stringify(recordId(scale))})
    const tQuery = performance.now()
    const rssFirst = rss()
    for (const i of queryInstances(${JSON.stringify(scale)})) q.run(i.category, i.params)
    const rssW3 = rss()
    await new Promise((r) => setTimeout(r, 1000))
    console.log(JSON.stringify({
      import_ms: tImport - t0, open_ms: tOpen - tImport, first_query_ms: tQuery - tOpen,
      rss_after_import_mib: rssImported, rss_after_first_query_mib: rssFirst,
      rss_after_w3_mib: rssW3, rss_idle_after_w3_mib: rss(),
    }))
    db.close()
    lease.release()
  `
  const t = nowMs()
  const r = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script],
    { encoding: 'utf8' },
  )
  const wall = nowMs() - t
  const parsed = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as Record<string, number>
  return {
    process_wall_ms: round(wall),
    reader_pragmas: READER_PRAGMAS,
    ...Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, round(v)])),
  }
}

function recordId(scale: string): string {
  const q = queryInstances(scale).find((i) => i.name === 'record.person')
  return String(q?.params.id ?? '')
}

/** Per-request store.read(): a new connection plus identity checks, against a held one. */
function readOverhead(dir: string, scale: string): Record<string, number> {
  const store = genericStore(dir).init()
  const id = recordId(scale)
  const times = (fn: () => void, n = 50): number => {
    const all: number[] = []
    for (let i = 0; i < n; i++) {
      const t = nowMs()
      fn()
      all.push(nowMs() - t)
    }
    all.sort((a, b) => a - b)
    return round(all[Math.floor(n / 2)] ?? Number.NaN, 4)
  }
  const perRead = times(() => store.read((db) => new KbQueries(db).record(id)))
  const lease = store.readLease()
  const db = openReader(store.snapshotPath(lease.version))
  const q = new KbQueries(db)
  const held = times(() => q.record(id))
  db.close()
  lease.release()
  return { store_read_record_p50_ms: perRead, held_connection_record_p50_ms: held }
}

type CrashPhase = 'direct-build' | 'capture' | 'reconcile-build' | 'publication'

/** What to look for before killing: each phase leaves its own transient on disk. */
function killPoint(dir: string, phase: CrashPhase, killAtBytes: number): string | null {
  const snaps = join(dir, 'snapshots')
  const pending = join(dir, 'tx', 'pending')
  const lock = existsSync(join(dir, 'publish.lock'))
  const list = (d: string): string[] => {
    try {
      return readdirSync(d)
    } catch {
      return []
    }
  }
  switch (phase) {
    case 'direct-build': {
      const tmp = list(snaps).filter((f) => f.startsWith('.direct-') && f.endsWith('.sqlite'))
      const bytes = tmp.reduce((n, f) => {
        try {
          return n + statSync(join(snaps, f)).size
        } catch {
          return n
        }
      }, 0)
      return bytes >= killAtBytes ? `${bytes} bytes into the DirectStore build, lock held` : null
    }
    case 'capture': {
      const work = list(pending).filter((f) => f.startsWith('.work-'))
      const done = list(pending).filter((f) => f.endsWith('.txn')).length
      return work.length > 0 && done >= 2 ? `during capture ${done + 1} (${work[0]})` : null
    }
    case 'reconcile-build': {
      const build = list(snaps).find((f) => f.startsWith('.build-'))
      return build && !lock ? `during the reconcile build (${build}), before the lock` : null
    }
    case 'publication':
      return lock && list(snaps).some((f) => f.startsWith('.build-') || /^0+1\./.test(f))
        ? 'holding publish.lock during publication'
        : null
  }
}

/**
 * Kill an import in one phase, then follow the documented recovery: validate, remove an
 * abandoned publish.lock only once no client can resume (the SIGKILL guarantees it),
 * repair, validate, and finish (reconcile the surviving envelopes, or rerun the import).
 */
function crash(rows: string, dir: string, phase: CrashPhase, killAtBytes: number) {
  const route = phase === 'direct-build' ? 'direct' : 'snapshot'
  for (let attempt = 1; attempt <= 5; attempt++) {
    rmSync(dir, { recursive: true, force: true })
    const child = spawn(
      process.execPath,
      [...NODE.slice(1), join(HERE, 'load.ts'), rows, dir, '--route', route, '--batch', '1000'],
      { stdio: 'ignore' },
    )
    const t0 = nowMs()
    let killedAt: string | null = null
    // A synchronous poll: the publication window lasts only a few fsyncs.
    while (killedAt === null && nowMs() - t0 < 120_000) {
      if (
        existsSync(join(dir, 'current')) &&
        readFileSync(join(dir, 'current'), 'utf8').trim() !== '0'
      ) {
        break // the import finished before the kill point: try again
      }
      killedAt = killPoint(dir, phase, killAtBytes)
      if (killedAt !== null) {
        process.kill(child.pid ?? 0, 'SIGKILL')
      }
    }
    if (killedAt === null) {
      process.kill(child.pid ?? 0, 'SIGKILL')
      continue
    }
    const killMs = round(nowMs() - t0)
    return { attempt, killMs, killedAt, ...recover(rows, dir, route) }
  }
  return { phase, outcome: 'kill window missed in 5 attempts' }
}

function recover(rows: string, dir: string, route: string): Record<string, unknown> {
  const opts = { schema: genericDdl(), schemaVersion: GENERIC_SCHEMA_VERSION }
  const handle =
    route === 'direct'
      ? new DirectStore(dir, opts)
      : new SnapshotStore(dir, { ...opts, conflictPolicy: GENERIC_POLICY })
  const leftovers = readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => /\.(direct|build|work)-|publish\.lock$|\.tmp$/.test(f))
  const validateBefore = handle.validate()
  let refusal: string | null = null
  try {
    handle.planRepair()
  } catch (error) {
    refusal = (error as Error).message.slice(0, 200)
  }
  const steps: string[] = ['validate']
  const t = nowMs()
  const lockPresent = existsSync(join(dir, 'publish.lock'))
  if (lockPresent) {
    rmSync(join(dir, 'publish.lock'), { recursive: true, force: true })
    steps.push('confirm no client can resume, then remove the abandoned publish.lock (manual)')
  }
  const repair = handle.repair()
  steps.push('repair')
  const validateAfter = handle.validate()
  steps.push('validate')
  const recoveryMs = round(nowMs() - t)
  const versionAfterRepair = handle.currentVersion()
  const t2 = nowMs()
  let finish: Record<string, unknown>
  if (route === 'snapshot') {
    // Envelopes captured before the kill survive; reconcile publishes each exactly once.
    const s = handle as SnapshotStore
    const result = s.reconcile()
    const counts = s.read(
      (db) => db.prepare('SELECT count(*) AS n FROM entity').get() as { n: number },
    )
    finish = { reconcile: result, pending_after: s.pendingTxns().length, entities: counts.n }
    steps.push('reconcile (the importer then resumes the batches it had not captured)')
  } else {
    rmSync(dir, { recursive: true, force: true })
    const r = spawnSync(process.execPath, [...NODE.slice(1), join(HERE, 'load.ts'), rows, dir], {
      encoding: 'utf8',
    })
    finish = { rerun_exit: r.status, state: new DirectStore(dir, opts).validate().state }
    steps.push('rerun the import')
  }
  return {
    route: route === 'direct' ? 'DirectStore' : 'SnapshotStore',
    leftovers: leftovers.slice(0, 10),
    validate_before: validateBefore,
    repair_refused_while_lock_present: refusal,
    manual_lock_recovery: lockPresent,
    repair,
    validate_after: validateAfter,
    recovery_ms: recoveryMs,
    published_version_after_repair: versionAfterRepair,
    finish_ms: round(nowMs() - t2),
    finish,
    steps,
  }
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2))
  const scale = flags.scale ?? 'S0'
  const work = join(flags.work ?? WORK_DIR, scale)
  const dir = join(work, 'store-direct')
  const store = genericStore(dir).init()
  const snapshot = store.snapshotPath(store.currentVersion())
  const t = nowMs()
  const validate = store.validate()
  const validateMs = round(nowMs() - t)
  const result: Record<string, unknown> = {
    workflow: 'W6',
    artifacts: artifacts(dir),
    validate: { ...validate, ms: validateMs },
    standard_tools: standardTools(snapshot),
    startup_and_memory_at_rest: startup(dir, scale),
    read_overhead: readOverhead(dir, scale),
  }
  const rows = join(work, 'rows.jsonl')
  if (existsSync(rows) && !flags['skip-crash']) {
    const size = statSync(snapshot).size
    const crashDir = join(work, 'w6-crash')
    result.crash = Object.fromEntries(
      (['direct-build', 'capture', 'reconcile-build', 'publication'] as CrashPhase[]).map((p) => [
        p,
        crash(rows, crashDir, p, Math.floor(size / 2)),
      ]),
    )
    rmSync(crashDir, { recursive: true, force: true })
  }
  console.log(writeResult(scale, 'w6', result))
}

if (isMain(import.meta.url)) {
  await main()
}
