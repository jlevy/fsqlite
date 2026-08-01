// Small filesystem durability helpers shared by the publish paths. Atomic rename gives
// ordering; fsync gives power-loss durability. Process-crash safety needs neither, so these
// are cheap belt-and-suspenders for the hosted-on-real-disk case.

import { openSync, fsyncSync, closeSync } from 'node:fs'

/** fsync a file's contents to disk so a following rename is crash-durable. */
export function fsyncPath(p: string): void {
  const fd = openSync(p, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** fsync a directory so a rename into it survives power loss. A no-op where unsupported. */
export function fsyncDir(p: string): void {
  let fd: number
  try {
    fd = openSync(p, 'r')
  } catch {
    return // directory fsync is not available on every platform/filesystem
  }
  try {
    fsyncSync(fd)
  } catch {
    /* ignore: best-effort durability barrier */
  } finally {
    closeSync(fd)
  }
}
