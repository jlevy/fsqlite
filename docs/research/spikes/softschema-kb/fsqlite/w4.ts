// W4 schema evolution: what each change needs under the generic mapping (a) and the typed
// per-kind mapping (b), and how long it takes.
//
// Usage: node w4.ts --scale S0 [--verify] [--work <dir>]
//
// The inputs are the shared variants under kb-corpora/<scale>/evolve/<case>/kb (complete
// KB directories from corpus/evolve.py). Under mapping (a) each variant is applied to a
// clone of the W1 store as data: parse_kb.py --diff turns the changed files and the graph
// diff into rows, one SnapshotStore envelope carries them, and reconcile publishes. With
// --verify, a full rebuild of the variant must produce identical tables.
//
// DDL never happens in place: a write callback that runs DDL is refused and a handle with
// different DDL is incompatible, so index and typed-table changes are side-by-side copies
// into a new store (migrate.ts).

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DirectStore, FsqliteError, SnapshotStore } from './fsq.ts'
import {
  CORPORA_DIR,
  SPIKE_DIR,
  WORK_DIR,
  cloneStore,
  forEachRowSync,
  isMain,
  nowMs,
  parseArgs,
  round,
  writeResult,
} from './common.ts'
import { NODE, UV_PYTHON, measured, sizeBreakdown } from './w1.ts'
import {
  GENERIC_POLICY,
  GENERIC_SCHEMA_VERSION,
  GenericLoader,
  TABLE_VIEWS,
  genericDdl,
} from './mapping.ts'
import { migrateSnapshot } from './migrate.ts'
import { buildTyped, readKindSchemas, typedDdl } from './typed.ts'
import { genericStore, openReader } from './w3.ts'

const HERE = join(SPIKE_DIR, 'fsqlite')
const LOCK = { lockOpts: { timeoutMs: 600_001, staleMs: 600_000 } }
const CASES = ['new_kind', 'add_field', 'rename_relation', 'string_to_object'] as const
const OWNED = new Set(['applied_tx', 'fsqlite_meta'])

/** A digest of every caller table, rows in primary-key order, to compare two stores. */
export function tableDigests(snapshot: string): Record<string, string> {
  const db = new DatabaseSync(snapshot, { readOnly: true })
  try {
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    )
      .map((r) => r.name)
      .filter((n) => !OWNED.has(n))
      .sort()
    const out: Record<string, string> = {}
    for (const t of tables) {
      const pk = (db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string; pk: number }[])
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => `"${c.name}"`)
      const hash = createHash('sha256')
      let rows = 0
      for (const row of db.prepare(`SELECT * FROM "${t}" ORDER BY ${pk.join(', ')}`).iterate()) {
        hash.update(JSON.stringify(Object.values(row)))
        hash.update('\n')
        rows++
      }
      out[t] = `${rows}:${hash.digest('hex').slice(0, 16)}`
    }
    return out
  } finally {
    db.close()
  }
}

function attempt(label: string, fn: () => unknown): Record<string, string> {
  try {
    fn()
    return { attempt: label, outcome: 'accepted' }
  } catch (error) {
    const code = error instanceof FsqliteError ? error.code : 'error'
    return { attempt: label, outcome: `rejected (${code})`, message: (error as Error).message }
  }
}

/** Apply one variant to a clone of the base store as a single data-only envelope. */
function applyVariant(
  base: string,
  baseKb: string,
  variantKb: string,
  work: string,
  verify: boolean,
): Record<string, unknown> {
  const rows = join(work, 'diff.jsonl')
  const diff = measured('diff', [
    ...UV_PYTHON,
    join(HERE, 'parse_kb.py'),
    variantKb,
    rows,
    '--diff',
    baseKb,
  ])
  const dir = join(work, 'store')
  cloneStore(base, dir)
  const store = genericStore(dir).init()
  const t0 = nowMs()
  let counts: GenericLoader['counts'] | undefined
  const tx = store.write('w4', (db) => {
    const loader = new GenericLoader(db)
    forEachRowSync(rows, (row) => loader.add(row))
    counts = loader.counts
  })
  const captureMs = nowMs() - t0
  const envelopeBytes = tx
    ? statSync(join(dir, 'tx', 'pending', `${tx}.txn`, 'changeset.bin')).size
    : 0
  const t1 = nowMs()
  const reconciled = store.reconcile(LOCK)
  const reconcileMs = nowMs() - t1
  const head = store.snapshotPath(store.currentVersion())
  const result: Record<string, unknown> = {
    ddl: 'none',
    route: 'parse_kb.py --diff, one SnapshotStore envelope, reconcile',
    diff_seconds: diff.seconds,
    diff_rows: (diff.report as { counts: unknown } | null)?.counts,
    applied_rows: counts,
    capture_ms: round(captureMs),
    envelope_bytes: envelopeBytes,
    reconcile_ms: round(reconcileMs),
    reconcile: reconciled,
    data_change_total_seconds: round(Number(diff.seconds) + (captureMs + reconcileMs) / 1000),
  }
  if (verify) {
    // A full rebuild of the variant through W1 must give identical tables.
    const rebuildRows = join(work, 'rebuild.jsonl')
    const rebuildStore = join(work, 'rebuild')
    const parse = measured('parse', [
      ...UV_PYTHON,
      join(HERE, 'parse_kb.py'),
      variantKb,
      rebuildRows,
    ])
    const load = measured('load', [...NODE, join(HERE, 'load.ts'), rebuildRows, rebuildStore])
    const rebuilt = String((load.report as { snapshot: string }).snapshot)
    const a = tableDigests(head)
    const b = tableDigests(rebuilt)
    const differing = Object.keys({ ...a, ...b }).filter((t) => a[t] !== b[t])
    result.rebuild = {
      seconds: round(Number(parse.seconds) + Number(load.seconds)),
      parse_seconds: parse.seconds,
      load_seconds: load.seconds,
      tables_equal_to_incremental: differing.length === 0,
      differing_tables: differing,
    }
    rmSync(rebuildRows, { force: true })
    rmSync(rebuildStore, { recursive: true, force: true })
  }
  result.head = head
  return result
}

/** The string_to_object follow-up: the view index over the field must change (DDL). */
function indexChange(caseWork: string, head: string): Record<string, unknown> {
  const views = TABLE_VIEWS.map((v) =>
    v.name === 'repos_by_stars' ? { ...v, filter: "payload ->> '$.primary_language.name'" } : v,
  )
  const newDdl = genericDdl(views)
  const store = genericStore(join(caseWork, 'store'))
  const out: Record<string, unknown> = {
    ddl_in_callback: attempt('CREATE INDEX inside SnapshotStore.write', () =>
      store.write('w4', (db) => {
        db.exec(
          "CREATE INDEX ix_lang ON entity ((payload ->> '$.primary_language.name')) " +
            "WHERE kind = 'repository'",
        )
      }),
    ),
    open_with_new_ddl: attempt('open the store with the new DDL, same version', () =>
      new SnapshotStore(join(caseWork, 'store'), {
        schema: newDdl,
        schemaVersion: GENERIC_SCHEMA_VERSION,
        conflictPolicy: GENERIC_POLICY,
      }).init(),
    ),
  }
  const migrated = migrateSnapshot(head, join(caseWork, 'store-v2'), {
    schema: newDdl,
    schemaVersion: GENERIC_SCHEMA_VERSION + 1,
  })
  const check = openReader(String(migrated.snapshot))
  const plan = (
    check
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM entity WHERE kind = 'repository'
         AND payload ->> '$.primary_language.name' = 'Python'
         ORDER BY payload ->> '$.stars' DESC, id LIMIT 50`,
      )
      .all() as { detail: string }[]
  ).map((r) => r.detail)
  check.close()
  rmSync(join(caseWork, 'store-v2'), { recursive: true, force: true })
  out.side_by_side = { ...migrated, plan }
  return out
}

/** Mapping (b): typed tables from the base head, where any schema change is DDL. */
function typedMapping(base: string, work: string): Record<string, unknown> {
  const baseStore = genericStore(base).init()
  const baseHead = baseStore.snapshotPath(baseStore.currentVersion())
  const schemas = readKindSchemas(baseHead)
  const typedDir = join(work, 'typed')
  const build = buildTyped(baseHead, typedDir, typedDdl(schemas), schemas)
  const v1 = new DirectStore(typedDir, { schema: typedDdl(schemas), schemaVersion: 1 }).init()
  const alter = attempt('ALTER TABLE ADD COLUMN inside DirectStore.write', () =>
    v1.write((db) => db.exec('ALTER TABLE t_session ADD COLUMN recording_url TEXT')),
  )
  const addColumn = migrateSnapshot(String(build.snapshot), join(work, 'typed-v2'), {
    schema: typedDdl(schemas, { session: [{ name: 'recording_url', type: 'TEXT', json: false }] }),
    schemaVersion: 2,
  })
  const typedSizes = sizeBreakdown(String(build.snapshot))
  const genericSizes = sizeBreakdown(baseHead)
  const sum = (sizes: Record<string, number>, keep: (n: string) => boolean): number =>
    Object.entries(sizes).reduce((n, [k, v]) => (keep(k) ? n + v : n), 0)
  return {
    build_from_generic: { ...build, snapshot_bytes: statSync(String(build.snapshot)).size },
    alter_in_callback: alter,
    add_column_side_by_side: {
      ...addColumn,
      snapshot_bytes: statSync(String(addColumn.snapshot)).size,
    },
    // Like for like: records and edges with their indexes. The generic store also holds
    // documents, Markdown bodies, search text and opaque files for export.
    size_comparison: {
      typed_records_and_edges_bytes: sum(
        typedSizes,
        (k) =>
          k.startsWith('t_') || k.includes('_t_') || k.includes('edge') || k.startsWith('ix_repo'),
      ),
      generic_entity_and_edges_bytes: sum(
        genericSizes,
        (k) => k.includes('entity') || k.includes('edge') || k.startsWith('ix_view'),
      ),
      generic_total_bytes: statSync(baseHead).size,
    },
  }
}

function main(): void {
  const { flags } = parseArgs(process.argv.slice(2))
  const scale = flags.scale ?? 'S0'
  const verify = flags.verify === 'true'
  const work = join(flags.work ?? WORK_DIR, scale, 'w4')
  const base = join(flags.work ?? WORK_DIR, scale, 'store-direct')
  const corpus = join(CORPORA_DIR, scale)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const generic: Record<string, unknown> = {}
  for (const name of CASES) {
    const variant = join(corpus, 'evolve', name, 'kb')
    if (!existsSync(variant)) {
      generic[name] = { skipped: `no variant at ${variant}` }
      continue
    }
    const caseWork = join(work, name)
    mkdirSync(caseWork, { recursive: true })
    const applied = applyVariant(base, join(corpus, 'kb'), variant, caseWork, verify)
    if (name === 'string_to_object') {
      applied.index_change = indexChange(caseWork, String(applied.head))
    }
    delete applied.head
    generic[name] = applied
    rmSync(caseWork, { recursive: true, force: true })
  }
  const typed = typedMapping(base, work)
  rmSync(work, { recursive: true, force: true })
  console.log(
    writeResult(scale, 'w4', {
      workflow: 'W4',
      inputs: join(corpus, 'evolve'),
      verified_against_rebuild: verify,
      generic,
      typed,
      requirements: {
        generic: {
          new_kind: 'data only; a table view for the new kind needs an index, so a new epoch',
          add_field: 'data only; an index on the field needs a new epoch',
          rename_relation: 'data only (delete and insert of edge keys); query code that names it',
          string_to_object: 'data only for payloads; the view index over it needs a new epoch',
        },
        typed: {
          new_kind: 'new table: new epoch (side-by-side copy)',
          add_field: 'ALTER TABLE ADD COLUMN: new epoch',
          rename_relation: 'data only while edges stay generic',
          string_to_object: 'column type and transform: new epoch',
        },
      },
    }),
  )
}

if (isMain(import.meta.url)) {
  main()
}
