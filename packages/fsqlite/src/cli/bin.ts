#!/usr/bin/env node
// The `fsqlite` executable: run the CLI in main.ts against this process.

import { main } from './main.ts'

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
