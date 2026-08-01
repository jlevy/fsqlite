// Shared test fixture: a small caller schema and merge policy that exercise the three
// representative merge semantics (last-writer-wins, set-union, abort).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StoreOptions } from '../src/types.ts'

export const SCHEMA = `
CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY NOT NULL,
  title TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE url_index (
  url_hash TEXT PRIMARY KEY NOT NULL,
  normalized_url TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE TABLE relationships (
  relationship_id TEXT PRIMARY KEY NOT NULL,
  subject_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object_id TEXT NOT NULL
);
`

// url_index = last-writer-wins (newest fetch wins); relationships = set-union;
// artifacts = last-writer-wins. Default '*' is 'strict' (deny-by-default).
export const POLICY = {
  url_index: 'lww',
  relationships: 'union',
  artifacts: 'lww',
  '*': 'strict',
} as const

export const STORE_OPTS: StoreOptions = {
  schema: SCHEMA,
  schemaVersion: 1,
  conflictPolicy: { ...POLICY },
}

export function tmpStore(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'fsqlite-'))
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
