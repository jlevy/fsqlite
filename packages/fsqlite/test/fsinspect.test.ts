// The FS-capability diagnostic must report structured, correct results, and a local disk
// (where tests run) must pass every coordination probe.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect, formatReport, detectFsType } from '../src/fsinspect.ts'

function withTmp(fn: (dir: string) => unknown): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'fsinspect-test-'))
  const done = (): void => {
    rmSync(dir, { recursive: true, force: true })
  }
  return Promise.resolve(fn(dir)).then(
    () => {
      done()
    },
    (e: unknown) => {
      done()
      throw e
    },
  )
}

test('inspect returns a structured report with all probes', async () => {
  await withTmp((dir) => {
    const r = inspect(dir)
    assert.equal(r.dir, dir)
    for (const k of [
      'mkdirAtomic',
      'renameReplace',
      'exclusiveCreate',
      'closeToOpen',
      'mtimeResolution',
      'symlink',
      'hardlink',
      'fsyncDir',
      'walViable',
    ] as const) {
      assert.ok(k in r.probes, `missing probe ${k}`)
      assert.equal(typeof r.probes[k].ok, 'boolean', `${k}.ok not boolean`)
    }
    assert.equal(typeof r.verdict.fsqliteSafe, 'boolean')
    assert.ok(Array.isArray(r.verdict.missing))
  })
})

test('local temp disk passes every required coordination probe', async () => {
  await withTmp((dir) => {
    const r = inspect(dir)
    for (const k of ['mkdirAtomic', 'renameReplace', 'exclusiveCreate', 'closeToOpen'] as const) {
      assert.ok(r.probes[k].ok, `expected ${k} ok on local disk: ${r.probes[k].error ?? ''}`)
    }
    assert.equal(r.verdict.fsqliteSafe, true)
    assert.deepEqual(r.verdict.missing, [])
  })
})

test('mkdirAtomic elects exactly one winner under contention', async () => {
  await withTmp((dir) => {
    const r = inspect(dir)
    assert.equal(r.probes.mkdirAtomic.ok, true)
    assert.equal(r.probes.mkdirAtomic.winners, 1)
    assert.ok(Number(r.probes.mkdirAtomic.contenders) >= 2)
  })
})

test('mtimeResolution reports a numeric resolution or null on a coarse filesystem', async () => {
  await withTmp((dir) => {
    const r = inspect(dir)
    assert.equal(r.probes.mtimeResolution.ok, true)
    const resolution = r.probes.mtimeResolution.resolutionMs
    assert.ok(resolution === null || typeof resolution === 'number')
  })
})

test('inspect leaves no scratch directory behind', async () => {
  await withTmp((dir) => {
    inspect(dir)
    const leftovers = readdirSync(dir).filter((n) => n.startsWith('.fsinspect-'))
    assert.deepEqual(leftovers, [], `scratch dirs left: ${leftovers.join(', ')}`)
  })
})

test('formatReport renders the dir, probes, and verdict', async () => {
  await withTmp((dir) => {
    const out = formatReport(inspect(dir))
    assert.match(out, /fsinspect:/)
    assert.match(out, /mkdirAtomic/)
    assert.match(out, /verdict:/)
  })
})

test('detectFsType returns a type and network flag without throwing', () => {
  const fs = detectFsType(process.cwd())
  assert.equal(typeof fs.type, 'string')
  assert.equal(typeof fs.network, 'boolean')
})
