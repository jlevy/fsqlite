// W2 incremental accumulation: apply each delta batch to a copy of a loaded store from
// 4 concurrent writer processes while a reader runs the W3 queries, then reconcile.
//
// Usage: node w2.ts <base-store> --scale S0 --deltas <dir with p01 p05 p20>
//        [--writers 4] [--envelopes 5] [--strategy snapshot|direct] [--work <dir>]
//
// Each batch starts from a fresh copy of the base store, since the batches are drawn
// independently from the base KB. Times are wall-clock milliseconds from the moment the
// writers start. The result goes to results/fsqlite/<scale>/w2.json (or w2-direct.json).

import { spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  RESULTS_DIR,
  SPIKE_DIR,
  WORK_DIR,
  cloneStore,
  forEachLineSync,
  forEachRowSync,
  isMain,
  kbDirFor,
  nowMs,
  parseArgs,
  percentile,
  round,
  writeResult,
} from './common.ts'
import type { KbRow, NodeRow } from './common.ts'
import { buildFtsSidecar } from './fts.ts'
import { GenericLoader } from './mapping.ts'
import { readUnits } from './w2_worker.ts'
import { genericStore, isV2, runOnSnapshot } from './w3.ts'

const HERE = join(SPIKE_DIR, 'fsqlite')
const NODE = [process.execPath, '--disable-warning=ExperimentalWarning']
const UV_PYTHON = [
  'uv',
  'run',
  '-q',
  '--no-project',
  '--with',
  'pyyaml',
  '--exclude-newer',
  '2026-11-03',
  'python',
]

interface Child {
  code: number
  stdout: string
  ms: number
}

function run(cmd: string[], opts: { quiet?: boolean } = {}): Promise<Child> {
  const t = nowMs()
  return new Promise((resolve, reject) => {
    const [bin, ...args] = cmd
    const child = spawn(bin!, args, {
      stdio: ['ignore', 'pipe', opts.quiet ? 'ignore' : 'inherit'],
    })
    let stdout = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code: code ?? 1, stdout, ms: round(nowMs() - t) }))
  })
}

/** Median time to copy a file, the floor of every capture and reconcile build. */
export function copyCost(path: string, runs = 3): Record<string, number> {
  const tmp = `${path}.copy-probe`
  const times: number[] = []
  for (let i = 0; i < runs; i++) {
    const t = nowMs()
    copyFileSync(path, tmp)
    times.push(nowMs() - t)
    rmSync(tmp, { force: true })
  }
  times.sort((a, b) => a - b)
  const bytes = statSync(path).size
  const ms = percentile(times, 50)
  return { bytes, median_ms: round(ms), mib_per_s: round(bytes / 2 ** 20 / (ms / 1000), 1) }
}

/** Split a parsed delta into per-writer row files: every node row, then whole units. */
function partition(
  deltaRows: string,
  outDir: string,
  writers: number,
): { units: number; files: string[] } {
  const nodes: NodeRow[] = []
  const units = new Map<string, KbRow[]>()
  const unitOf = (id: string): KbRow[] => {
    let unit = units.get(id)
    if (!unit) {
      unit = []
      units.set(id, unit)
    }
    return unit
  }
  const newIds = new Set<string>()
  const edges: KbRow[] = []
  forEachRowSync(deltaRows, (row) => {
    if (row.t === 'node') {
      nodes.push(row)
      newIds.add(row.id)
    } else if (row.t === 'doc') {
      unitOf(row.owner ?? row.path).unshift(row)
    } else if (row.t === 'entity') {
      unitOf(row.id).push(row)
    } else if (row.t === 'edge') {
      edges.push(row)
    }
  })
  for (const e of edges) {
    if (e.t === 'edge') {
      unitOf(newIds.has(e.source) ? e.source : e.target).push(e)
    }
  }
  const files: string[] = []
  const all = [...units.values()]
  for (let w = 0; w < writers; w++) {
    const lines = nodes.map((n) => JSON.stringify(n))
    for (let u = w; u < all.length; u += writers) {
      for (const row of all[u] ?? []) {
        lines.push(JSON.stringify(row))
      }
    }
    const file = join(outDir, `writer-${w}.jsonl`)
    writeFileSync(file, `${lines.join('\n')}\n`)
    files.push(file)
  }
  return { units: all.length, files }
}

function stats(values: number[]): Record<string, number> {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    n: sorted.length,
    p50_ms: round(percentile(sorted, 50), 3),
    p95_ms: round(percentile(sorted, 95), 3),
    max_ms: round(sorted.at(-1) ?? Number.NaN, 3),
  }
}

/** v2 batches: one unit per operation (its op row and the rows it writes), dealt round-robin. */
function partitionOps(
  deltaRows: string,
  outDir: string,
  writers: number,
): { units: number; files: string[] } {
  const nodes: string[] = []
  const units: string[][] = []
  forEachLineSync(deltaRows, (line) => {
    const t = (JSON.parse(line) as KbRow).t
    if (t === 'node') {
      nodes.push(line)
    } else if (t === 'op' || t === 'invalid' || units.length === 0) {
      units.push([line])
    } else {
      units[units.length - 1]?.push(line)
    }
  })
  const files: string[] = []
  for (let w = 0; w < writers; w++) {
    const lines = [...nodes]
    for (let u = w; u < units.length; u += writers) {
      lines.push(...(units[u] ?? []))
    }
    const file = join(outDir, `writer-${w}.jsonl`)
    writeFileSync(file, `${lines.join('\n')}\n`)
    files.push(file)
  }
  return { units: units.length, files }
}

export interface BatchOptions {
  /** A v2 batch: parse with --delta2 against this base KB, and split by operation. */
  v2BaseKb?: string
  /** After publishing, run W3 v2 on the head and compare it with this expected file. */
  expected?: string
  checkOut?: string
}

async function batch(
  base: string,
  scale: string,
  deltaDir: string,
  work: string,
  writers: number,
  envelopes: number,
  strategy: string,
  opts: BatchOptions = {},
): Promise<Record<string, unknown>> {
  const name = deltaDir.split('/').pop() ?? 'delta'
  const dir = join(work, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const rows = join(dir, 'delta.jsonl')
  const mode = opts.v2BaseKb ? ['--delta2', opts.v2BaseKb] : ['--delta']
  const parse = await run([...UV_PYTHON, join(HERE, 'parse_kb.py'), deltaDir, rows, ...mode], {
    quiet: true,
  })
  if (parse.code !== 0) {
    throw new Error(`parse of ${deltaDir} failed`)
  }
  const { units, files } = opts.v2BaseKb
    ? partitionOps(rows, dir, writers)
    : partition(rows, dir, writers)
  const store = join(dir, 'store')
  cloneStore(base, store)
  const handle = genericStore(store).init()
  const baseVersion = handle.currentVersion()
  const baseCopy = copyCost(handle.snapshotPath(baseVersion))
  const before = handle.read(
    (db) => db.prepare('SELECT count(*) AS n FROM entity').get() as { n: number },
  )

  const stop = join(dir, 'stop')
  const readerOut = join(dir, 'reader.json')
  const reader = run([...NODE, join(HERE, 'w2_worker.ts'), 'reader', store, scale, readerOut, stop])
  while (!existsSync(`${readerOut}.ready`)) {
    await new Promise((r) => setTimeout(r, 20))
  }
  await new Promise((r) => setTimeout(r, 500)) // a quiet baseline for reader latency

  const started = Date.now()
  const outs = await Promise.all(
    files.map((file, w) =>
      run([
        ...NODE,
        join(HERE, 'w2_worker.ts'),
        'writer',
        store,
        file,
        `writer${w}`,
        String(envelopes),
        strategy,
      ]),
    ),
  )
  const writersDone = Date.now()
  const reports = outs.map(
    (o) =>
      JSON.parse(o.stdout) as {
        captures: { ms: number; tx?: string | null }[]
        total_ms: number
        envelopes: number
        max_rss_mib: number
      },
  )
  let reconcile: Record<string, unknown> | null = null
  if (strategy !== 'direct') {
    const t = nowMs()
    const result = handle.reconcile({ lockOpts: { timeoutMs: 600_001, staleMs: 600_000 } })
    // Each quarantined envelope keeps its reason in tx/quarantine/<tx>.txn/QUARANTINE (f1.0).
    const qdir = join(store, 'tx', 'quarantine')
    const reasons = existsSync(qdir)
      ? readdirSync(qdir).map((txn) => ({
          txn,
          reason: readFileSync(join(qdir, txn, 'QUARANTINE'), 'utf8').trim(),
        }))
      : []
    reconcile = { ...result, ms: round(nowMs() - t), quarantine_reasons: reasons }
    if (reasons.length > 0) {
      // Recovery: a NOTFOUND quarantine is permanent, so re-capture each quarantined
      // envelope's operations on the new head, where its deletes find nothing left to
      // delete, and reconcile again.
      const t2 = nowMs()
      const retried = retryQuarantined(store, files, reports, reasons, envelopes)
      const again = handle.reconcile({ lockOpts: { timeoutMs: 600_001, staleMs: 600_000 } })
      reconcile.retry = { envelopes: retried, ...again, ms: round(nowMs() - t2) }
    }
  }
  const complete = Date.now()
  const published = Date.now()
  const head = handle.currentVersion()
  // Indexed search follows each publish: rebuild the FTS5 sidecar for the new head.
  const sidecar = buildFtsSidecar(handle.snapshotPath(head), join(dir, 'search-fts.sqlite'))
  const searchVisible = Date.now()
  // The reader checks `current` before every query; give it time to reopen on the head.
  await new Promise((r) => setTimeout(r, 500))
  writeFileSync(stop, '')
  await reader
  const r = JSON.parse(readFileSync(readerOut, 'utf8')) as {
    samples: [number, number, string][]
    versions: { version: number; seen_at: number; open_ms: number }[]
    errors: unknown[]
    max_rss_mib: number
  }
  const after = handle.read(
    (db) => db.prepare('SELECT count(*) AS n FROM entity').get() as { n: number },
  )
  const headCopy = copyCost(handle.snapshotPath(head))
  // v2: does the concurrently applied state answer W3 like the reference post-batch KB,
  // and does it hold the same rows as one writer applying the batch in line order?
  let check: Record<string, unknown> | null = null
  if (opts.expected && opts.checkOut && existsSync(opts.expected)) {
    check = checkAgainstExpected(handle.snapshotPath(head), scale, opts.expected, opts.checkOut)
  }
  let sameAsLineOrder: Record<string, unknown> | null = null
  if (opts.v2BaseKb) {
    const ref = join(dir, 'line-order')
    cloneStore(base, ref)
    const refStore = genericStore(ref).init()
    refStore.write('lineorder', (db) => {
      const loader = new GenericLoader(db)
      forEachRowSync(rows, (row) => loader.add(row))
    })
    refStore.reconcile({ lockOpts: { timeoutMs: 600_001, staleMs: 600_000 } })
    const a = semanticDigest(handle.snapshotPath(head))
    const b = semanticDigest(refStore.snapshotPath(refStore.currentVersion()))
    sameAsLineOrder = {
      equal: Object.keys(a).every((k) => a[k] === b[k]),
      differing_tables: Object.keys(a).filter((k) => a[k] !== b[k]),
      concurrent: a,
      line_order: b,
    }
    rmSync(ref, { recursive: true, force: true })
  }
  // Every updated record must now differ from the base.
  const updatedIds =
    (
      JSON.parse(readFileSync(join(deltaDir, 'manifest.json'), 'utf8')) as {
        updated_ids?: string[]
      }
    ).updated_ids ?? []
  const payloads = (dirPath: string): Map<string, string> =>
    genericStore(dirPath).read((db) => {
      const get = db.prepare('SELECT payload FROM entity WHERE id = ?')
      return new Map(
        updatedIds.map((id) => [
          id,
          (get.get(id) as { payload: string } | undefined)?.payload ?? '',
        ]),
      )
    })
  const basePayloads = payloads(base)
  const headPayloads = payloads(store)
  const changed = updatedIds.filter((id) => basePayloads.get(id) !== headPayloads.get(id)).length
  const manifest = JSON.parse(readFileSync(join(deltaDir, 'manifest.json'), 'utf8')) as Record<
    string,
    unknown
  >
  const seenHead = r.versions.find((v) => v.version === head)
  const during = r.samples.filter(([at]) => at >= started && at <= published).map(([, ms]) => ms)
  const quiet = r.samples.filter(([at]) => at < started).map(([, ms]) => ms)
  const captureMs = reports.flatMap((rep) => rep.captures.map((c) => c.ms))
  const result = {
    batch: name,
    strategy,
    arm: strategy === 'direct' ? 'DirectStore' : 'SnapshotStore',
    delta: opts.v2BaseKb
      ? { changes: manifest.changes, counts: manifest.counts, edges: manifest.edges_in_upserts }
      : {
          changes: manifest.changes,
          new: manifest.new,
          updated: manifest.updated,
          new_edges: manifest.new_edges,
        },
    w3_check_against_reference: check,
    same_rows_as_one_writer_in_line_order: sameAsLineOrder,
    units,
    parse_ms: parse.ms,
    writers: writers,
    envelopes: reports.reduce((n, rep) => n + rep.envelopes, 0),
    capture_ms: stats(captureMs),
    gc_refusals:
      strategy === 'direct'
        ? reports
            .flatMap((rep) => rep.captures)
            .filter((c) => typeof (c as { gcRetries?: unknown }).gcRetries === 'string').length
        : null,
    gc_after_write_ms:
      strategy === 'direct'
        ? stats(
            reports.flatMap((rep) => rep.captures.map((c) => (c as { gc_ms?: number }).gc_ms ?? 0)),
          )
        : null,
    writers_wall_ms: writersDone - started,
    writer_max_rss_mib: Math.max(...reports.map((rep) => rep.max_rss_mib)),
    reconcile,
    visible_after_ms: seenHead ? seenHead.seen_at - started : null,
    // The same, from the first capture rather than from spawning the writer processes.
    visible_after_first_capture_ms: seenHead
      ? seenHead.seen_at -
        Math.min(...reports.map((rep) => (rep as { started_at?: number }).started_at ?? started))
      : null,
    fts_sidecar_rebuild: sidecar,
    indexed_search_visible_after_ms: searchVisible - started,
    published_after_ms: published - started,
    complete_after_ms: complete - started,
    versions_published: head - baseVersion,
    entities: { before: before.n, after: after.n, added: after.n - before.n },
    updated_records_changed: `${changed}/${updatedIds.length}`,
    base_copy: baseCopy,
    head_copy: headCopy,
    reader: {
      queries: r.samples.length,
      errors: r.errors.length,
      error_samples: r.errors.slice(0, 3),
      quiet: stats(quiet),
      during_writes: stats(during),
      reopen_ms: stats(r.versions.map((v) => v.open_ms)),
      max_rss_mib: r.max_rss_mib,
    },
  }
  if (!process.env.KB_KEEP) {
    // Measured: drop the clone, its new generation, the sidecar and the parsed rows.
    rmSync(dir, { recursive: true, force: true })
  }
  return result
}

/**
 * Re-capture the operations of every quarantined envelope from its writer's file, in one
 * envelope: separate retries would start from the same head and could conflict again.
 */
function retryQuarantined(
  store: string,
  files: string[],
  reports: { captures: { tx?: string | null }[] }[],
  reasons: { txn: string }[],
  envelopes: number,
): number {
  const slices: { nodes: KbRow[]; units: KbRow[][] }[] = []
  for (const { txn } of reasons) {
    const tx = txn.replace(/\.txn$/, '')
    reports.forEach((rep, w) => {
      const index = rep.captures.findIndex((c) => c.tx === tx)
      if (index >= 0) {
        const { nodes, units } = readUnits(files[w] ?? '')
        const per = Math.max(1, Math.ceil(units.length / envelopes))
        slices.push({ nodes, units: units.slice(index * per, (index + 1) * per) })
      }
    })
  }
  genericStore(store).write('retry', (db) => {
    const loader = new GenericLoader(db)
    for (const { nodes, units } of slices) {
      for (const node of nodes) {
        loader.add(node)
      }
      for (const row of units.flat()) {
        loader.add(row)
      }
    }
  })
  return slices.length
}

/**
 * Row digests that ignore edge ordinals, which concurrent writers allocate differently:
 * entities, documents, search text and quarantine by key, and edges as a sorted multiset.
 */
export function semanticDigest(snapshot: string): Record<string, string> {
  const db = new DatabaseSync(snapshot, { readOnly: true })
  try {
    const digest = (sql: string): string => {
      const hash = createHash('sha256')
      let n = 0
      for (const row of db.prepare(sql).iterate()) {
        hash.update(JSON.stringify(Object.values(row)))
        n++
      }
      return `${n}:${hash.digest('hex').slice(0, 16)}`
    }
    return {
      entity: digest('SELECT * FROM entity ORDER BY id'),
      edge: digest(
        'SELECT source, relation, target, props FROM edge ORDER BY source, relation, target, props',
      ),
      doc: digest('SELECT * FROM doc ORDER BY path'),
      search_text: digest('SELECT * FROM search_text ORDER BY id, rank'),
      quarantine: digest('SELECT * FROM quarantine ORDER BY path'),
    }
  } finally {
    db.close()
  }
}

/**
 * Run every W3 v2 query once on a snapshot (labelled `<scale>-p05` style by the caller),
 * write it in the harness form, and compare it with the oracle's expected file.
 */
export function checkAgainstExpected(
  snapshot: string,
  scale: string,
  expected: string,
  out: string,
): Record<string, unknown> {
  const report = runOnSnapshot(snapshot, scale, { warm: 0 })
  writeFileSync(out, `${JSON.stringify({ workflow: 'W3', scale, ...report }, null, 2)}\n`)
  const r = spawnSync('python3', [join(SPIKE_DIR, 'harness', 'compare.py'), expected, out], {
    encoding: 'utf8',
  })
  const lines = r.stdout.trim().split('\n')
  return {
    expected,
    result: lines.at(-1) ?? '',
    differing: lines.filter((l) => l.startsWith('DIFF') || l.startsWith('MISSING')).slice(0, 10),
  }
}

async function main(): Promise<void> {
  const { flags, args } = parseArgs(process.argv.slice(2))
  const [base] = args
  const scale = flags.scale ?? 'S0'
  const deltas = flags.deltas
  if (!base || !deltas) {
    throw new Error('usage: w2.ts <base-store> --scale S0 --deltas <dir>')
  }
  const strategy = flags.strategy ?? 'snapshot'
  const work = flags.work ?? join(WORK_DIR, scale, `w2-${strategy}`)
  const writers = Number(flags.writers ?? 4)
  const envelopes = Number(flags.envelopes ?? 5)
  const batches = []
  for (const name of readdirSync(deltas)
    .filter((d) => /^p\d+$/.test(d))
    .sort()) {
    // Round-2 scales use the v2 batch format; p05 is checked against the oracle's state.
    const v2 = isV2(scale)
    const opts: BatchOptions = v2
      ? {
          v2BaseKb: kbDirFor(scale),
          expected: join(SPIKE_DIR, 'harness', 'expected', `${scale}-${name}`, 'w3.json'),
          checkOut: join(RESULTS_DIR, scale, `w3-after-${name}-${writers}writers.json`),
        }
      : {}
    const b = await batch(base, scale, join(deltas, name), work, writers, envelopes, strategy, opts)
    console.error(
      JSON.stringify({
        batch: b.batch,
        visible_after_ms: b.visible_after_ms,
        reconcile: b.reconcile,
      }),
    )
    batches.push(b)
  }
  const workflow = strategy === 'direct' ? 'w2-direct' : 'w2'
  console.log(
    writeResult(scale, workflow, {
      base_store: base,
      deltas,
      writers,
      envelopes_per_writer: envelopes,
      strategy,
      batches,
    }),
  )
}

if (isMain(import.meta.url)) {
  await main()
}
