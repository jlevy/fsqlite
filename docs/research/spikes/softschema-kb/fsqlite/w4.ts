// W4 schema evolution: what each change needs under the generic mapping (a) and the
// typed per-kind mapping (b), and how long it takes.
//
// Usage: node w4.ts --scale S0 [--work <dir>]
//
// Starts from a copy of the W1 `direct` store. Data-only changes are SnapshotStore
// envelopes folded by reconcile. DDL changes cannot happen in place: a write callback
// that runs DDL is refused, and a handle with different DDL is incompatible, so they are
// side-by-side copies into a new store (migrate.ts, typed.ts).

import { cpSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { DirectStore, FsqliteError, SnapshotStore } from './fsq.ts'
import { WORK_DIR, isMain, nowMs, parseArgs, round, writeResult } from './common.ts'
import { dirBytes, sizeBreakdown } from './w1.ts'
import {
  GENERIC_POLICY,
  GENERIC_SCHEMA_VERSION,
  GenericLoader,
  TABLE_VIEWS,
  genericDdl,
} from './mapping.ts'
import type { JsonObject } from './mapping.ts'
import { migrateSnapshot } from './migrate.ts'
import { buildTyped, readKindSchemas, typedDdl } from './typed.ts'
import { KbQueries } from './queries.ts'
import { genericStore, openReader } from './w3.ts'

const LOCK = { lockOpts: { timeoutMs: 600_001, staleMs: 600_000 } }

/** Capture one envelope, measure its size, and reconcile it. */
function envelope(store: SnapshotStore, dir: string, fn: (db: DatabaseSync) => void) {
  const t0 = nowMs()
  const tx = store.write('w4', fn)
  const captureMs = nowMs() - t0
  const bytes = tx ? statSync(join(dir, 'tx', 'pending', `${tx}.txn`, 'changeset.bin')).size : 0
  const t1 = nowMs()
  const result = store.reconcile(LOCK)
  return {
    ddl: 'none',
    route: 'SnapshotStore envelope + reconcile',
    capture_ms: round(captureMs),
    envelope_bytes: bytes,
    reconcile_ms: round(nowMs() - t1),
    total_ms: round(nowMs() - t0),
    applied: result.applied,
    quarantined: result.quarantined,
  }
}

function attempt(label: string, fn: () => unknown): Record<string, string> {
  try {
    fn()
    return { attempt: label, outcome: 'accepted' }
  } catch (error) {
    const code = error instanceof FsqliteError ? error.code : 'error'
    return {
      attempt: label,
      outcome: `rejected (${code})`,
      message: String((error as Error).message),
    }
  }
}

function main(): void {
  const { flags } = parseArgs(process.argv.slice(2))
  const scale = flags.scale ?? 'S0'
  const work = join(flags.work ?? WORK_DIR, scale)
  const dir = join(work, 'w4', 'store')
  rmSync(join(work, 'w4'), { recursive: true, force: true })
  cpSync(join(work, 'store-direct'), dir, { recursive: true })
  const store = genericStore(dir).init()
  const head = (): string => store.snapshotPath(store.currentVersion())
  const generic: Record<string, unknown> = {}

  // 1. A new kind with records and relationships: one `recording` per session.
  const recordingSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    additionalProperties: false,
    title: 'Recording',
    type: 'object',
    properties: {
      id: { pattern: '^(recording):[a-z0-9][a-z0-9._/@+-]*$', type: 'string' },
      session: { pattern: '^(session):[a-z0-9][a-z0-9._/@+-]*$', type: 'string' },
      title: { type: 'string' },
      url: { pattern: '^https?://', type: 'string' },
    },
    required: ['id', 'session', 'title'],
    'x-softschema': { contract: 'paraverse.conference:Recording/v1' },
  }
  const sessions = store.read(
    (db) =>
      db.prepare("SELECT id, label FROM entity WHERE kind = 'session' ORDER BY id").all() as {
        id: string
        label: string
      }[],
  )
  generic.new_kind = {
    records: sessions.length,
    ...envelope(store, dir, (db) => {
      const loader = new GenericLoader(db)
      loader.add({
        t: 'schema',
        kind: 'recording',
        file: '_schemas/recording.schema.yaml',
        schema: JSON.stringify(recordingSchema),
      })
      for (const s of sessions) {
        const rest = s.id.slice('session:'.length)
        const id = `recording:${rest}`
        const path = `recordings/${rest}.yaml`
        const payload = { id, session: s.id, title: s.label, url: `https://example.org/v/${rest}` }
        const softschema = {
          contract: 'paraverse.conference:Recording/v1',
          schema: '../_schemas/recording.schema.yaml',
          envelope: 'recording',
          status: 'enforced',
        }
        loader.add({
          t: 'doc',
          path,
          format: 'yaml',
          envelope: 'recording',
          owner: id,
          head: JSON.stringify({ softschema, recording: null }),
          body: null,
        })
        loader.add({
          t: 'entity',
          id,
          kind: 'recording',
          name: s.label,
          path,
          payload: JSON.stringify(payload),
        })
        loader.add({
          t: 'edge',
          source: id,
          relation: 'recording_of',
          target: s.id,
          ord: 0,
          props: null,
        })
      }
    }),
  }
  const sample = sessions[0]?.id ?? ''
  generic.new_kind_check = store.read((db) => {
    const q = new KbQueries(db)
    const rec = q.record(`recording:${sample.slice('session:'.length)}`) as { kind: string } | null
    const hood = q.neighborhood(sample, 200) as { nodes: { kind: string }[] }
    return {
      record_kind: rec?.kind ?? null,
      session_neighborhood_has_recording: hood.nodes.some((n) => n.kind === 'recording'),
    }
  })

  // 2. An optional field on an existing kind: `recording_url` on every tenth session.
  generic.optional_field = envelope(store, dir, (db) => {
    const row = db.prepare("SELECT schema FROM kind_schema WHERE kind = 'session'").get() as {
      schema: string
    }
    const schema = JSON.parse(row.schema) as { properties: JsonObject }
    schema.properties.recording_url = {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      default: null,
    }
    db.prepare("UPDATE kind_schema SET schema = ? WHERE kind = 'session'").run(
      JSON.stringify(schema),
    )
    db.prepare(
      `UPDATE entity SET payload = json_set(payload, '$.recording_url',
         'https://example.org/v/' || substr(id, 9))
       WHERE kind = 'session' AND (rowid % 10) = 0`,
    ).run()
  })

  // 3. Rename a relationship type: works_with becomes uses (part of the edge key).
  const renamed = store.read(
    (db) =>
      (
        db.prepare("SELECT count(*) AS n FROM edge WHERE relation = 'works_with'").get() as {
          n: number
        }
      ).n,
  )
  generic.rename_relation = {
    edges: renamed,
    ...envelope(store, dir, (db) => {
      db.prepare("UPDATE edge SET relation = 'uses' WHERE relation = 'works_with'").run()
    }),
  }

  // 4. Change a field's type: repository.primary_language from a string to {name}.
  const repos = store.read(
    (db) =>
      (
        db
          .prepare(
            "SELECT count(*) AS n FROM entity WHERE kind = 'repository' AND json_type(payload, '$.primary_language') = 'text'",
          )
          .get() as { n: number }
      ).n,
  )
  const typeChange: Record<string, unknown> = {
    records: repos,
    data: envelope(store, dir, (db) => {
      db.prepare(
        `UPDATE entity SET payload = json_set(payload, '$.primary_language',
           json_object('name', payload ->> '$.primary_language'))
         WHERE kind = 'repository' AND json_type(payload, '$.primary_language') = 'text'`,
      ).run()
    }),
  }
  // The repos_by_stars view filters on primary_language, so its index expression must
  // change too. That is DDL, which fsqlite refuses inside a write callback.
  const views = TABLE_VIEWS.map((v) =>
    v.name === 'repos_by_stars' ? { ...v, filter: "payload ->> '$.primary_language.name'" } : v,
  )
  const newDdl = genericDdl(views)
  typeChange.ddl_in_callback = attempt('CREATE INDEX inside SnapshotStore.write', () =>
    store.write('w4', (db) => {
      db.exec(
        "CREATE INDEX ix_lang_name ON entity ((payload ->> '$.primary_language.name')) WHERE kind = 'repository'",
      )
    }),
  )
  typeChange.open_with_new_ddl = attempt('open the store with the new DDL', () =>
    new SnapshotStore(dir, {
      schema: newDdl,
      schemaVersion: GENERIC_SCHEMA_VERSION + 1,
      conflictPolicy: GENERIC_POLICY,
    }).init(),
  )
  const migrated = migrateSnapshot(head(), join(work, 'w4', 'store-v2'), {
    schema: newDdl,
    schemaVersion: GENERIC_SCHEMA_VERSION + 1,
  })
  const check = openReader(String(migrated.snapshot))
  const planUsesIndex = (
    check
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM entity WHERE kind = 'repository'
         AND payload ->> '$.primary_language.name' = 'Python'
         ORDER BY payload ->> '$.stars' DESC, id LIMIT 50`,
      )
      .all() as { detail: string }[]
  ).map((r) => r.detail)
  check.close()
  typeChange.side_by_side = {
    ...migrated,
    plan: planUsesIndex,
    store_bytes: dirBytes(String(migrated.dest)),
  }
  rmSync(String(migrated.dest), { recursive: true, force: true })
  generic.type_change = typeChange

  // Mapping (b): typed tables. Build one from the evolved generic head, then measure the
  // side-by-side rebuild each DDL change needs (here: one added column).
  const schemas = readKindSchemas(head())
  const typedDir = join(work, 'w4', 'typed')
  const typedBuild = buildTyped(head(), typedDir, typedDdl(schemas), schemas)
  const typedV1 = new DirectStore(typedDir, { schema: typedDdl(schemas), schemaVersion: 1 }).init()
  const alter = attempt('ALTER TABLE ADD COLUMN inside DirectStore.write', () =>
    typedV1.write((db) => db.exec('ALTER TABLE t_session ADD COLUMN slides_url TEXT')),
  )
  const addColumn = migrateSnapshot(String(typedBuild.snapshot), join(work, 'w4', 'typed-v2'), {
    schema: typedDdl(schemas, { session: [{ name: 'slides_url', type: 'TEXT', json: false }] }),
    schemaVersion: 2,
  })
  const typedSizes = sizeBreakdown(String(typedBuild.snapshot))
  const genericSizes = sizeBreakdown(head())
  const sum = (sizes: Record<string, number>, names: (n: string) => boolean): number =>
    Object.entries(sizes).reduce((n, [k, v]) => (names(k) ? n + v : n), 0)
  const typed = {
    build_from_generic: { ...typedBuild, snapshot_bytes: statSync(String(typedBuild.snapshot)).size },
    alter_in_callback: alter,
    add_column_side_by_side: {
      ...addColumn,
      snapshot_bytes: statSync(String(addColumn.snapshot)).size,
    },
    // Like for like: records and edges with their indexes. The generic store also holds
    // the documents, Markdown bodies, search text and opaque files that export needs.
    size_comparison: {
      typed_records_and_edges_bytes: sum(typedSizes, (k) => k.startsWith('t_') || k.includes('edge') || k.includes('_t_')),
      generic_entity_and_edges_bytes: sum(genericSizes, (k) => k.includes('entity') || k.includes('edge') || k.includes('ix_view')),
      generic_total_bytes: statSync(head()).size,
    },
  }


  const result = {
    workflow: 'W4',
    generic_head_bytes: statSync(head()).size,
    generic,
    typed,
    requirements: {
      generic: {
        new_kind: 'data only (no DDL); a new table view for it needs an index, so a new epoch',
        optional_field: 'data only; an index on the field needs a new epoch',
        rename_relation: 'data only (an UPDATE of the edge key), plus query code that names it',
        type_change:
          'data only for the payload; any view or index over the field needs a new epoch',
      },
      typed: {
        new_kind: 'new table, so a new epoch (side-by-side copy)',
        optional_field: 'ALTER TABLE ADD COLUMN, so a new epoch',
        rename_relation: 'data only while edges stay generic',
        type_change: 'column type and transform, so a new epoch',
      },
    },
  }
  console.log(writeResult(scale, 'w4', result))
  if (!flags.keep) {
    rmSync(join(work, 'w4'), { recursive: true, force: true })
  }
}

if (isMain(import.meta.url)) {
  main()
}
