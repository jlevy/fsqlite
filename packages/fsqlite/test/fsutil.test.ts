import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fsyncDir, publishPointer } from '../src/fsutil.ts'
import { tmpStore } from './fixture.ts'

test('publishPointer removes its temp when replacement fails', () => {
  const { dir, cleanup } = tmpStore()
  try {
    const current = join(dir, 'current')
    mkdirSync(current)
    assert.throws(() => {
      publishPointer(dir, current, 1)
    })
    assert.equal(existsSync(current), true)
    assert.deepEqual(
      readdirSync(dir).filter((entry) => entry.startsWith('current.') && entry.endsWith('.tmp')),
      [],
    )
  } finally {
    cleanup()
  }
})

test('fsyncDir fails closed when the required durability barrier is unavailable', () => {
  const { dir, cleanup } = tmpStore()
  try {
    assert.throws(() => {
      fsyncDir(join(dir, 'missing-directory'))
    }, /ENOENT|no such file or directory/i)
  } finally {
    cleanup()
  }
})
