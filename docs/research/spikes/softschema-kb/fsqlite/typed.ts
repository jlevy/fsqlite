// Mapping (b): typed per-kind tables generated from the compiled softschema schemas.
//
// Each kind with a compiled schema gets a table `t_<kind>` whose columns are the schema's
// top-level properties: strings become TEXT, integers INTEGER, numbers REAL, booleans
// INTEGER, and every structured or mixed value TEXT holding JSON. Kinds without their own
// schema (nested days and terms) fall back to `t_other (id, kind, payload)`. Edges stay in
// the generic `edge` table. The DDL now depends on the schemas, so any schema change is
// a DDL change, and in fsqlite a new store epoch.
//
// The typed store is built from a generic snapshot with the side-by-side copy, so W4 can
// compare it with mapping (a) on the same data.

import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue } from 'node:sqlite'
import { DirectStore } from './fsq.ts'
import { nowMs, round } from './common.ts'
import type { JsonObject } from './mapping.ts'
import { rmSync } from 'node:fs'

const IDENT = /^[a-z_][a-z0-9_]*$/

export interface TypedColumn {
  name: string
  type: 'TEXT' | 'INTEGER' | 'REAL'
  json: boolean
}

function columnType(spec: JsonObject): TypedColumn['type'] | 'JSON' {
  const options = Array.isArray(spec.anyOf)
    ? (spec.anyOf as JsonObject[]).filter((o) => o.type !== 'null')
    : [spec]
  const types = new Set(options.map((o) => (typeof o.$ref === 'string' ? 'object' : o.type)))
  if (types.size !== 1) {
    return 'JSON'
  }
  switch ([...types][0]) {
    case 'string':
      return 'TEXT'
    case 'integer':
    case 'boolean':
      return 'INTEGER'
    case 'number':
      return 'REAL'
    default:
      return 'JSON'
  }
}

/** Columns for one kind, `id` first, from its compiled schema's top-level properties. */
export function typedColumns(schema: JsonObject): TypedColumn[] {
  const props = (schema.properties ?? {}) as Record<string, JsonObject>
  return Object.keys(props)
    .filter((name) => IDENT.test(name))
    .sort((a, b) => (a === 'id' ? -1 : b === 'id' ? 1 : a < b ? -1 : a > b ? 1 : 0))
    .map((name) => {
      const t = columnType(props[name] ?? {})
      return { name, type: t === 'JSON' ? 'TEXT' : t, json: t === 'JSON' }
    })
}

/** The typed DDL for a set of kind schemas. `extra` adds columns, as a schema change would. */
export function typedDdl(
  schemas: Record<string, JsonObject>,
  extra: Record<string, TypedColumn[]> = {},
): string {
  const tables = Object.keys(schemas)
    .sort()
    .map((kind) => {
      const cols = [...typedColumns(schemas[kind] ?? {}), ...(extra[kind] ?? [])]
      const defs = cols.map((c) =>
        c.name === 'id' ? '  id TEXT PRIMARY KEY NOT NULL' : `  "${c.name}" ${c.type}`,
      )
      if (!cols.some((c) => c.name === 'id')) {
        defs.unshift('  id TEXT PRIMARY KEY NOT NULL')
      }
      return `CREATE TABLE t_${kind} (\n${defs.join(',\n')}\n);`
    })
  return [
    ...tables,
    'CREATE TABLE t_other (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);',
    'CREATE INDEX ix_repo_lang_stars ON t_repository (primary_language, stars DESC, id);',
    `CREATE TABLE edge (
  source TEXT NOT NULL, relation TEXT NOT NULL, target TEXT NOT NULL, ord INTEGER NOT NULL,
  props TEXT, PRIMARY KEY (source, relation, target, ord)
) WITHOUT ROWID;`,
    'CREATE INDEX ix_edge_in ON edge (target, relation, source);',
  ].join('\n')
}

/** The kind schemas stored in a generic snapshot. */
export function readKindSchemas(snapshot: string): Record<string, JsonObject> {
  const db = new DatabaseSync(snapshot, { readOnly: true })
  try {
    const rows = db.prepare('SELECT kind, schema FROM kind_schema ORDER BY kind').all() as {
      kind: string
      schema: string
    }[]
    return Object.fromEntries(rows.map((r) => [r.kind, JSON.parse(r.schema) as JsonObject]))
  } finally {
    db.close()
  }
}

/** A payload value as a column value: structures as JSON text, booleans as 0 or 1. */
function cell(value: unknown): SQLInputValue {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0
  }
  return value as SQLInputValue
}

/**
 * Build a typed store from a generic snapshot: init with the typed DDL, then one
 * DirectStore.write that distributes every entity into its kind's table. `transform`
 * may rewrite a payload first, as a field type change would.
 */
export function buildTyped(
  genericSnapshot: string,
  dir: string,
  ddl: string,
  schemas: Record<string, JsonObject>,
  transform?: (kind: string, payload: JsonObject) => JsonObject,
): Record<string, unknown> {
  const t0 = nowMs()
  rmSync(dir, { recursive: true, force: true })
  const store = new DirectStore(dir, { schema: ddl, schemaVersion: 1 }).init()
  const src = new DatabaseSync(genericSnapshot, { readOnly: true })
  const rows: Record<string, number> = {}
  try {
    store.write(
      (db) => {
        db.exec('PRAGMA cache_size = -262144')
        const inserts = new Map<
          string,
          { sql: ReturnType<DatabaseSync['prepare']>; cols: string[] }
        >()
        const tableCols = (kind: string): string[] =>
          (db.prepare(`PRAGMA table_info(t_${kind})`).all() as { name: string }[]).map(
            (c) => c.name,
          )
        const other = db.prepare('INSERT INTO t_other (id, kind, payload) VALUES (?, ?, ?)')
        for (const e of src.prepare('SELECT id, kind, payload FROM entity').iterate()) {
          const { id, kind } = e as { id: string; kind: string }
          let payload = JSON.parse(String(e.payload)) as JsonObject
          if (transform) {
            payload = transform(kind, payload)
          }
          if (!schemas[kind]) {
            other.run(id, kind, JSON.stringify(payload))
            rows.t_other = (rows.t_other ?? 0) + 1
            continue
          }
          let ins = inserts.get(kind)
          if (!ins) {
            const cols = tableCols(kind)
            const sql = db.prepare(
              `INSERT INTO t_${kind} (${cols.map((c) => `"${c}"`).join(', ')}) ` +
                `VALUES (${cols.map(() => '?').join(', ')})`,
            )
            ins = { sql, cols }
            inserts.set(kind, ins)
          }
          ins.sql.run(...ins.cols.map((c) => (c === 'id' ? id : cell(payload[c]))))
          rows[`t_${kind}`] = (rows[`t_${kind}`] ?? 0) + 1
        }
        const edge = db.prepare(
          'INSERT INTO edge (source, relation, target, ord, props) VALUES (?, ?, ?, ?, ?)',
        )
        for (const g of src
          .prepare('SELECT source, relation, target, ord, props FROM edge')
          .iterate()) {
          edge.run(g.source, g.relation, g.target, g.ord, g.props)
        }
      },
      { lockOpts: { timeoutMs: 600_001, staleMs: 600_000 } },
    )
  } finally {
    src.close()
  }
  return {
    dir,
    rows,
    total_ms: round(nowMs() - t0),
    snapshot: store.snapshotPath(store.currentVersion()),
  }
}
