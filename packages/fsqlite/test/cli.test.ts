// The CLI runs in-process through `main(argv, io)`, which returns its exit code. Importing
// the module must not run a command, print, or touch the process exit code: the
// `fsqlite/cli` export and the bin share it. The goldens cover the commands end to end.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXIT, exitCodeForError, exitCodeForState, main } from '../src/cli/main.ts'
import type { CliIo } from '../src/cli/main.ts'
import { FsqliteError, SnapshotStore } from '../src/index.ts'
import type { FsqliteErrorCode, StoreValidationState } from '../src/index.ts'
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

test('every store state and error code maps to its documented exit code', () => {
  const states: Record<StoreValidationState, number> = {
    sealed: EXIT.ok,
    live: EXIT.ok,
    'in-flight-capture': EXIT.inFlight,
    invalid: EXIT.invalidOrCorrupt,
    corrupt: EXIT.invalidOrCorrupt,
    unsupported: EXIT.unsupported,
    'not-a-store': EXIT.usage,
  }
  for (const [state, code] of Object.entries(states)) {
    assert.equal(exitCodeForState(state as StoreValidationState), code, state)
  }
  const codes: Record<FsqliteErrorCode, number> = {
    'not-a-store': 64,
    invalid: 3,
    corrupt: 3,
    unsupported: 4,
    'in-flight': 2,
    conflict: 1,
    retryable: 1,
    'post-publish': 1,
    incompatible: 1,
    refused: 1,
    io: 1,
  }
  for (const [code, exit] of Object.entries(codes)) {
    assert.equal(exitCodeForError(new FsqliteError(code as FsqliteErrorCode, code)), exit, code)
  }
  assert.equal(exitCodeForError(new Error('unclassified')), EXIT.failure)
})

test('an error prints its cause chain, as JSON under --json', () => {
  const { dir, cleanup } = tmpStore()
  try {
    new SnapshotStore(dir, STORE_OPTS).init()
    writeFileSync(join(dir, 'leases', 'torn.lease'), '')
    const text = cli('gc', dir)
    assert.equal(text.code, EXIT.failure)
    assert.match(text.err[0] ?? '', /^fsqlite: gc refused: fresh lease torn\.lease is unreadable/)
    assert.match(text.err[1] ?? '', /^ {2}caused by: /)
    const json = cli('gc', dir, '--json')
    const reported = JSON.parse(json.err[0] ?? '') as { error: { code: string; causes: string[] } }
    assert.equal(reported.error.code, 'retryable')
    assert.equal(reported.error.causes.length, 1)
  } finally {
    cleanup()
  }
})
