// The FS-capability diagnostic must report structured, correct results, and a local disk
// (where tests run) must pass every coordination probe. Mount detection and the verdict
// are pure functions, so their rules are tested on synthetic inputs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FsqliteError } from '../src/index.ts'
import {
  detectFsType,
  formatInspectReport,
  inspectFilesystem,
  inspectVerdict,
  parseMountinfo,
} from '../src/fsinspect.ts'
import type { FsType, InspectProbes, InspectReport } from '../src/fsinspect.ts'

const PROBES = [
  'mkdirAtomic',
  'renameReplace',
  'exclusiveCreate',
  'closeToOpen',
  'mtimeResolution',
  'symlink',
  'hardlink',
  'fsyncDir',
  'walViable',
  'durableFsync',
] as const

// One probe run serves every structural assertion: each run spins and fsyncs. The first
// test checks that it left nothing behind, then removes the directory.
const scratch = mkdtempSync(join(tmpdir(), 'fsinspect-test-'))
const report: InspectReport = inspectFilesystem(scratch)

test('inspectFilesystem returns a structured report with every probe and leaves no scratch behind', () => {
  try {
    assert.equal(report.dir, scratch)
    assert.deepEqual(Object.keys(report.probes).sort(), [...PROBES].sort())
    for (const name of PROBES) {
      assert.equal(typeof report.probes[name].ok, 'boolean', `${name}.ok`)
    }
    assert.equal(report.probes.mkdirAtomic.winners, 1)
    assert.ok(report.probes.mkdirAtomic.contenders >= 2)
    const resolution = report.probes.mtimeResolution.resolutionMs
    assert.ok(resolution === null || typeof resolution === 'number')
    assert.deepEqual(readdirSync(scratch), [], 'no scratch directory is left behind')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('local temp disk passes every required coordination probe', () => {
  for (const name of [
    'mkdirAtomic',
    'renameReplace',
    'exclusiveCreate',
    'closeToOpen',
    'fsyncDir',
  ] as const) {
    assert.ok(report.probes[name].ok, `expected ${name} ok: ${report.probes[name].error ?? ''}`)
  }
  if (report.probes.durableFsync.ok) {
    assert.equal(report.verdict.fsqliteSafe, true)
    assert.deepEqual(report.verdict.missing, [])
  }
})

test('formatInspectReport renders the dir, probes, and verdict with plain Unicode marks', () => {
  const out = formatInspectReport(report)
  assert.match(out, /^fsinspect: /)
  assert.match(out, /[✓✗] mkdirAtomic/u)
  assert.match(out, /verdict: fsqlite-safe=[✓✗] wal-safe=[✓✗]/u)
  assert.doesNotMatch(out, /\p{Extended_Pictographic}/u)
})

test('inspectFilesystem refuses a path that is not an existing directory and creates nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fsinspect-missing-'))
  try {
    const missing = join(dir, 'no', 'such', 'typo')
    assert.throws(
      () => inspectFilesystem(missing),
      (error: unknown) =>
        error instanceof FsqliteError &&
        error.code === 'refused' &&
        error.message.includes('not an existing directory'),
    )
    assert.equal(existsSync(join(dir, 'no')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('detectFsType returns a type and network flag without throwing', () => {
  const fs = detectFsType(process.cwd())
  assert.equal(typeof fs.type, 'string')
  assert.equal(typeof fs.network, 'boolean')
  assert.equal(typeof fs.volatile, 'boolean')
})

const MOUNTINFO = [
  '22 1 254:0 / / rw,relatime - ext4 /dev/vda rw',
  '30 22 0:40 / /mnt/Team\\040Share rw,relatime - cifs //nas/Team\\040Share rw,vers=3.0',
  '31 22 0:41 / /mnt/Team rw,relatime - ext4 /dev/vdb rw',
  '32 22 0:42 / /home/me/remote rw - fuse.sshfs me@host:/srv rw,user_id=0',
  '33 22 0:43 / /srv/data rw - nfs4 nas:/export rw,vers=4.2',
  '34 22 0:44 / /dev/shm rw shared:2 - tmpfs tmpfs rw,size=1024k',
  '35 22 0:45 / /var/lib/ci rw - overlay overlay rw,lowerdir=/l,upperdir=/u,workdir=/w,volatile',
  '36 22 0:46 / /var/lib/app rw - overlay overlay rw,lowerdir=/l,upperdir=/u,workdir=/w',
  '37 22 0:47 / /mnt/back\\134slash rw - ext4 /dev/vdc rw',
  '',
].join('\n')

test('parseMountinfo decodes escaped mount points and picks the longest prefix', () => {
  const at = (path: string): Pick<FsType, 'type' | 'mount' | 'network' | 'volatile'> => {
    const { type, mount, network, volatile } = parseMountinfo(MOUNTINFO, path)
    return { type, mount, network, volatile }
  }
  assert.deepEqual(at('/mnt/Team Share/store'), {
    type: 'cifs',
    mount: '/mnt/Team Share',
    network: true,
    volatile: false,
  })
  assert.equal(parseMountinfo(MOUNTINFO, '/mnt/Team Share').source, '//nas/Team Share')
  assert.equal(at('/mnt/Team/store').type, 'ext4', 'a sibling with a shared prefix is distinct')
  assert.equal(at('/mnt/back\\slash/x').mount, '/mnt/back\\slash')
  assert.deepEqual(at('/home/me/remote/x'), {
    type: 'fuse.sshfs',
    mount: '/home/me/remote',
    network: true,
    volatile: false,
  })
  assert.equal(at('/srv/data').network, true, 'nfs4 is a network filesystem')
  assert.equal(at('/etc').mount, '/')
  assert.equal(parseMountinfo('garbage\n', '/x').type, 'unknown')
})

test('parseMountinfo marks filesystems whose fsync does not persist as volatile', () => {
  assert.equal(parseMountinfo(MOUNTINFO, '/dev/shm/s').volatile, true, 'tmpfs never persists')
  assert.equal(parseMountinfo(MOUNTINFO, '/var/lib/ci/s').volatile, true, 'overlay volatile')
  const overlay = parseMountinfo(MOUNTINFO, '/var/lib/app/s')
  assert.equal(overlay.type, 'overlay')
  assert.equal(overlay.volatile, false, 'a non-volatile overlay syncs its upper filesystem')
})

const passing = (): InspectProbes => ({
  mkdirAtomic: { ok: true, winners: 1, contenders: 16 },
  renameReplace: { ok: true },
  exclusiveCreate: { ok: true },
  closeToOpen: { ok: true },
  mtimeResolution: { ok: true, resolutionMs: 1, subSecond: true },
  symlink: { ok: true },
  hardlink: { ok: true },
  fsyncDir: { ok: true },
  walViable: { ok: true, journalMode: 'wal' },
  durableFsync: { ok: true },
})

const fsOf = (fs: Partial<FsType>): FsType => ({
  type: 'ext4',
  mount: '/',
  network: false,
  source: '/dev/vda',
  volatile: false,
  ...fs,
})

test('the verdict refuses a volatile filesystem and warns on overlayfs', () => {
  const local = inspectVerdict(fsOf({}), passing())
  assert.equal(local.fsqliteSafe, true)
  assert.equal(local.walSafe, true)

  const tmpfsProbes = passing()
  tmpfsProbes.durableFsync = { ok: false, error: 'tmpfs never persists data to stable storage' }
  const tmpfs = inspectVerdict(fsOf({ type: 'tmpfs', volatile: true }), tmpfsProbes)
  assert.equal(tmpfs.fsqliteSafe, false)
  assert.deepEqual(tmpfs.missing, ['durableFsync'])
  assert.match(tmpfs.recommendation, /do NOT host an fsqlite store here: missing durableFsync/)

  const overlay = inspectVerdict(fsOf({ type: 'overlay' }), passing())
  assert.equal(overlay.fsqliteSafe, true)
  assert.match(overlay.warnings.join('\n'), /overlayfs .* EXDEV/)

  const network = inspectVerdict(fsOf({ type: 'nfs4', network: true }), passing())
  assert.equal(network.walSafe, false)
  assert.match(network.recommendation, /plain WAL is unsafe/)
})
