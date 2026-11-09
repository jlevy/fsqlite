// Small filesystem durability helpers shared by the publish paths. Atomic rename gives
// ordering; fsync gives power-loss durability. Process-crash safety needs neither, so these
// are cheap belt-and-suspenders for the hosted-on-real-disk case.

import { openSync, fsyncSync, closeSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { PostPublishError } from './errors.ts'

type AfterFsyncPathHook = (path: string) => void
let afterFsyncPathHook: AfterFsyncPathHook | null = null
type AfterFsyncDirHook = (path: string) => void
let afterFsyncDirHook: AfterFsyncDirHook | null = null

/** Internal fault-injection seam; pass null to remove the hook. */
export function setAfterFsyncPathForTest(hook: AfterFsyncPathHook | null): void {
  afterFsyncPathHook = hook
}

/** Internal fault-injection seam; pass null to remove the hook. */
export function setAfterFsyncDirForTest(hook: AfterFsyncDirHook | null): void {
  afterFsyncDirHook = hook
}

/**
 * fsync a regular file's contents to disk so a following rename is crash-durable.
 *
 * The file is opened read-write ('r+', which never truncates or creates). POSIX fsync
 * flushes the same through any descriptor, but Windows `FlushFileBuffers`, which Node's
 * fsync calls there, fails on a read-only handle. Every file fsqlite syncs is one it
 * created, so it is writable. Directories go through {@link fsyncDir}.
 */
export function fsyncPath(p: string): void {
  const fd = openSync(p, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  afterFsyncPathHook?.(p)
}

/**
 * fsync a directory so a rename into it survives power loss. Fails if unsupported. A
 * directory can only be opened read-only, and directory fsync is POSIX-only (spec O1).
 */
export function fsyncDir(p: string): void {
  const fd = openSync(p, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  afterFsyncDirHook?.(p)
}

/**
 * Remove `path` (recursively) while another error is propagating. A failure here must not
 * replace the error being reported, so it is dropped: whatever remains is a transient that
 * validate reports and gc or repair removes.
 */
export function removeQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // Keep the original error; the leftover is ordinary transient debris.
  }
}

/**
 * Durably replace a store's numeric current pointer. A failure after the rename (the root
 * directory fsync) is a {@link PostPublishError}: the new version is already visible.
 */
export function publishPointer(storeDir: string, currentPath: string, version: number): void {
  const tempPath = `${currentPath}.${randomBytes(5).toString('hex')}.tmp`
  try {
    writeFileSync(tempPath, String(version), { flag: 'wx' })
    fsyncPath(tempPath)
    renameSync(tempPath, currentPath)
  } catch (error) {
    removeQuietly(tempPath)
    throw error
  }
  try {
    fsyncDir(storeDir)
  } catch (error) {
    throw new PostPublishError(version, error)
  }
}
