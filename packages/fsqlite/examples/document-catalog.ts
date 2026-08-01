// Worked example: a document catalog that concurrent writers populate through fsqlite,
// and a runnable demo of two writers updating one catalog at the same time.
//
// The consumer supplies ONLY its domain schema and a per-table merge policy; fsqlite
// provides the concurrent, crash-safe engine. Nothing here is fsqlite-internal — it is
// the concrete shape of a realistic adopter: a catalog of documents, their content
// blobs, a URL index, and typed relationships, written by many agents at once.
//
//   node examples/document-catalog.ts

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnapshotStore } from '../src/index.ts'
import type { ConflictPolicyInput } from '../src/types.ts'

// A content-catalog schema: documents, their on-disk paths, content-addressed blobs, a
// URL index, an action/request index, and typed relationships. Every table has an
// explicit non-null PRIMARY KEY — the merge policy is keyed on it.
export const CATALOG_SCHEMA = `
CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY NOT NULL,
  kind TEXT, title TEXT, metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE artifact_paths (
  artifact_id TEXT NOT NULL, path TEXT NOT NULL,
  path_role TEXT NOT NULL DEFAULT 'primary', digest TEXT, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, path)
);
CREATE TABLE content_blobs (
  blob_id TEXT PRIMARY KEY NOT NULL,
  digest TEXT NOT NULL, size INTEGER NOT NULL, content_type TEXT NOT NULL,
  storage_kind TEXT NOT NULL, path TEXT, created_at TEXT NOT NULL
);
CREATE TABLE url_index (
  url_hash TEXT PRIMARY KEY NOT NULL, normalized_url TEXT NOT NULL,
  blob_id TEXT NOT NULL, fetched_at TEXT NOT NULL
);
CREATE TABLE action_index (
  action_hash12 TEXT PRIMARY KEY NOT NULL, request_hash TEXT NOT NULL,
  blob_id TEXT NOT NULL, fetched_at TEXT NOT NULL
);
CREATE TABLE relationships (
  relationship_id TEXT PRIMARY KEY NOT NULL,
  subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, predicate TEXT NOT NULL,
  object_kind TEXT NOT NULL, object_id TEXT NOT NULL, created_at TEXT NOT NULL
);
`

// Per-table merge semantics for this catalog:
//   url/action caches = last-writer-wins (the newest fetch wins);
//   relationships/content_blobs = set-union (content-addressed, so duplicates dedup);
//   documents/paths = last-writer-wins; anything else ('*') = strict (deny-by-default).
export const CATALOG_POLICY: ConflictPolicyInput = {
  url_index: 'lww',
  action_index: 'lww',
  relationships: 'union',
  content_blobs: 'union',
  artifacts: 'lww',
  artifact_paths: 'lww',
  '*': 'strict',
}

export const openCatalog = (catalogDir: string): SnapshotStore =>
  new SnapshotStore(catalogDir, {
    schema: CATALOG_SCHEMA,
    schemaVersion: 1,
    conflictPolicy: CATALOG_POLICY,
    toolVersion: 'example-catalog',
  }).init()

// --- Demo: two writers update one catalog concurrently -----------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-'))
  const cat = openCatalog(dir)
  const now = (): string => new Date().toISOString()

  // Writer A fetches a page, stores the blob, indexes the URL, records a document.
  cat.write('writerA', (db) => {
    db.prepare('INSERT INTO content_blobs VALUES (?,?,?,?,?,?,?)').run(
      'blob_sha256_aaa',
      'sha256:aaa',
      1234,
      'text/html',
      'managed',
      'data/blobs/aaa.html.zst',
      now(),
    )
    db.prepare('INSERT INTO url_index VALUES (?,?,?,?)').run(
      'urlh_1',
      'https://example.com/a',
      'blob_sha256_aaa',
      now(),
    )
    db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?,?)').run(
      'doc_a',
      'report',
      'Example Report',
      '{}',
      now(),
      now(),
    )
    db.prepare('INSERT INTO relationships VALUES (?,?,?,?,?,?,?)').run(
      'rel_1',
      'artifact',
      'doc_a',
      'derived_from',
      'blob',
      'blob_sha256_aaa',
      now(),
    )
  })
  // Writer B, seeded off the same base, refetches the SAME url (newer) and re-adds an edge.
  cat.write('writerB', (db) => {
    db.prepare('INSERT INTO content_blobs VALUES (?,?,?,?,?,?,?)').run(
      'blob_sha256_bbb',
      'sha256:bbb',
      999,
      'text/html',
      'managed',
      'data/blobs/bbb.html.zst',
      now(),
    )
    db.prepare('INSERT INTO url_index VALUES (?,?,?,?)').run(
      'urlh_1',
      'https://example.com/a',
      'blob_sha256_bbb',
      now(),
    ) // lww: newer fetch wins
    db.prepare('INSERT INTO relationships VALUES (?,?,?,?,?,?,?)').run(
      'rel_1',
      'artifact',
      'doc_a',
      'derived_from',
      'blob',
      'blob_sha256_aaa',
      now(),
    ) // dup edge: union → no-op
  })

  const res = cat.reconcile()
  const read1 = <T>(sql: string, ...args: (string | number)[]): T =>
    cat.read((db) => db.prepare(sql).get(...args) as T)
  console.log('reconcile:', JSON.stringify(res))
  console.log(
    'url_index[urlh_1] →',
    read1<{ blob_id: string }>('SELECT blob_id FROM url_index WHERE url_hash=?', 'urlh_1').blob_id,
    '(expect blob_sha256_bbb: last-writer-wins)',
  )
  console.log(
    'relationships count →',
    read1<{ c: number }>('SELECT COUNT(*) c FROM relationships').c,
    '(expect 1: set-union deduped the duplicate edge)',
  )
  console.log(
    'content_blobs count →',
    read1<{ c: number }>('SELECT COUNT(*) c FROM content_blobs').c,
    '(expect 2)',
  )
  console.log('validate:', JSON.stringify(cat.validate()))
  rmSync(dir, { recursive: true, force: true })
}
