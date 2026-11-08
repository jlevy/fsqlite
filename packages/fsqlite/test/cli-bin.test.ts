// The `fsqlite` executable keeps the command's exit code when a consumer closes its
// output early (`fsqlite validate s | head -c0`): a closed stdout is a quiet stop, never a
// success that hides a failure, and a closed stderr never changes the outcome.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SnapshotStore } from '../src/index.ts'
import { STORE_OPTS, tmpStore } from './fixture.ts'

const BIN = fileURLToPath(new URL('../src/cli/bin.ts', import.meta.url))
/** Bound for one CLI child process; a hang fails here instead of at the suite timeout. */
const CHILD_TIMEOUT_MS = 15_000

/** Run the bin with one output stream's read end closed before the child writes to it. */
function runWithClosed(stream: 'stdout' | 'stderr', args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CHILD_TIMEOUT_MS,
    })
    child[stream].destroy()
    const other = stream === 'stdout' ? child.stderr : child.stdout
    other.resume()
    child.on('error', reject)
    child.on('close', (code) => {
      resolve(code)
    })
  })
}

test('a closed stdout keeps a failing exit code and is a quiet stop on success', async () => {
  const { dir, cleanup } = tmpStore()
  try {
    const healthy = join(dir, 'healthy')
    new SnapshotStore(healthy, STORE_OPTS).init()
    const corrupt = join(dir, 'corrupt')
    writeFileSync(new SnapshotStore(corrupt, STORE_OPTS).init().currentPath, 'xxx')

    assert.equal(await runWithClosed('stdout', ['validate', corrupt]), 3)
    assert.equal(await runWithClosed('stdout', ['validate', healthy]), 0)
  } finally {
    cleanup()
  }
})

test('a closed stderr never turns a failure into success', async () => {
  const { dir, cleanup } = tmpStore()
  try {
    assert.equal(await runWithClosed('stderr', ['validate', dir]), 64) // not a store
  } finally {
    cleanup()
  }
})
