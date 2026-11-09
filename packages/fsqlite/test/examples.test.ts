// The runnable examples assert their own results, so running them catches an example
// that drifts from the library's behavior.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Bound for one example process. */
const EXAMPLE_TIMEOUT_MS = 20_000

for (const example of ['demo.ts', 'document-catalog.ts']) {
  test(`examples/${example} runs and its checks pass`, () => {
    const path = fileURLToPath(new URL(`../examples/${example}`, import.meta.url))
    const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path], {
      encoding: 'utf8',
      timeout: EXAMPLE_TIMEOUT_MS,
    })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /"state":"sealed"/)
  })
}
