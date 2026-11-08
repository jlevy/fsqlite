// Small filesystem durability helpers shared by the publish paths. Atomic rename gives
// ordering; fsync gives power-loss durability. Process-crash safety needs neither, so these
// are cheap belt-and-suspenders for the hosted-on-real-disk case.

import { openSync, fsyncSync, closeSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { PostPublishError } from './types.ts'

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

/** fsync a file's contents to disk so a following rename is crash-durable. */
export function fsyncPath(p: string): void {
  const fd = openSync(p, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  afterFsyncPathHook?.(p)
}

/** fsync a directory so a rename into it survives power loss. Fails if unsupported. */
export function fsyncDir(p: string): void {
  const fd = openSync(p, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  afterFsyncDirHook?.(p)
}

/** Wrap a failure that happened after `current` already named `version`. */
export function postPublishError(version: number, cause: unknown): PostPublishError {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return Object.assign(
    new Error(
      `version ${version} is published, but a later step failed (${reason}); ` +
        'do not re-run the write it carries',
      { cause },
    ),
    { published: version },
  )
}

/** Whether `error` was raised after its operation had already published a version. */
export function isPostPublishError(error: unknown): error is PostPublishError {
  return (
    error instanceof Error && typeof (error as Partial<PostPublishError>).published === 'number'
  )
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
    rmSync(tempPath, { force: true })
    throw error
  }
  try {
    fsyncDir(storeDir)
  } catch (error) {
    throw postPublishError(version, error)
  }
}
