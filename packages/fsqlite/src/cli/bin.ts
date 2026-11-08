#!/usr/bin/env node
// The `fsqlite` executable: run the CLI in main.ts against this process.

import { main } from './main.ts'

// Exit cleanly when output is piped to a closed reader (e.g. `fsqlite info <dir> | head`).
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      process.exit(0)
    }
    throw err
  })
}

process.exitCode = main(process.argv.slice(2))
