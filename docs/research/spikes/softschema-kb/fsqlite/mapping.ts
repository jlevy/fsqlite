// The generic, schema-driven mapping from a softschema KB to fsqlite tables (mapping a).
//
// Every record lives in one `entity` table: the softschema payload stays JSON text exactly
// as parsed, `label` is the display name, and `derived` holds the few promoted fields the
// UI sorts and filters on. `search_text` holds the lowercased searchable strings, ranked.
// Graph relationships live in `edge`. The documents themselves (frontmatter keys, Markdown
// bodies, opaque files, compiled schemas) live in `doc`, `kb_file`, and `kind_schema`, so
// export can rebuild the KB byte for byte.
//
// The DDL is constant across corpora and kinds: a new kind or field needs no DDL, because
// both live in JSON. The UI's table views decide the expression indexes, so a new view
// changes the DDL and, in fsqlite, starts a new schema epoch (see W4 in README.md).
//
// Every table has a non-null primary key, and the schema declares no triggers, virtual
// tables, foreign keys, or ON CONFLICT clauses, so SnapshotStore and DirectStore both
// accept it and concurrent envelopes never quarantine on ordering.

import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type {
  DocRow,
  EdgeRow,
  EntityRow,
  FileRow,
  KbRow,
  LineRow,
  NodeRow,
  SchemaRow,
} from './common.ts'

/**
 * A UI table view: one kind, an equality filter, and a sort. Each view becomes one partial
 * expression index `(filter, sort, id) WHERE kind = '<kind>'`, so the page query is an
 * ordered index range scan and its total is an index-only count.
 */
export interface TableView {
  name: string
  kind: string
  filter: string
  sort: string
  descending: boolean
  value: string
}

export const TABLE_VIEWS: readonly TableView[] = [
  {
    name: 'sessions_by_start',
    kind: 'session',
    filter: "json_type(payload, '$.sponsored')",
    sort: "derived ->> '$.start_key'",
    descending: false,
    value: "derived ->> '$.start_epoch'",
  },
  {
    name: 'repos_by_stars',
    kind: 'repository',
    filter: "payload ->> '$.primary_language'",
    sort: "payload ->> '$.stars'",
    descending: true,
    value: "payload ->> '$.stars'",
  },
]

/** Kinds a path or neighborhood never passes through (queries.json `hubs`). */
export const HUB_KINDS = ['event', 'day', 'facet'] as const

function viewIndexDdl(views: readonly TableView[]): string {
  return views
    .map(
      (v) =>
        `CREATE INDEX ix_view_${v.name} ON entity ((${v.filter}), (${v.sort})` +
        `${v.descending ? ' DESC' : ''}, id) WHERE kind = '${v.kind}';`,
    )
    .join('\n')
}

/** The generic caller schema. Its exact text is part of the store's schema identity. */
export function genericDdl(views: readonly TableView[] = TABLE_VIEWS): string {
  return `
CREATE TABLE kind_schema (
  kind TEXT PRIMARY KEY NOT NULL,
  file TEXT NOT NULL,
  schema TEXT NOT NULL,
  fields TEXT NOT NULL
);
CREATE TABLE kb_file (
  path TEXT PRIMARY KEY NOT NULL,
  text TEXT NOT NULL
);
CREATE TABLE kb_line (
  path TEXT NOT NULL,
  n INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (path, n)
) WITHOUT ROWID;
CREATE TABLE doc (
  path TEXT PRIMARY KEY NOT NULL,
  format TEXT NOT NULL,
  envelope TEXT,
  owner TEXT,
  head TEXT NOT NULL,
  body TEXT
);
CREATE TABLE entity (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  label TEXT NOT NULL,
  path TEXT NOT NULL,
  payload TEXT NOT NULL,
  derived TEXT NOT NULL
);
CREATE INDEX ix_entity_kind_label ON entity (kind, label, id);
CREATE INDEX ix_entity_id_kind ON entity (id, kind);
CREATE INDEX ix_entity_path ON entity (path);
${viewIndexDdl(views)}
CREATE TABLE search_text (
  id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (id, rank)
) WITHOUT ROWID;
CREATE TABLE edge (
  source TEXT NOT NULL,
  relation TEXT NOT NULL,
  target TEXT NOT NULL,
  ord INTEGER NOT NULL,
  props TEXT,
  PRIMARY KEY (source, relation, target, ord)
) WITHOUT ROWID;
CREATE INDEX ix_edge_in ON edge (target, relation, source);
CREATE INDEX ix_edge_rel ON edge (relation, target, source);
`.trim()
}

export const GENERIC_SCHEMA_VERSION = 1

/** SnapshotStore merge policy: crawler and agent writes replace whole rows. */
export const GENERIC_POLICY = {
  entity: 'lww',
  edge: 'lww',
  doc: 'lww',
  kb_file: 'lww',
  kb_line: 'lww',
  kind_schema: 'lww',
  search_text: 'lww',
} as const

// Typed references, as paraverse's mapping recognizes them.
export const TYPED_REF =
  /^(event|day|session|person|profile|org|room|venue|experience|facet|term|gh|acct|site|repo|pkg|software):[a-z0-9][a-z0-9._/@+-]*$/
const REF_PATTERN = /^\^\(([a-z|]+)\):/

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }

const isObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// ---------------------------------------------------------------------------------------
// Schema description: the browser's per-kind field list, derived from the compiled schema.

interface FieldDescription {
  name: string
  title: string
  type: string
  list: boolean
  required: boolean
  ref_prefixes?: string[]
  def?: string
  enum?: Json[]
}

function valueOptions(spec: JsonObject): JsonObject[] {
  const any = spec.anyOf
  if (Array.isArray(any)) {
    return any.filter(isObject).flatMap(valueOptions)
  }
  return spec.type === 'null' ? [] : [spec]
}

function nonNull(spec: JsonObject): JsonObject {
  const options = valueOptions(spec)
  return options.length === 1 && options[0] ? options[0] : spec
}

function refPrefixes(spec: JsonObject): string[] {
  const options = valueOptions(spec)
  if (options.length > 1) {
    const all = options.map(refPrefixes)
    return all.every((p) => p.length > 0) ? [...new Set(all.flat())] : []
  }
  const match = REF_PATTERN.exec(String(options[0]?.pattern ?? spec.pattern ?? ''))
  return match?.[1] ? match[1].split('|') : []
}

/** Field descriptions in paraverse's order: `id`, then required, then the rest. */
export function describeFields(spec: JsonObject): FieldDescription[] {
  const props = isObject(spec.properties) ? spec.properties : {}
  const required = new Set(Array.isArray(spec.required) ? spec.required.map(String) : [])
  const rank = (name: string): string =>
    `${name === 'id' ? 0 : 1}${required.has(name) ? 0 : 1}${name}`
  const order = Object.keys(props).sort((a, b) => compareCodePoints(rank(a), rank(b)))
  return order.map((name) => {
    const raw = props[name]
    const fieldSpec = isObject(raw) ? raw : {}
    let core = nonNull(fieldSpec)
    let list = false
    if (core.type === 'array') {
      list = true
      core = nonNull(isObject(core.items) ? core.items : {})
    }
    const ref = typeof core.$ref === 'string' ? core.$ref.split('/').pop() : undefined
    const field: FieldDescription = {
      name,
      title: String(fieldSpec.title ?? core.title ?? name),
      type: ref ? 'object' : String(core.type ?? 'any'),
      list,
      required: required.has(name),
    }
    const prefixes = refPrefixes(core)
    if (prefixes.length > 0) {
      field.ref_prefixes = prefixes
    }
    if (ref) {
      field.def = ref
    }
    if (Array.isArray(core.enum)) {
      field.enum = core.enum
    }
    return field
  })
}

/** Order strings by Unicode code point, as SQLite BINARY collation and Python do. */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) {
    return 0
  }
  const ia = a[Symbol.iterator]()
  const ib = b[Symbol.iterator]()
  for (;;) {
    const x = ia.next()
    const y = ib.next()
    if (x.done || y.done) {
      return x.done ? (y.done ? 0 : -1) : 1
    }
    const cx = x.value.codePointAt(0) ?? 0
    const cy = y.value.codePointAt(0) ?? 0
    if (cx !== cy) {
      return cx - cy
    }
  }
}

// ---------------------------------------------------------------------------------------
// Derived fields: what paraverse promotes to flat FalkorDB properties for sorting and
// filtering. Payloads stay untouched; these live beside them.

/** A sort key past every real epoch, so ascending sorts put a missing value last. */
const NULLS_LAST = 2 ** 53 - 1

/**
 * Seconds since the epoch, reading a value with no UTC offset as UTC (paraverse's
 * `_epoch`), so results never depend on the machine's time zone. Null when unparsable.
 */
export function epoch(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null
  }
  const m =
    /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      value,
    )
  if (!m) {
    return null
  }
  const iso = `${m[1]}T${m[2] ?? '00:00:00'}${m[3] ?? 'Z'}`
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : Math.trunc(ms / 1000)
}

function byEpoch(a: string, b: string): number {
  const ea = epoch(a)
  const eb = epoch(b)
  if ((ea === null) !== (eb === null)) {
    return ea === null ? 1 : -1
  }
  if (ea !== eb) {
    return (ea ?? 0) - (eb ?? 0)
  }
  return compareCodePoints(a, b)
}

const objects = (v: Json | undefined): JsonObject[] => (Array.isArray(v) ? v.filter(isObject) : [])

/** Per-kind promoted fields, ported from paraverse's `_PROMOTERS`. */
const PROMOTERS: Record<string, (p: JsonObject) => JsonObject> = {
  session(p) {
    const slots = objects(p.slots)
    const times = (key: string): string[] =>
      slots
        .map((s) => s[key])
        .filter((s): s is string => typeof s === 'string' && s !== '')
        .sort(byEpoch)
    const starts = times('start')
    const ends = times('end')
    const startEpoch = starts[0] === undefined ? null : epoch(starts[0])
    return {
      start: starts[0] ?? null,
      end: ends.at(-1) ?? null,
      start_epoch: startEpoch,
      end_epoch: ends.length > 0 ? epoch(ends.at(-1)) : null,
      start_key: startEpoch ?? NULLS_LAST,
    }
  },
  event(p) {
    return { start_epoch: epoch(p.start), end_epoch: epoch(p.end) }
  },
  organization(p) {
    const sponsorship = isObject(p.sponsorship) ? p.sponsorship : {}
    return { sponsor_tier: typeof sponsorship.tier === 'string' ? sponsorship.tier : null }
  },
}

function compact(obj: JsonObject): JsonObject {
  const out: JsonObject = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null) {
      out[k] = v
    }
  }
  return out
}

/** A payload string as FalkorDB stores it: typed references become edges, not text. */
export function scalarString(value: Json | undefined): string | null {
  return typeof value === 'string' && !TYPED_REF.test(value) ? value : null
}

/**
 * The display name (paraverse's `readable_name`): the export's name, or, for a record
 * the export names by its ID or not at all, the export name of the first top-level typed
 * reference whose own name differs from its ID.
 */
export function displayName(
  row: EntityRow,
  payload: JsonObject,
  exportName: (id: string) => string | undefined,
): string {
  const own = row.name ?? row.id
  if (own !== row.id) {
    return own
  }
  for (const value of Object.values(payload)) {
    if (typeof value === 'string' && TYPED_REF.test(value)) {
      const name = exportName(value)
      if (name && name !== value) {
        return name
      }
    }
  }
  return own
}

export interface EntityValues {
  label: string
  derived: string
  search: (string | null)[]
}

/** Derived columns for one entity row. `exportName` resolves the names refs carry. */
export function entityValues(
  row: EntityRow,
  exportName: (id: string) => string | undefined,
): EntityValues {
  const payload = JSON.parse(row.payload) as JsonObject
  const label = displayName(row, payload, exportName)
  const promoted = PROMOTERS[row.kind]?.(payload) ?? {}
  return {
    label,
    derived: JSON.stringify(compact(promoted)),
    // Search ranks: 0 the display name, 1 payload.title, 2 payload.bio.
    search: [label, scalarString(payload.title), scalarString(payload.bio)],
  }
}

// ---------------------------------------------------------------------------------------
// Loading rows.

/**
 * Prepared statements that insert or upsert intermediate rows into the generic tables.
 * Upserts keep W2 batches idempotent. A `fresh` loader skips deleting search ranks that a
 * record lacks, since an empty store holds none.
 */
export class GenericLoader {
  readonly counts = { schema: 0, file: 0, line: 0, node: 0, doc: 0, entity: 0, edge: 0, update: 0 }
  private readonly names = new Map<string, string>()
  private readonly schema: StatementSync
  private readonly file: StatementSync
  private readonly line: StatementSync
  private readonly doc: StatementSync
  private readonly entity: StatementSync
  private readonly search: StatementSync
  private readonly dropSearch: StatementSync
  private readonly edge: StatementSync
  private readonly dropEdges: StatementSync
  private readonly nameOf: StatementSync
  private readonly stored: StatementSync

  private readonly fresh: boolean

  constructor(db: DatabaseSync, fresh = false) {
    this.fresh = fresh
    this.schema = db.prepare(
      `INSERT INTO kind_schema (kind, file, schema, fields) VALUES (?, ?, ?, ?)
       ON CONFLICT (kind) DO UPDATE SET file = excluded.file, schema = excluded.schema,
         fields = excluded.fields`,
    )
    this.file = db.prepare(
      `INSERT INTO kb_file (path, text) VALUES (?, ?)
       ON CONFLICT (path) DO UPDATE SET text = excluded.text`,
    )
    this.line = db.prepare(
      `INSERT INTO kb_line (path, n, text) VALUES (?, ?, ?)
       ON CONFLICT (path, n) DO UPDATE SET text = excluded.text`,
    )
    this.doc = db.prepare(
      `INSERT INTO doc (path, format, envelope, owner, head, body) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (path) DO UPDATE SET format = excluded.format, envelope = excluded.envelope,
         owner = excluded.owner, head = excluded.head, body = excluded.body`,
    )
    this.entity = db.prepare(
      `INSERT INTO entity (id, kind, name, label, path, payload, derived)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, name = excluded.name,
         label = excluded.label, path = excluded.path, payload = excluded.payload,
         derived = excluded.derived`,
    )
    this.search = db.prepare(
      `INSERT INTO search_text (id, rank, text) VALUES (?, ?, ?)
       ON CONFLICT (id, rank) DO UPDATE SET text = excluded.text`,
    )
    this.dropSearch = db.prepare('DELETE FROM search_text WHERE id = ? AND rank = ?')
    this.edge = db.prepare(
      `INSERT INTO edge (source, relation, target, ord, props) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (source, relation, target, ord) DO UPDATE SET props = excluded.props`,
    )
    this.dropEdges = db.prepare('DELETE FROM edge WHERE source = ?')
    this.nameOf = db.prepare('SELECT coalesce(name, id) AS name FROM entity WHERE id = ?')
    this.stored = db.prepare('SELECT kind, name, path FROM entity WHERE id = ?')
  }

  /** A referenced entity's export name: from this load when seen, else from the database. */
  private exportName = (id: string): string | undefined =>
    this.names.get(id) ?? (this.nameOf.get(id) as { name: string } | undefined)?.name

  add(row: KbRow): void {
    switch (row.t) {
      case 'schema':
        return this.addSchema(row)
      case 'file':
        return this.addFile(row)
      case 'line':
        return this.addLine(row)
      case 'node':
        return this.addNode(row)
      case 'doc':
        return this.addDoc(row)
      case 'entity':
        return this.addEntity(row)
      case 'edge':
        return this.addEdge(row)
    }
  }

  addSchema(row: SchemaRow): void {
    const fields = describeFields(JSON.parse(row.schema) as JsonObject)
    this.schema.run(row.kind, row.file, row.schema, JSON.stringify(fields))
    this.counts.schema++
  }

  addFile(row: FileRow): void {
    this.file.run(row.path, row.text)
    this.counts.file++
  }

  addLine(row: LineRow): void {
    this.line.run(row.path, row.n, row.text)
    this.counts.line++
  }

  /** Graph nodes arrive before entities, so display names can resolve any reference. */
  addNode(row: NodeRow): void {
    this.names.set(row.id, row.name ?? row.id)
    this.counts.node++
  }

  addDoc(row: DocRow): void {
    this.doc.run(row.path, row.format, row.envelope, row.owner, row.head, row.body)
    this.counts.doc++
  }

  addEntity(input: EntityRow): void {
    let row = input
    if (row.update) {
      // A changed record keeps the graph node the KB already has.
      const node = this.stored.get(row.id) as { kind: string; name: string | null; path: string }
      if (node) {
        row = { ...row, kind: node.kind, name: node.name, path: node.path }
      }
      this.counts.update++
    }
    const { label, derived, search } = entityValues(row, this.exportName)
    this.entity.run(row.id, row.kind, row.name, label, row.path, row.payload, derived)
    search.forEach((text, rank) => {
      if (text === null) {
        if (!this.fresh) {
          this.dropSearch.run(row.id, rank)
        }
      } else {
        this.search.run(row.id, rank, text.toLowerCase())
      }
    })
    this.counts.entity++
  }

  addEdge(row: EdgeRow): void {
    this.edge.run(row.source, row.relation, row.target, row.ord, row.props)
    this.counts.edge++
  }

  /** Remove an entity's outgoing edges before a batch re-adds its full edge set. */
  dropOutgoingEdges(source: string): void {
    this.dropEdges.run(source)
  }
}
