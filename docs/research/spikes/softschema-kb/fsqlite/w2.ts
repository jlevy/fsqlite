// W2 incremental accumulation: apply each delta batch to a copy of a loaded store from
// 4 concurrent writer processes while a reader runs the W3 queries, then reconcile.
//
// Usage: node w2.ts <base-store> --scale S0 --deltas <dir with p01 p05 p20>
//        [--writers 4] [--envelopes 5] [--strategy snapshot|direct] [--work <dir>]
//
// Each batch starts from a fresh copy of the base store, since the batches are drawn
// independently from the base KB. Times are wall-clock milliseconds from the moment the
// writers start. The result goes to results/fsqlite/<scale>/w2.json (or w2-direct.json).

import { spawn } from 'node:child_process'
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
import { join } from 'node:path'
import {
  SPIKE_DIR,
  WORK_DIR,
  cloneStore,
  forEachRowSync,
  isMain,
  nowMs,
  parseArgs,
  percentile,
  round,
  writeResult,
} from './common.ts'
import type { KbRow, NodeRow } from './common.ts'
import { buildFtsSidecar } from './fts.ts'
import { genericStore } from './w3.ts'

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

async function batch(
  base: string,
  scale: string,
  deltaDir: string,
  work: string,
  writers: number,
  envelopes: number,
  strategy: string,
): Promise<Record<string, unknown>> {
  const name = deltaDir.split('/').pop() ?? 'delta'
  const dir = join(work, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const rows = join(dir, 'delta.jsonl')
  const parse = await run([...UV_PYTHON, join(HERE, 'parse_kb.py'), deltaDir, rows, '--delta'], {
    quiet: true,
  })
  if (parse.code !== 0) {
    throw new Error(`parse of ${deltaDir} failed`)
  }
  const { units, files } = partition(rows, dir, writers)
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
        captures: { ms: number }[]
        total_ms: number
        envelopes: number
        max_rss_mib: number
      },
  )
  let reconcile: Record<string, unknown> | null = null
  if (strategy !== 'direct') {
    const t = nowMs()
    const result = handle.reconcile({ lockOpts: { timeoutMs: 600_001, staleMs: 600_000 } })
    reconcile = { ...result, ms: round(nowMs() - t) }
  }
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
    delta: {
      changes: manifest.changes,
      new: manifest.new,
      updated: manifest.updated,
      new_edges: manifest.new_edges,
    },
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
    const b = await batch(base, scale, join(deltas, name), work, writers, envelopes, strategy)
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
