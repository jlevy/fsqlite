// fsinspect.ts: filesystem-capability diagnostic for fsqlite.
//
// fsqlite's correctness rests on a handful of filesystem guarantees, not on a perfect
// file lock. This probe measures those guarantees on a *target directory* so an operator
// can tell, before trusting a shared path, whether it can host an fsqlite store and
// whether plain WAL would be unsafe there. It uses only node:fs and node:sqlite. It writes
// inside a temporary `.fsinspect-<pid>` subdirectory and removes it afterward.

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  statSync,
  lstatSync,
  symlinkSync,
  linkSync,
  realpathSync,
} from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Network/remote/sync filesystem types where SQLite's own locking is unreliable. */
const NETWORK_FS = new Set([
  'nfs',
  'nfs4',
  'cifs',
  'smbfs',
  'smb3',
  'afpfs',
  'fuse',
  'fuseblk',
  'fuse.sshfs',
  'fuse.rclone',
  'glusterfs',
  'lustre',
  'ceph',
  'davfs',
  'vboxsf',
  '9p',
])

const MKDIR_PROBE_CONTENDERS = 16
const MTIME_PROBE_SAMPLES = 12
const SUBSECOND_MILLISECONDS = 1000
const EXPECTED_HARDLINK_COUNT = 2

export interface ProbeResult {
  ok: boolean
  error?: string
  [key: string]: unknown
}

export interface FsType {
  type: string
  mount: string | null
  network: boolean
  source: string | null
}

export interface InspectReport {
  dir: string
  fs: FsType
  probes: InspectProbes
  verdict: {
    fsqliteSafe: boolean
    missing: string[]
    walSafe: boolean
    recommendation: string
  }
}

export interface InspectProbes {
  mkdirAtomic: ProbeResult
  renameReplace: ProbeResult
  exclusiveCreate: ProbeResult
  closeToOpen: ProbeResult
  mtimeResolution: ProbeResult
  symlink: ProbeResult
  hardlink: ProbeResult
  fsyncDir: ProbeResult
  walViable: ProbeResult
  [key: string]: ProbeResult
}

const ok = (extra: Record<string, unknown> = {}): ProbeResult => ({ ok: true, ...extra })
const fail = (err: unknown, extra: Record<string, unknown> = {}): ProbeResult => ({
  ok: false,
  error: String(err instanceof Error ? err.message : err),
  ...extra,
})

/**
 * Resolve the filesystem type backing `dir` by matching the longest mount-point prefix in
 * /proc/self/mountinfo (Linux). Returns { type, mount, network, source } or unknown off
 * Linux or on parse failure.
 */
export function detectFsType(dir: string): FsType {
  let target: string
  try {
    target = realpathSync(dir)
  } catch {
    target = dir
  }
  try {
    const lines = readFileSync('/proc/self/mountinfo', 'utf8').split('\n')
    let best: { type: string; mount: string; source: string } | null = null
    for (const line of lines) {
      if (!line) {
        continue
      }
      // mountinfo: ... <mountpoint> ... - <fstype> <source> <superopts>
      const fields = line.split(' ')
      const mountPoint = fields[4]
      const sep = fields.indexOf('-')
      if (sep < 0 || !mountPoint) {
        continue
      }
      const type = fields[sep + 1]
      const source = fields[sep + 2]
      if (type === undefined || source === undefined) {
        continue
      }
      const isPrefix =
        target === mountPoint || target.startsWith(mountPoint === '/' ? '/' : mountPoint + '/')
      if (isPrefix && (!best || mountPoint.length > best.mount.length)) {
        best = { type, mount: mountPoint, source }
      }
    }
    if (best) {
      const base = best.type.split('.')[0] ?? best.type
      return { ...best, network: NETWORK_FS.has(best.type) || NETWORK_FS.has(base) }
    }
  } catch {
    /* not Linux, or no mountinfo */
  }
  return { type: 'unknown', mount: null, network: false, source: null }
}

/**
 * Exclusive-create semantics: N `mkdir` on one path, exactly one wins and the rest EEXIST.
 * These calls are issued from a single process, so this checks the create/EEXIST contract,
 * not a true cross-host race; the real concurrent gate is the multi-process test suite and
 * the deferred real-NFS gate. Treated as a heuristic input to the verdict, not a proof of
 * cross-host atomicity.
 */
function probeMkdirAtomic(scratch: string, n = MKDIR_PROBE_CONTENDERS): ProbeResult {
  const target = join(scratch, 'race.lock')
  let winners = 0
  let eexist = 0
  for (let i = 0; i < n; i++) {
    try {
      mkdirSync(target)
      winners++
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        eexist++
      }
    }
  }
  rmSync(target, { recursive: true, force: true })
  return winners === 1 && eexist === n - 1
    ? ok({ winners, contenders: n })
    : fail(`expected exactly 1 winner, got ${winners} (eexist=${eexist})`, {
        winners,
        contenders: n,
      })
}

/** rename over an existing file must be atomic-replace (content swapped, source gone). */
function probeRenameReplace(scratch: string): ProbeResult {
  const a = join(scratch, 'src')
  const b = join(scratch, 'dst')
  try {
    writeFileSync(b, 'OLD')
    writeFileSync(a, 'NEW')
    renameSync(a, b)
    const replaced = readFileSync(b, 'utf8') === 'NEW'
    let sourceGone = false
    try {
      statSync(a)
    } catch {
      sourceGone = true
    }
    return replaced && sourceGone ? ok() : fail('rename did not atomically replace')
  } catch (e) {
    return fail(e)
  } finally {
    rmSync(a, { force: true })
    rmSync(b, { force: true })
  }
}

/** O_EXCL create must fail the second time (unique-path / COMMITTED-marker safety). */
function probeExclusiveCreate(scratch: string): ProbeResult {
  const p = join(scratch, 'excl')
  try {
    closeSync(openSync(p, 'wx'))
    try {
      closeSync(openSync(p, 'wx'))
      return fail('second O_EXCL create unexpectedly succeeded')
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EEXIST' ? ok() : fail(e)
    }
  } catch (e) {
    return fail(e)
  } finally {
    rmSync(p, { force: true })
  }
}

/** Write through one file descriptor, close it, then verify a fresh open sees the bytes. */
function probeCloseToOpen(scratch: string): ProbeResult {
  const p = join(scratch, 'cto')
  try {
    const fd = openSync(p, 'w')
    writeFileSync(fd, 'published')
    fsyncSync(fd)
    closeSync(fd)
    return readFileSync(p, 'utf8') === 'published'
      ? ok()
      : fail('reader did not observe written bytes')
  } catch (e) {
    return fail(e)
  } finally {
    rmSync(p, { force: true })
  }
}

/** Smallest mtime delta the filesystem can distinguish, in milliseconds. */
function probeMtimeResolution(scratch: string): ProbeResult {
  const p = join(scratch, 'mt')
  try {
    const samples: number[] = []
    let last: number | null = null
    for (let i = 0; i < MTIME_PROBE_SAMPLES; i++) {
      writeFileSync(p, String(i))
      const ms = statSync(p).mtimeMs
      if (last !== null && ms > last) {
        samples.push(ms - last)
      }
      last = ms
      const spin = Date.now() + 2
      while (Date.now() < spin) {
        /* busy-wait ~2ms to force distinct timestamps */
      }
    }
    const resolutionMs = samples.length ? Math.min(...samples) : null
    return ok({
      resolutionMs,
      subSecond: resolutionMs !== null && resolutionMs < SUBSECOND_MILLISECONDS,
    })
  } catch (e) {
    return fail(e)
  } finally {
    rmSync(p, { force: true })
  }
}

/** Verify the symlink and realpath behavior used for cleanup and lock path resolution. */
function probeSymlink(scratch: string): ProbeResult {
  const target = join(scratch, 'real')
  const link = join(scratch, 'link')
  try {
    writeFileSync(target, 'x')
    symlinkSync(target, link)
    const resolved = realpathSync(link)
    const isLink = lstatSync(link).isSymbolicLink()
    return isLink && resolved === realpathSync(target) ? ok() : fail('symlink/realpath mismatch')
  } catch (e) {
    return fail(e)
  } finally {
    rmSync(link, { force: true })
    rmSync(target, { force: true })
  }
}

/** hardlink raises link count to 2 (some network/sync filesystems forbid this). */
function probeHardlink(scratch: string): ProbeResult {
  const a = join(scratch, 'h1')
  const b = join(scratch, 'h2')
  try {
    writeFileSync(a, 'x')
    linkSync(a, b)
    return statSync(a).nlink === EXPECTED_HARDLINK_COUNT
      ? ok()
      : fail(`nlink=${statSync(a).nlink}, expected ${EXPECTED_HARDLINK_COUNT}`)
  } catch (e) {
    return fail(e)
  } finally {
    rmSync(a, { force: true })
    rmSync(b, { force: true })
  }
}

/** fsync on a directory fd (durability of the publish step). */
function probeFsyncDir(scratch: string): ProbeResult {
  try {
    const fd = openSync(scratch, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return ok()
  } catch (e) {
    return fail(e)
  }
}

/**
 * Negative control: can plain SQLite WAL run here? Where this fails (network
 * filesystems), fsqlite is the answer; where it works, you may not need it.
 */
function probeWalViable(scratch: string): ProbeResult {
  const dbPath = join(scratch, 'wal-probe.sqlite')
  try {
    const db = new DatabaseSync(dbPath)
    const mode = db.prepare('PRAGMA journal_mode=WAL').get() as Record<string, unknown> | undefined
    const journalMode = (mode?.journal_mode ?? Object.values(mode ?? {})[0]) as string
    db.exec('CREATE TABLE t(x INTEGER PRIMARY KEY)')
    db.exec('INSERT INTO t VALUES (1)')
    db.exec('PRAGMA wal_checkpoint(FULL)')
    const n = (db.prepare('SELECT count(*) AS c FROM t').get() as { c: number }).c
    db.close()
    return journalMode === 'wal' && n === 1
      ? ok({ journalMode })
      : fail(`WAL not honored (mode=${journalMode}, rows=${n})`, { journalMode })
  } catch (e) {
    return fail(e)
  } finally {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      rmSync(dbPath + suffix, { force: true })
    }
  }
}

/**
 * Run all probes against `dir` and return a structured report. Creates and removes a
 * private scratch subdirectory; never touches existing contents.
 */
export function inspect(dir: string): InspectReport {
  mkdirSync(dir, { recursive: true })
  const scratch = mkdtempSync(join(dir, '.fsinspect-'))
  try {
    const fs = detectFsType(dir)
    const probes: InspectProbes = {
      mkdirAtomic: probeMkdirAtomic(scratch),
      renameReplace: probeRenameReplace(scratch),
      exclusiveCreate: probeExclusiveCreate(scratch),
      closeToOpen: probeCloseToOpen(scratch),
      mtimeResolution: probeMtimeResolution(scratch),
      symlink: probeSymlink(scratch),
      hardlink: probeHardlink(scratch),
      fsyncDir: probeFsyncDir(scratch),
      walViable: probeWalViable(scratch),
    }
    // fsqlite needs the coordination and durability primitives but not WAL or hard links.
    const required = [
      'mkdirAtomic',
      'renameReplace',
      'exclusiveCreate',
      'closeToOpen',
      'fsyncDir',
    ] as const
    const missing = required.filter((k) => !probes[k].ok)
    const verdict = {
      fsqliteSafe: missing.length === 0,
      missing,
      walSafe: probes.walViable.ok && !fs.network,
      recommendation:
        missing.length === 0
          ? fs.network || !probes.walViable.ok
            ? 'use fsqlite (coordination primitives present; plain WAL is unsafe or unavailable here)'
            : 'fsqlite works; on this local filesystem plain WAL is also an option'
          : `do NOT host an fsqlite store here: missing ${missing.join(', ')}`,
    }
    return { dir, fs, probes, verdict }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Render a report as a compact human-readable string. */
export function formatReport(report: InspectReport): string {
  const mark = (b: boolean): string => (b ? '✅' : '❌')
  const lines: string[] = []
  lines.push(`fsinspect: ${report.dir}`)
  lines.push(
    `  filesystem: ${report.fs.type}${report.fs.network ? ' (network)' : ''}` +
      (report.fs.mount ? ` at ${report.fs.mount}` : ''),
  )
  for (const [name, r] of Object.entries(report.probes)) {
    const detail = r.error
      ? `: ${r.error}`
      : name === 'mtimeResolution'
        ? ` (${String(r.resolutionMs)} ms)`
        : ''
    lines.push(`  ${mark(r.ok)} ${name}${detail}`)
  }
  lines.push(
    `  verdict: fsqlite-safe=${mark(report.verdict.fsqliteSafe)} wal-safe=${mark(report.verdict.walSafe)}`,
  )
  lines.push(`  → ${report.verdict.recommendation}`)
  return lines.join('\n')
}
