// Small filesystem durability helpers shared by the publish paths. Atomic rename gives
// ordering; fsync gives power-loss durability. Process-crash safety needs neither, so these
// are cheap belt-and-suspenders for the hosted-on-real-disk case.

import {
  openSync,
  fsyncSync,
  closeSync,
  renameSync,
  writeFileSync,
  copyFileSync,
  constants,
  rmSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'

/**
 * Copy an immutable snapshot, preferring a copy-on-write reflink.
 *
 * Seeding a writer and building a reconcile candidate both start by copying the current
 * snapshot, so this copy, not the caller's work, dominates write cost on a large store
 * (see fsqlite-design.md, "Operating Envelope"). `COPYFILE_FICLONE` asks the filesystem
 * to share the underlying extents instead of duplicating them, which turns the copy into
 * a metadata operation on APFS, btrfs, and XFS. It is a hint, not a requirement:
 * filesystems without copy-on-write fall back to a full byte copy, so behavior is
 * identical everywhere and only the cost changes. This is safe precisely because
 * published snapshots are immutable (S6), so a shared extent is never written through.
 */
export function cloneFile(src: string, dest: string): void {
  copyFileSync(src, dest, constants.COPYFILE_FICLONE)
}

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

/** Durably replace a store's numeric current pointer. */
export function publishPointer(storeDir: string, currentPath: string, version: number): void {
  const tempPath = `${currentPath}.${randomBytes(5).toString('hex')}.tmp`
  try {
    writeFileSync(tempPath, String(version), { flag: 'wx' })
    fsyncPath(tempPath)
    renameSync(tempPath, currentPath)
    fsyncDir(storeDir)
  } catch (error) {
    // Never leave a partial pointer temp behind: the store root is swept by `gc` and
    // reported by `validate`, so a leaked temp would read as an in-flight publish forever.
    rmSync(tempPath, { force: true })
    throw error
  }
}
