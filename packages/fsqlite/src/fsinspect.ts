// fsinspect.ts: filesystem-capability diagnostic for fsqlite.
//
// fsqlite's correctness rests on a handful of filesystem guarantees, not on a perfect
// file lock. This probe measures those guarantees on a *target directory* so an operator
// can tell, before trusting a shared path, whether it can host an fsqlite store and
// whether plain WAL would be unsafe there. It uses only node:fs and node:sqlite. It writes
// inside a private `mkdtemp` subdirectory (`.fsinspect-XXXXXX`) and removes it afterward.

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
import type { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { connect } from './driver.ts'
import { errorMessage, FsqliteError } from './errors.ts'

/** Network/remote/sync filesystem types where SQLite's own locking is unreliable. */
const NETWORK_FS: ReadonlySet<string> = new Set([
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

/** Memory-backed filesystems: fsync succeeds, but nothing reaches stable storage. */
const MEMORY_FS: ReadonlySet<string> = new Set(['tmpfs', 'ramfs'])

/** The overlayfs super option that drops every sync to the upper filesystem. */
const OVERLAY_VOLATILE_OPTION = 'volatile'

const MKDIR_PROBE_CONTENDERS = 16
const MTIME_PROBE_SAMPLES = 12
/** Spacing between mtime samples, so a fine-grained clock yields distinct timestamps. */
const MTIME_PROBE_SPACING_MS = 2
const SUBSECOND_MILLISECONDS = 1000
const EXPECTED_HARDLINK_COUNT = 2

/** The outcome of one probe. `error` explains a failure, with the underlying message. */
export interface ProbeResult {
  ok: boolean
  error?: string
}

/** `mkdirAtomic`: how many of `contenders` same-path `mkdir` calls succeeded. */
export interface MkdirProbeResult extends ProbeResult {
  winners: number
  contenders: number
}

/** `mtimeResolution`: the smallest observed mtime step, or null on a coarse filesystem. */
export interface MtimeProbeResult extends ProbeResult {
  resolutionMs: number | null
  subSecond: boolean
}

/** `walViable`: the journal mode SQLite reported after requesting WAL. */
export interface WalProbeResult extends ProbeResult {
  journalMode: string | null
}

/** The filesystem backing a path, from /proc/self/mountinfo (Linux). */
export interface FsType {
  /** The filesystem type (`ext4`, `nfs4`, `overlay`), or `unknown` off Linux. */
  type: string
  mount: string | null
  /** A network or remote filesystem, where plain SQLite WAL is unsafe. */
  network: boolean
  source: string | null
  /**
   * fsync returns success without persisting: tmpfs or ramfs, or overlayfs mounted with
   * `volatile` (spec section 10). A store there is process-crash safe only.
   */
  volatile: boolean
}

/** Every probe `inspect` runs. */
export interface InspectProbes {
  mkdirAtomic: MkdirProbeResult
  renameReplace: ProbeResult
  exclusiveCreate: ProbeResult
  closeToOpen: ProbeResult
  mtimeResolution: MtimeProbeResult
  symlink: ProbeResult
  hardlink: ProbeResult
  fsyncDir: ProbeResult
  walViable: WalProbeResult
  /** Whether fsync on this filesystem reaches stable storage (from {@link FsType.volatile}). */
  durableFsync: ProbeResult
}

/** The probe names an fsqlite store requires. */
export type RequiredProbe =
  | 'mkdirAtomic'
  | 'renameReplace'
  | 'exclusiveCreate'
  | 'closeToOpen'
  | 'hardlink'
  | 'fsyncDir'
  | 'durableFsync'

/** What the probes mean for hosting a store at the inspected path. */
export interface InspectVerdict {
  /** Every required probe passed; see `missing` otherwise. */
  fsqliteSafe: boolean
  missing: RequiredProbe[]
  /** Plain SQLite WAL works here and the filesystem is local. */
  walSafe: boolean
  recommendation: string
  /** Known hazards that do not fail a required probe. */
  warnings: string[]
}

export interface InspectReport {
  dir: string
  fs: FsType
  probes: InspectProbes
  verdict: InspectVerdict
}

const REQUIRED_PROBES: readonly RequiredProbe[] = [
  'mkdirAtomic',
  'renameReplace',
  'exclusiveCreate',
  'closeToOpen',
  'hardlink',
  'fsyncDir',
  'durableFsync',
]

const ok = (): ProbeResult => ({ ok: true })
const fail = (err: unknown): ProbeResult => ({ ok: false, error: errorMessage(err) })

/** Decode the octal escapes mountinfo uses for space, tab, newline, and backslash. */
const decodeMountField = (field: string): string =>
  field.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)))

/** Fields before the optional tags in a mountinfo line, from mount ID to mount options. */
const MOUNTINFO_FIXED_FIELDS = 6

const UNKNOWN_FS: FsType = {
  type: 'unknown',
  mount: null,
  network: false,
  source: null,
  volatile: false,
}

/**
 * Resolve the filesystem backing `target` (an absolute, symlink-free path) from the text of
 * /proc/self/mountinfo: the mount whose decoded mount point is the longest prefix of it.
 *
 * Each line is `<id> <parent> <dev> <root> <mount point> <options> [<tag>...] - <type>
 * <source> <super options>`, with whitespace and backslashes in paths octal-escaped.
 */
export function parseMountinfo(text: string, target: string): FsType {
  let best: { type: string; mount: string; source: string; superOptions: string[] } | null = null
  for (const line of text.split('\n')) {
    const fields = line.split(' ')
    const rawMount = fields[4]
    // The separator follows the six fixed fields and any optional tag fields.
    const sep = fields.indexOf('-', MOUNTINFO_FIXED_FIELDS)
    const type = fields[sep + 1]
    const rawSource = fields[sep + 2]
    if (sep < 0 || rawMount === undefined || type === undefined || rawSource === undefined) {
      continue
    }
    const mount = decodeMountField(rawMount)
    const isPrefix = target === mount || target.startsWith(mount === '/' ? '/' : `${mount}/`)
    if (isPrefix && (!best || mount.length > best.mount.length)) {
      const superOptions = (fields[sep + 3] ?? '').split(',')
      best = { type, mount, source: decodeMountField(rawSource), superOptions }
    }
  }
  if (!best) {
    return UNKNOWN_FS
  }
  const base = best.type.split('.')[0] ?? best.type
  const volatile =
    MEMORY_FS.has(best.type) ||
    (best.type === 'overlay' && best.superOptions.includes(OVERLAY_VOLATILE_OPTION))
  return {
    type: best.type,
    mount: best.mount,
    network: NETWORK_FS.has(best.type) || NETWORK_FS.has(base),
    source: best.source,
    volatile,
  }
}

/**
 * Resolve the filesystem type backing `dir` (Linux). Returns `unknown` off Linux, where
 * /proc/self/mountinfo does not exist.
 */
export function detectFsType(dir: string): FsType {
  let target: string
  try {
    target = realpathSync(dir)
  } catch {
    target = dir
  }
  let mountinfo: string
  try {
    mountinfo = readFileSync('/proc/self/mountinfo', 'utf8')
  } catch {
    return UNKNOWN_FS // not Linux
  }
  return parseMountinfo(mountinfo, target)
}

/**
 * Exclusive-create semantics: N `mkdir` on one path, exactly one wins and the rest EEXIST.
 * These calls are issued from a single process, so this checks the create/EEXIST contract,
 * not a true cross-host race; the real concurrent gate is the multi-process test suite and
 * the deferred real-NFS gate. Treated as a heuristic input to the verdict, not a proof of
 * cross-host atomicity.
 */
function probeMkdirAtomic(scratch: string, n = MKDIR_PROBE_CONTENDERS): MkdirProbeResult {
  const target = join(scratch, 'race.lock')
  let winners = 0
  let eexist = 0
  let unexpected: unknown = null
  try {
    for (let i = 0; i < n; i++) {
      try {
        mkdirSync(target)
        winners++
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
          eexist++
        } else {
          unexpected ??= e
        }
      }
    }
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
  if (unexpected !== null) {
    return { ...fail(unexpected), winners, contenders: n }
  }
  return winners === 1 && eexist === n - 1
    ? { ok: true, winners, contenders: n }
    : {
        ...fail(`expected exactly 1 winner, got ${winners} (eexist=${eexist})`),
        winners,
        contenders: n,
      }
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
    try {
      writeFileSync(fd, 'published')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
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
function probeMtimeResolution(scratch: string): MtimeProbeResult {
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
      const spin = Date.now() + MTIME_PROBE_SPACING_MS
      while (Date.now() < spin) {
        // Busy-wait: a synchronous sleep, so the next write gets a later timestamp.
      }
    }
    const resolutionMs = samples.length ? Math.min(...samples) : null
    return {
      ok: true,
      resolutionMs,
      subSecond: resolutionMs !== null && resolutionMs < SUBSECOND_MILLISECONDS,
    }
  } catch (e) {
    return { ...fail(e), resolutionMs: null, subSecond: false }
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
    const links = statSync(a).nlink
    return links === EXPECTED_HARDLINK_COUNT
      ? ok()
      : fail(`nlink=${links}, expected ${EXPECTED_HARDLINK_COUNT}`)
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
function probeWalViable(scratch: string): WalProbeResult {
  const dbPath = join(scratch, 'wal-probe.sqlite')
  let db: DatabaseSync | null = null
  try {
    db = connect(dbPath)
    const mode = db.prepare('PRAGMA journal_mode=WAL').get() as Record<string, unknown> | undefined
    const reported = Object.values(mode ?? {})[0]
    const journalMode = typeof reported === 'string' ? reported : ''
    db.exec('CREATE TABLE t(x INTEGER PRIMARY KEY)')
    db.exec('INSERT INTO t VALUES (1)')
    db.exec('PRAGMA wal_checkpoint(FULL)')
    const n = (db.prepare('SELECT count(*) AS c FROM t').get() as { c: number }).c
    return journalMode === 'wal' && n === 1
      ? { ok: true, journalMode }
      : { ...fail(`WAL not honored (mode=${journalMode}, rows=${n})`), journalMode }
  } catch (e) {
    return { ...fail(e), journalMode: null }
  } finally {
    // Close before deleting: an open handle keeps the files busy on some platforms.
    db?.close()
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      rmSync(dbPath + suffix, { force: true })
    }
  }
}

/** Whether fsync reaches stable storage, judged from the filesystem type (spec section 10). */
function probeDurableFsync(fs: FsType): ProbeResult {
  if (!fs.volatile) {
    return ok()
  }
  return fail(
    fs.type === 'overlay'
      ? 'overlayfs mounted with volatile drops every sync to its upper filesystem'
      : `${fs.type} never persists data to stable storage`,
  )
}

/** Judge a probe run: what an fsqlite store needs, and whether plain WAL is an option. */
export function inspectVerdict(fs: FsType, probes: InspectProbes): InspectVerdict {
  // fsqlite needs the coordination and durability primitives but not WAL. Snapshot
  // publication commits by hard link, which refuses to replace an existing entry.
  const missing = REQUIRED_PROBES.filter((name) => !probes[name].ok)
  const warnings: string[] = []
  if (fs.type === 'overlay' && !fs.volatile) {
    warnings.push(
      'overlayfs fails a directory rename from a lower layer with EXDEV unless redirect_dir ' +
        'is on, so a store whose envelopes came from an image layer cannot reconcile (spec O7)',
    )
  }
  const walSafe = probes.walViable.ok && !fs.network
  return {
    fsqliteSafe: missing.length === 0,
    missing,
    walSafe,
    recommendation:
      missing.length > 0
        ? `do NOT host an fsqlite store here: missing ${missing.join(', ')}`
        : walSafe
          ? 'fsqlite works; on this local filesystem plain WAL is also an option'
          : 'use fsqlite (coordination primitives present; plain WAL is unsafe or unavailable here)',
    warnings,
  }
}

/**
 * Run all probes against `dir`, which must be an existing directory, and return a
 * structured report. The probes run in a private scratch subdirectory that is removed
 * afterward; existing contents are never touched.
 */
export function inspect(dir: string): InspectReport {
  let isDirectory = false
  try {
    isDirectory = statSync(dir).isDirectory()
  } catch {
    // A missing or unreadable path is refused below.
  }
  if (!isDirectory) {
    throw new FsqliteError(
      'refused',
      `fsinspect: ${dir} is not an existing directory; create it, or name the directory that will hold the store`,
    )
  }
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
      durableFsync: probeDurableFsync(fs),
    }
    return { dir, fs, probes, verdict: inspectVerdict(fs, probes) }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Render a report as a compact human-readable string, with plain Unicode marks. */
export function formatReport(report: InspectReport): string {
  const mark = (b: boolean): string => (b ? '✓' : '✗')
  const lines: string[] = []
  lines.push(`fsinspect: ${report.dir}`)
  lines.push(
    `  filesystem: ${report.fs.type}${report.fs.network ? ' (network)' : ''}` +
      (report.fs.volatile ? ' (volatile)' : '') +
      (report.fs.mount ? ` at ${report.fs.mount}` : ''),
  )
  const probes = Object.entries(report.probes) as [keyof InspectProbes, ProbeResult][]
  for (const [name, r] of probes) {
    const detail = r.error
      ? `: ${r.error}`
      : name === 'mtimeResolution'
        ? ` (${String(report.probes.mtimeResolution.resolutionMs)} ms)`
        : ''
    lines.push(`  ${mark(r.ok)} ${name}${detail}`)
  }
  lines.push(
    `  verdict: fsqlite-safe=${mark(report.verdict.fsqliteSafe)} wal-safe=${mark(report.verdict.walSafe)}`,
  )
  for (const warning of report.verdict.warnings) {
    lines.push(`  warning: ${warning}`)
  }
  lines.push(`  → ${report.verdict.recommendation}`)
  return lines.join('\n')
}
