#!/usr/bin/env node
// The `fsqlite` executable: run the CLI in main.ts against this process.

import { main } from './main.ts'

/**
 * node:sqlite announces itself as experimental on Node 22 the first time it loads. The
 * notice is not about fsqlite's behavior, and it would follow every CLI command on
 * stderr, so the bin drops exactly that warning and prints every other one as Node would.
 * Node emits warnings on a later tick, so this runs before the notice is delivered even
 * though the static import above has already loaded node:sqlite.
 */
function quietSqliteExperimentalWarning(): void {
  const printers = process.listeners('warning')
  process.removeAllListeners('warning')
  process.on('warning', (warning) => {
    if (warning.name === 'ExperimentalWarning' && warning.message.startsWith('SQLite ')) {
      return
    }
    for (const print of printers) {
      print(warning)
    }
  })
}

quietSqliteExperimentalWarning()

// A consumer that stops reading stdout early (`fsqlite info <dir> | head`) is the expected
// end of the output, so its EPIPE is a quiet stop. It must never replace the command's
// exit code, which is already set when the asynchronous error arrives, and the process
// must not exit from here, which would drop writes still pending on stderr.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') {
    process.exitCode ??= 0
    return
  }
  throw err
})
// A closed diagnostics stream is not a successful early close: the outcome stays whatever
// the command chose, and any other stderr failure propagates.
process.stderr.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EPIPE') {
    throw err
  }
})

process.exitCode = main(process.argv.slice(2))
