// Spawn a worker as a real child process. Workers are `.ts` run via Node's native
// type-stripping (Node ≥ 22.18), so no build step and no `--experimental-sqlite` flag is
// needed on the v22.13+ baseline. The worker prints a single JSON line on stdout.

import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const worker = (name: string): string => join(HERE, '..', 'workers', name)

function lastJsonLine<T>(out: string): T {
  return JSON.parse(out.trim().split('\n').pop() ?? '{}') as T
}

export function runSync<T>(name: string, args: string[]): T {
  const r = spawnSync(process.execPath, [worker(name), ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${name} failed: ${r.stderr}`)
  return lastJsonLine<T>(r.stdout)
}

export function spawnWorker(name: string, args: string[]) {
  return spawn(process.execPath, [worker(name), ...args])
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
    p.on('close', (code: number | null) => {
      if (code === 0) resolve(lastJsonLine<T>(out))
      else reject(new Error(`${name} exited ${String(code)}: ${err}`))
    })
  })
}
