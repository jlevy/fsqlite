// Shared helpers for the fsqlite spike: the intermediate JSONL rows, a synchronous line
// reader (fsqlite write callbacks are synchronous), paths, and result files.

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { cpus, freemem, platform, release, totalmem } from 'node:os'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

export const SPIKE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const FSQLITE_SRC = resolve(SPIKE_DIR, '../../../../packages/fsqlite/src/index.ts')
export const RESULTS_DIR = join(SPIKE_DIR, 'results', 'fsqlite')
export const SCRATCH =
  process.env.KB_SCRATCH ??
  '/tmp/claude-0/-home-user/bac81f03-965b-51f3-b055-bed7bf70e318/scratchpad'
export const CORPORA_DIR = join(SCRATCH, 'kb-corpora')
export const WORK_DIR = join(SCRATCH, 'fsqlite-spike')
export const S0_KB = resolve(SPIKE_DIR, '../../../../attic/paraverse/vendor/universe2026-md/kb')

/** The KB directory for a scale: S0 is the vendored KB, others come from the corpus dir. */
export function kbDirFor(scale: string): string {
  return scale === 'S0' ? S0_KB : join(CORPORA_DIR, scale, 'kb')
}

export interface SchemaRow {
  t: 'schema'
  kind: string
  file: string
  schema: string
}
export interface FileRow {
  t: 'file'
  path: string
  text: string
}
export interface LineRow {
  t: 'line'
  path: string
  n: number
  text: string
}
export interface NodeRow {
  t: 'node'
  id: string
  kind: string
  name: string | null
  path: string
}
export interface DocRow {
  t: 'doc'
  path: string
  format: 'md' | 'yaml'
  envelope: string | null
  owner: string | null
  head: string
  body: string | null
}
export interface EntityRow {
  t: 'entity'
  id: string
  kind: string
  name: string | null
  path: string
  payload: string
  /** A delta's changed record of an existing entity, whose graph node stays as stored. */
  update?: boolean
}
export interface EdgeRow {
  t: 'edge'
  source: string
  relation: string
  target: string
  /** Null in a v2 batch: the importer takes the next free ordinal for the triple. */
  ord: number | null
  props: string | null
}
/** A softschema-kb-delta/v2 operation; the rows it writes follow it. */
export type OpRow =
  | { t: 'op'; op: 'upsert'; path: string; node_ids: string[] }
  | { t: 'op'; op: 'delete'; path: string; node_ids: string[] }
  | {
      t: 'op'
      op: 'merge'
      absorbed: string
      survivor: string
      absorbed_path: string
      survivor_path: string
    }
/** A v2 record that failed its schema: quarantined instead of applied. */
export interface InvalidRow {
  t: 'invalid'
  op: string
  path: string
  id: string | null
  errors: string[]
}
/** Removals a KB diff emits before its additions. */
export type RemovalRow =
  | { t: 'unedge'; source: string; relation: string; target: string; ord: number }
  | { t: 'unentity'; id: string }
  | { t: 'undoc'; path: string }
  | { t: 'unline'; path: string; from: number }
export type KbRow =
  | SchemaRow
  | FileRow
  | LineRow
  | NodeRow
  | DocRow
  | EntityRow
  | EdgeRow
  | RemovalRow
  | OpRow
  | InvalidRow

/**
 * Call `fn` for each line of a UTF-8 file without loading it whole. Synchronous, so it can
 * run inside an fsqlite write callback, which cannot await.
 */
export function forEachLineSync(path: string, fn: (line: string) => void): void {
  const fd = openSync(path, 'r')
  const buf = Buffer.allocUnsafe(1 << 22)
  let carry: Buffer = Buffer.alloc(0)
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n === 0) {
        break
      }
      let chunk = carry.length > 0 ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
      let start = 0
      for (let i = chunk.indexOf(10, start); i !== -1; i = chunk.indexOf(10, start)) {
        if (i > start) {
          fn(chunk.toString('utf8', start, i))
        }
        start = i + 1
      }
      chunk = chunk.subarray(start)
      carry = Buffer.from(chunk)
    }
    if (carry.length > 0) {
      fn(carry.toString('utf8'))
    }
  } finally {
    closeSync(fd)
  }
}

/** Parse each intermediate row of a JSONL file, in order. */
export function forEachRowSync(path: string, fn: (row: KbRow) => void): void {
  forEachLineSync(path, (line) => fn(JSON.parse(line) as KbRow))
}

export function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return Number.NaN
  }
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[rank] ?? Number.NaN
}

export function round(value: number, digits = 3): number {
  const f = 10 ** digits
  return Math.round(value * f) / f
}

export function maxRssMiB(): number {
  return round(process.resourceUsage().maxRSS / 1024, 1)
}

export function rssMiB(): number {
  return round(process.memoryUsage().rss / (1024 * 1024), 1)
}

function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'unknown'
  }
}

/** Machine and software facts recorded in every result file. */
export function machineInfo(): Record<string, unknown> {
  const probe = new DatabaseSync(':memory:')
  const sqlite = (probe.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v
  probe.close()
  return {
    cpus: cpus().length,
    cpu_model: cpus()[0]?.model ?? 'unknown',
    mem_total_mib: Math.round(totalmem() / 2 ** 20),
    mem_free_mib: Math.round(freemem() / 2 ** 20),
    os: `${platform()} ${release()}`,
    filesystem: sh('stat', ['-f', '-c', '%T', SCRATCH]),
    node: process.version,
    sqlite,
    python: sh('python3', ['--version']),
  }
}

/** Corpus seed and counts, from the corpus's own metadata when it has one. */
export function corpusInfo(kbDir: string): Record<string, unknown> {
  const info: Record<string, unknown> = { kb: kbDir }
  for (const name of ['../manifest.json', '_graph/stats.json']) {
    try {
      const data = JSON.parse(readFileSync(join(kbDir, name), 'utf8')) as Record<string, unknown>
      if (name === '../manifest.json') {
        info.corpus = data
      } else {
        info.node_total = data.node_total
        info.edge_total = data.edge_total
      }
    } catch {
      // Optional metadata.
    }
  }
  return info
}

/** Write `results/fsqlite/<scale>/<workflow>.json` with machine and corpus context. */
export function writeResult(
  scale: string,
  workflow: string,
  data: Record<string, unknown>,
): string {
  const dir = join(RESULTS_DIR, scale)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${workflow}.json`)
  const doc = {
    backend: 'fsqlite',
    scale,
    workflow,
    recorded_at: new Date().toISOString(),
    machine: machineInfo(),
    corpus: corpusInfo(kbDirFor(scale)),
    ...data,
  }
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`)
  return path
}

/**
 * A SQLite URI that opens a published snapshot read-only and immutable, for ATTACH. The
 * result is already quoted for use inside a single-quoted SQL string.
 */
export function readOnlyUri(path: string): string {
  return `file:${encodeURI(path).replace(/\?/g, '%3f').replace(/#/g, '%23')}?mode=ro&immutable=1`.replace(
    /'/g,
    "''",
  )
}

/** Drop a file's pages from the OS page cache, so the next read is cold. */
export function evictFromPageCache(path: string): boolean {
  try {
    execFileSync('python3', [
      '-c',
      'import os,sys\nfd=os.open(sys.argv[1],os.O_RDONLY)\nos.posix_fadvise(fd,0,0,os.POSIX_FADV_DONTNEED)',
      path,
    ])
    return true
  } catch {
    return false
  }
}

/**
 * Clone a quiescent store with hard links. This is safe only because published snapshots
 * are immutable and `current` is replaced by atomic rename (a new inode), so neither copy
 * can change a file the other sees. The clone keeps the source's store_id, so it is a
 * throwaway benchmark copy, not a supported backup (use seal() or readLease() for that).
 */
export function cloneStore(src: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true })
  execFileSync('cp', ['-al', src, dest])
}

/** Whether the module at `url` is the script Node was started with. */
export function isMain(url: string): boolean {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(url)
}

/** Parse `--name value` flags and positional arguments. */
export function parseArgs(argv: string[]): { flags: Record<string, string>; args: string[] } {
  const flags: Record<string, string> = {}
  const args: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg.startsWith('--')) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[arg.slice(2)] = 'true'
      } else {
        flags[arg.slice(2)] = next
        i++
      }
    } else {
      args.push(arg)
    }
  }
  return { flags, args }
}
