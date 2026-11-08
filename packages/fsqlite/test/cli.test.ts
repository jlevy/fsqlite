// The CLI runs in-process through `main(argv, io)`, which returns its exit code. Importing
// the module must not run a command, print, or touch the process exit code: the
// `fsqlite/cli` export and the bin share it. The goldens cover the commands end to end.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { main } from '../src/cli/main.ts'
import type { CliIo } from '../src/cli/main.ts'
import { SnapshotStore } from '../src/index.ts'
import { STORE_OPTS, tmpStore } from './fixture.ts'

const exitCodeAfterImport = process.exitCode

/** Run one invocation, capturing its output. */
function cli(...argv: string[]): { code: number; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  const io: CliIo = { out: (line) => out.push(line), err: (line) => err.push(line) }
  return { code: main(argv, io), out, err }
}

test('importing the CLI module runs nothing and leaves the exit code alone', () => {
  assert.equal(exitCodeAfterImport, undefined)
})

test('main returns the exit code of each invocation instead of setting it', () => {
  const { dir, cleanup } = tmpStore()
  try {
    new SnapshotStore(dir, STORE_OPTS).init()
    const help = cli('--help')
    assert.equal(help.code, 0)
    assert.match(help.out.join('\n'), /^usage: fsqlite /)
    assert.equal(cli().code, 64)
    const validate = cli('validate', dir)
    assert.deepEqual([validate.code, validate.out], [0, ['sealed']])
    assert.equal(process.exitCode, undefined)
  } finally {
    cleanup()
  }
})
