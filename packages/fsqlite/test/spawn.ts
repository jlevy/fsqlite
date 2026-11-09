// Spawn a worker as a real child process. Workers are `.ts` run via Node's native
// type stripping in Node 22.18 or later, so the baseline needs no build step or
// `--experimental-sqlite` flag. The worker prints one JSON line to stdout.

import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
/**
 * A worker that runs longer than this is killed, so a hung child fails its test with
 * context instead of consuming the 30 s suite timeout or outliving the run.
 */
const WORKER_TIMEOUT_MS = 25_000
const worker = (name: string): string => join(HERE, '..', 'workers', name)

function lastJsonLine<T>(out: string): T {
  return JSON.parse(out.trim().split('\n').pop() ?? '{}') as T
}

export function runSync<T>(name: string, args: string[]): T {
  const r = spawnSync(process.execPath, [worker(name), ...args], {
    encoding: 'utf8',
    timeout: WORKER_TIMEOUT_MS,
  })
  if (r.status !== 0) {
    throw new Error(`${name} failed: ${r.stderr}`)
  }
  return lastJsonLine<T>(r.stdout)
}

/** Start a worker without waiting for it; the caller must kill it when done. */
export function spawnWorker(name: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [worker(name), ...args], { timeout: WORKER_TIMEOUT_MS })
}

export function runAsync<T>(name: string, args: string[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const p = spawnWorker(name, args)
    let out = ''
    let err = ''
    p.stdout.setEncoding('utf8')
    p.stderr.setEncoding('utf8')
    p.stdout.on('data', (d: string) => {
      out += d
    })
    p.stderr.on('data', (d: string) => {
      err += d
    })
    p.on('error', reject)
    p.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) {
        resolve(lastJsonLine<T>(out))
      } else {
        reject(new Error(`${name} exited ${String(code ?? signal)}: ${err}`))
      }
    })
  })
}
