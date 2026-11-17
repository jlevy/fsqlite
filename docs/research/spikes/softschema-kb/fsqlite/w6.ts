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
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DirectStore, SnapshotStore } from './fsq.ts'
import {
  SPIKE_DIR,
  WORK_DIR,
  isMain,
  nowMs,
  parseArgs,
  round,
  writeResult,
} from './common.ts'
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

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Kill an import partway, then validate, recover, and rerun it. */
async function crash(rows: string, dir: string, route: string, killAtBytes: number) {
  rmSync(dir, { recursive: true, force: true })
  const child = spawn(
    process.execPath,
    [...NODE.slice(1), join(HERE, 'load.ts'), rows, dir, '--route', route, '--batch', '2000'],
    { stdio: 'ignore' },
  )
  const t0 = nowMs()
  let killedAt = ''
  for (;;) {
    await wait(5)
    if (child.exitCode !== null) {
      killedAt = 'finished before the kill point'
      break
    }
    const snaps = join(dir, 'snapshots')
    const pending = join(dir, 'tx', 'pending')
    const building = existsSync(snaps)
      ? readdirSync(snaps).filter((f) => f.startsWith('.direct-') || f.startsWith('.build-'))
      : []
    const bytes = building.reduce((n, f) => {
      try {
        return n + statSync(join(snaps, f)).size
      } catch {
        return n
      }
    }, 0)
    const envelopes = existsSync(pending)
      ? readdirSync(pending).filter((f) => f.endsWith('.txn')).length
      : 0
    if (bytes >= killAtBytes || (route === 'snapshot' && envelopes >= 2)) {
      child.kill('SIGKILL')
      killedAt =
        route === 'snapshot' ? `${envelopes} envelopes captured` : `${bytes} bytes into the build`
      break
    }
  }
  await new Promise((r) => child.once('exit', r))
  const killMs = round(nowMs() - t0)
  const handle =
    route === 'direct'
      ? new DirectStore(dir, { schema: genericDdl(), schemaVersion: GENERIC_SCHEMA_VERSION })
      : new SnapshotStore(dir, {
          schema: genericDdl(),
          schemaVersion: GENERIC_SCHEMA_VERSION,
          conflictPolicy: GENERIC_POLICY,
        })
  const leftovers = readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => /\.(direct|build|work)-|publish\.lock|\.tmp/.test(f))
  const validateBefore = handle.validate()
  let repairRefusal: string | null = null
  try {
    handle.planRepair()
  } catch (error) {
    repairRefusal = String((error as Error).message).slice(0, 200)
  }
  const lockRemoved = existsSync(join(dir, 'publish.lock'))
  if (lockRemoved) {
    rmSync(join(dir, 'publish.lock'), { recursive: true, force: true })
  }
  const t1 = nowMs()
  const repair = handle.repair()
  const repairMs = round(nowMs() - t1)
  const validateAfter = handle.validate()
  const versionAfterCrash = handle.currentVersion()
  // Restart: a SnapshotStore reconcile folds the envelopes that survived; a DirectStore
  // import reruns from scratch into the recovered store.
  const t2 = nowMs()
  let restart: unknown
  if (route === 'snapshot') {
    const s = handle as SnapshotStore
    restart = { reconcile: s.reconcile(), pending_after: s.pendingTxns().length }
  } else {
    rmSync(dir, { recursive: true, force: true })
    const r = spawnSync(process.execPath, [...NODE.slice(1), join(HERE, 'load.ts'), rows, dir], {
      encoding: 'utf8',
    })
    restart = {
      exit: r.status,
      validate: new DirectStore(dir, {
        schema: genericDdl(),
        schemaVersion: GENERIC_SCHEMA_VERSION,
      }).validate().state,
    }
  }
  return {
    route,
    killed_after_ms: killMs,
    killed_at: killedAt,
    leftovers: leftovers.slice(0, 10),
    validate_before: validateBefore,
    repair_refused_while_lock_present: repairRefusal,
    removed_abandoned_publish_lock: lockRemoved,
    repair: { ...repair, ms: repairMs },
    validate_after: validateAfter,
    published_version_after_crash: versionAfterCrash,
    restart_ms: round(nowMs() - t2),
    restart,
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
    result.crash = [
      await crash(rows, join(work, 'w6-crash-direct'), 'direct', Math.floor(size / 2)),
      await crash(rows, join(work, 'w6-crash-snapshot'), 'snapshot', Number.MAX_SAFE_INTEGER),
    ]
    rmSync(join(work, 'w6-crash-direct'), { recursive: true, force: true })
    rmSync(join(work, 'w6-crash-snapshot'), { recursive: true, force: true })
  }
  console.log(writeResult(scale, 'w6', result))
}

if (isMain(import.meta.url)) {
  await main()
}
