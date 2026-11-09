// Plain-SQLite inspection behind the `stats` and `doctor` CLI commands. These read any
// SQLite file, not just an fsqlite store, so the operator tool works on any SQLite path
// and distinguishes plain-SQLite facts from the fsqlite layer.

import { openSync, readSync, closeSync, statSync } from 'node:fs'
import * as driver from './driver.ts'

const SQLITE_MAGIC = 'SQLite format 3\0'

/**
 * True if `path` is a regular file that starts with the SQLite magic header. A path that
 * cannot be read is reported as not a SQLite file.
 */
export function isSqliteFile(path: string): boolean {
  let fd: number
  try {
    if (!statSync(path).isFile()) {
      return false
    }
    fd = openSync(path, 'r')
  } catch {
    return false
  }
  try {
    const buf = Buffer.alloc(SQLITE_MAGIC.length)
    return (
      readSync(fd, buf, 0, SQLITE_MAGIC.length, 0) === SQLITE_MAGIC.length &&
      buf.toString('latin1') === SQLITE_MAGIC
    )
  } finally {
    closeSync(fd)
  }
}

/** A table of a SQLite file and its row count. */
export interface SqliteTableFacts {
  name: string
  rows: number
}

/** Header, page, and schema facts about any SQLite file, read without its schema. */
export interface SqliteFacts {
  /** The SQLite library version that read the file, not the version that wrote it. */
  sqliteVersion: string
  pageSize: number
  pageCount: number
  fileBytes: number
  /** `PRAGMA application_id`; fsqlite snapshots carry `FSQLITE_APPLICATION_ID`. */
  applicationId: number
  /** `PRAGMA user_version`, which belongs to the caller's schema. */
  userVersion: number
  journalMode: string
  tables: SqliteTableFacts[]
}

const pragmaValue = (db: driver.DB, pragma: string): unknown =>
  Object.values(db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown>)[0]

/** Header/page/schema facts for a plain SQLite file (opened read-only). */
export function sqliteFacts(path: string): SqliteFacts {
  const db = driver.openReadonly(path)
  try {
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => {
      const quoted = `"${r.name.replace(/"/g, '""')}"`
      const rows = (db.prepare(`SELECT COUNT(*) c FROM ${quoted}`).get() as { c: number }).c
      return { name: r.name, rows }
    })
    return {
      sqliteVersion: (db.prepare('SELECT sqlite_version() v').get() as { v: string }).v,
      pageSize: Number(pragmaValue(db, 'page_size')),
      pageCount: Number(pragmaValue(db, 'page_count')),
      fileBytes: statSync(path).size,
      applicationId: Number(pragmaValue(db, 'application_id')),
      userVersion: Number(pragmaValue(db, 'user_version')),
      journalMode: String(pragmaValue(db, 'journal_mode')),
      tables,
    }
  } finally {
    db.close()
  }
}

/** Physical integrity and foreign key problems for a plain SQLite file ([] = clean). */
export function integrityReport(path: string): string[] {
  const db = driver.openReadonly(path)
  try {
    return driver.integrityProblems(db)
  } finally {
    db.close()
  }
}
