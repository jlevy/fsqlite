// W3 UI queries over the generic mapping, implementing harness/queries.json exactly.
//
// Each query is plain SQL against one read-only connection to a published snapshot:
// table pages are ordered range scans of the view's partial expression index, records
// and facets use the edge indexes, neighborhoods and the SQL-only path are recursive
// CTEs, and the default path query is a bidirectional breadth-first search that issues
// one SQL statement per frontier. Search scans `search_text`, or an FTS5 trigram sidecar
// (a rebuildable projection outside the store) when one is attached as `fts`.

import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { HUB_KINDS, TABLE_VIEWS, compareCodePoints } from './mapping.ts'
import type { Json, JsonObject } from './mapping.ts'

export type Params = Record<string, string | number>

const HUBS_SQL = `(${HUB_KINDS.map((k) => `'${k}'`).join(', ')})`

/** Python's `json.dumps(value, sort_keys=True, ensure_ascii=False)`, for tie-break order. */
export function pythonJson(value: Json): string {
  if (Array.isArray(value)) {
    return `[${value.map(pythonJson).join(', ')}]`
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort(compareCodePoints)
    return `{${keys.map((k) => `${JSON.stringify(k)}: ${pythonJson(value[k] ?? null)}`).join(', ')}}`
  }
  if (value === true || value === false) {
    return String(value)
  }
  return JSON.stringify(value)
}

/** Edge attributes: every prop except null values (queries.json `graph`). */
function attrsOf(props: string | null): JsonObject {
  const out: JsonObject = {}
  if (props === null) {
    return out
  }
  for (const [k, v] of Object.entries(JSON.parse(props) as JsonObject)) {
    if (v !== null) {
      out[k] = v
    }
  }
  return out
}

interface EdgeItem {
  id: string
  kind: string
  attrs: JsonObject
}

function groupEdges(
  rows: { relation: string; other: string; kind: string; props: string | null }[],
) {
  const groups = new Map<string, { item: EdgeItem; key: string }[]>()
  for (const r of rows) {
    const item = { id: r.other, kind: r.kind, attrs: attrsOf(r.props) }
    const list = groups.get(r.relation) ?? []
    list.push({ item, key: pythonJson(item.attrs) })
    groups.set(r.relation, list)
  }
  const out: Record<string, EdgeItem[]> = {}
  for (const relation of [...groups.keys()].sort(compareCodePoints)) {
    out[relation] = (groups.get(relation) ?? [])
      .sort((x, y) => compareCodePoints(x.item.id, y.item.id) || compareCodePoints(x.key, y.key))
      .map((x) => x.item)
  }
  return out
}

export interface QueryOptions {
  /** Search through an attached FTS5 trigram sidecar instead of scanning `search_text`. */
  fts?: boolean
  /** Use the recursive-CTE path query instead of bidirectional BFS. */
  pathCte?: boolean
}

export class KbQueries {
  private readonly db: DatabaseSync
  private readonly opts: QueryOptions
  private readonly cache = new Map<string, StatementSync>()
  /** When set, every SQL text a query runs is recorded here, for EXPLAIN QUERY PLAN. */
  trace: Set<string> | null = null

  constructor(db: DatabaseSync, opts: QueryOptions = {}) {
    this.db = db
    this.opts = opts
  }

  private stmt(sql: string): StatementSync {
    this.trace?.add(sql)
    let s = this.cache.get(sql)
    if (!s) {
      s = this.db.prepare(sql)
      this.cache.set(sql, s)
    }
    return s
  }

  /** `EXPLAIN QUERY PLAN` for each traced statement, with its parameters unbound. */
  plans(sqls: Iterable<string>): { sql: string; plan: string[] }[] {
    return [...sqls].map((sql) => ({
      sql: sql.replace(/\s+/g, ' ').trim(),
      plan: (this.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map(
        (r) => r.detail,
      ),
    }))
  }

  run(category: string, p: Params): unknown {
    switch (category) {
      case 'table':
        return this.table(p)
      case 'record':
        return this.record(String(p.id))
      case 'search':
        return this.search(String(p.term), Number(p.limit))
      case 'path':
        return this.opts.pathCte
          ? this.pathCte(String(p.a), String(p.b), Number(p.max_hops))
          : this.path(String(p.a), String(p.b), Number(p.max_hops))
      case 'facet':
        return this.facet(String(p.relation), String(p.source_kind), Number(p.limit))
      case 'neighborhood':
        return this.neighborhood(String(p.id), Number(p.limit))
      default:
        throw new Error(`unknown query category ${category}`)
    }
  }

  table(p: Params): unknown {
    const limit = Number(p.limit)
    const offset = Number(p.offset)
    if (p.table === 'people_by_org') {
      // Drive from the organization's in-edges (CROSS JOIN fixes the join order), so the
      // cost follows the member count rather than the number of people in the KB.
      const members = `
        FROM (SELECT DISTINCT source FROM edge WHERE target = ? AND relation = 'affiliated_with') m
        CROSS JOIN entity e ON e.id = m.source
        WHERE e.kind = 'person'`
      const total = this.stmt(`SELECT count(*) AS n ${members}`).get(p.org) as { n: number }
      const rows = this.stmt(
        `SELECT e.id, e.label AS name, e.label AS value ${members}
         ORDER BY e.label, e.id LIMIT ? OFFSET ?`,
      ).all(p.org, limit, offset)
      return { total: total.n, rows }
    }
    const view = TABLE_VIEWS.find((v) => v.name === p.table)
    if (!view) {
      throw new Error(`unknown table ${String(p.table)}`)
    }
    const filterValue = view.name === 'sessions_by_start' ? 'false' : String(p.language)
    const where = `FROM entity WHERE kind = '${view.kind}' AND ${view.filter} = ?`
    const total = this.stmt(`SELECT count(*) AS n ${where}`).get(filterValue) as { n: number }
    const rows = this.stmt(
      `SELECT id, label AS name, ${view.value} AS value ${where}
       ORDER BY ${view.sort}${view.descending ? ' DESC' : ''}, id LIMIT ? OFFSET ?`,
    ).all(filterValue, limit, offset)
    return { total: total.n, rows }
  }

  record(id: string): unknown {
    const e = this.stmt('SELECT id, kind, label, path, payload FROM entity WHERE id = ?').get(
      id,
    ) as { id: string; kind: string; label: string; path: string; payload: string } | undefined
    if (!e) {
      return null
    }
    type EdgeRow = { relation: string; other: string; kind: string; props: string | null }
    const out = this.stmt(
      `SELECT g.relation, g.target AS other, t.kind, g.props
       FROM edge g JOIN entity t ON t.id = g.target WHERE g.source = ?`,
    ).all(id) as EdgeRow[]
    const inc = this.stmt(
      `SELECT g.relation, g.source AS other, s.kind, g.props
       FROM edge g JOIN entity s ON s.id = g.source WHERE g.target = ?`,
    ).all(id) as EdgeRow[]
    return {
      id: e.id,
      kind: e.kind,
      name: e.label,
      kb_path: e.path,
      payload: JSON.parse(e.payload) as Json,
      out: groupEdges(out),
      in: groupEdges(inc),
    }
  }

  search(term: string, limit: number): unknown {
    // A trigram index matches a quoted phrase as a substring, but only for 3+ characters;
    // shorter terms scan. (A LIKE with an ESCAPE clause would bypass the index.)
    const fts = this.opts.fts === true && [...term].length >= 3
    const hits = fts
      ? 'SELECT id, min(r) AS rank FROM fts.search_fts WHERE search_fts MATCH ? GROUP BY id'
      : 'SELECT id, min(rank) AS rank FROM search_text WHERE instr(text, ?) > 0 GROUP BY id'
    const pattern = fts ? `"${term.replace(/"/g, '""')}"` : term
    const rows = this.stmt(
      `WITH hits AS MATERIALIZED (${hits})
       SELECT h.id, e.kind, e.label AS name, h.rank, (SELECT count(*) FROM hits) AS total
       FROM hits h JOIN entity e ON e.id = h.id
       ORDER BY h.rank, h.id LIMIT ?`,
    ).all(pattern, limit) as {
      id: string
      kind: string
      name: string
      rank: number
      total: number
    }[]
    return {
      total: rows[0]?.total ?? 0,
      hits: rows.map(({ id, kind, name, rank }) => ({ id, kind, name, rank })),
    }
  }

  /** One step of breadth-first search: every neighbor of `ids`, with its hub flag. */
  private expand(ids: string[]): { u: string; v: string; hub: number }[] {
    return this.stmt(
      `WITH f(id) AS (SELECT value FROM json_each(?))
       SELECT g.source AS u, g.target AS v, t.kind IN ${HUBS_SQL} AS hub
       FROM f JOIN edge g ON g.source = f.id JOIN entity t ON t.id = g.target
       UNION ALL
       SELECT g.target, g.source, s.kind IN ${HUBS_SQL}
       FROM f JOIN edge g ON g.target = f.id JOIN entity s ON s.id = g.source`,
    ).all(JSON.stringify(ids)) as { u: string; v: string; hub: number }[]
  }

  /**
   * Shortest hub-free undirected path by bidirectional BFS: expand the smaller frontier a
   * full level at a time, and stop at the first level where the two searches meet on a
   * node that may be intermediate (a non-hub, or an endpoint).
   */
  path(a: string, b: string, maxHops: number): unknown {
    if (a === b) {
      return { hops: 0, path: [a] }
    }
    const side = (root: string) => ({
      root,
      dist: new Map([[root, 0]]),
      parent: new Map<string, string>(),
      frontier: [root],
      depth: 0,
    })
    const A = side(a)
    const B = side(b)
    const hub = new Map<string, boolean>([
      [a, false],
      [b, false],
    ])
    while (A.frontier.length > 0 && B.frontier.length > 0 && A.depth + B.depth < maxHops) {
      const [s, o] = A.frontier.length <= B.frontier.length ? [A, B] : [B, A]
      const expandable = s.frontier.filter((u) => u === s.root || !hub.get(u))
      const next: string[] = []
      let best: { v: string; total: number } | null = null
      for (const { u, v, hub: isHub } of this.expand(expandable)) {
        if (!hub.has(v)) {
          hub.set(v, isHub === 1)
        }
        if (s.dist.has(v)) {
          continue
        }
        s.dist.set(v, s.depth + 1)
        s.parent.set(v, u)
        next.push(v)
        const other = o.dist.get(v)
        const canMeet = v === a || v === b || !hub.get(v)
        if (other !== undefined && canMeet) {
          const total = s.depth + 1 + other
          if (!best || total < best.total) {
            best = { v, total }
          }
        }
      }
      s.frontier = next
      s.depth++
      if (best) {
        if (best.total > maxHops) {
          break
        }
        const chain = (x: typeof A, from: string): string[] => {
          const out = [from]
          for (let c = x.parent.get(from); c !== undefined; c = x.parent.get(c)) {
            out.push(c)
          }
          return out
        }
        const path = [...chain(A, best.v).reverse(), ...chain(B, best.v).slice(1)]
        return { hops: best.total, path }
      }
    }
    return { hops: null, path: [] }
  }

  /** The same path query as one recursive CTE, then a walk back from `b` for the path. */
  pathCte(a: string, b: string, maxHops: number): unknown {
    if (a === b) {
      return { hops: 0, path: [a] }
    }
    const rows = this.stmt(
      `WITH RECURSIVE walk(id, hop, hub) AS (
         SELECT ?1, 0, 0
         UNION
         SELECT g.target, w.hop + 1, t.kind IN ${HUBS_SQL}
         FROM walk w JOIN edge g ON g.source = w.id JOIN entity t ON t.id = g.target
         WHERE w.hop < ?2 AND w.hub = 0 AND w.id <> ?3
         UNION
         SELECT g.source, w.hop + 1, s.kind IN ${HUBS_SQL}
         FROM walk w JOIN edge g ON g.target = w.id JOIN entity s ON s.id = g.source
         WHERE w.hop < ?2 AND w.hub = 0 AND w.id <> ?3
       )
       SELECT id, min(hop) AS hop, max(hub) AS hub FROM walk GROUP BY id`,
    ).all(a, maxHops, b) as { id: string; hop: number; hub: number }[]
    const dist = new Map(rows.map((r) => [r.id, r]))
    const target = dist.get(b)
    if (!target) {
      return { hops: null, path: [] }
    }
    const path = [b]
    for (let cur = b, d = target.hop; d > 0; d--) {
      const prev = this.neighborsOf(cur)
        .filter((n) => {
          const r = dist.get(n)
          return r !== undefined && r.hop === d - 1 && (n === a || r.hub === 0)
        })
        .sort(compareCodePoints)[0]
      if (prev === undefined) {
        throw new Error(`no predecessor for ${cur} at hop ${d}`)
      }
      path.push(prev)
      cur = prev
    }
    return { hops: target.hop, path: path.reverse() }
  }

  private neighborsOf(id: string): string[] {
    return (
      this.stmt(
        'SELECT target AS n FROM edge WHERE source = ?1 UNION SELECT source FROM edge WHERE target = ?1',
      ).all(id) as { n: string }[]
    ).map((r) => r.n)
  }

  facet(relation: string, sourceKind: string, limit: number): unknown {
    const rows = this.stmt(
      `WITH groups AS MATERIALIZED (
         SELECT g.target AS id, count(DISTINCT g.source) AS n
         FROM edge g JOIN entity s ON s.id = g.source
         WHERE g.relation = ? AND s.kind = ?
         GROUP BY g.target
       )
       SELECT gr.id, e.label AS name, gr.n AS count, (SELECT count(*) FROM groups) AS total
       FROM groups gr JOIN entity e ON e.id = gr.id
       ORDER BY gr.n DESC, gr.id LIMIT ?`,
    ).all(relation, sourceKind, limit) as {
      id: string
      name: string
      count: number
      total: number
    }[]
    return {
      groups: rows[0]?.total ?? 0,
      top: rows.map(({ id, name, count }) => ({ id, name, count })),
    }
  }

  neighborhood(id: string, limit: number): unknown {
    const rows = this.stmt(
      `WITH RECURSIVE walk(id, hop, hub) AS (
         SELECT ?1, 0, 0
         UNION
         SELECT g.target, w.hop + 1, t.kind IN ${HUBS_SQL}
         FROM walk w JOIN edge g ON g.source = w.id JOIN entity t ON t.id = g.target
         WHERE w.hop < 2 AND w.hub = 0
         UNION
         SELECT g.source, w.hop + 1, s.kind IN ${HUBS_SQL}
         FROM walk w JOIN edge g ON g.target = w.id JOIN entity s ON s.id = g.source
         WHERE w.hop < 2 AND w.hub = 0
       ),
       near AS MATERIALIZED (SELECT id, min(hop) AS hop FROM walk WHERE id <> ?1 GROUP BY id)
       SELECT n.id, e.kind, n.hop,
         (SELECT count(*) FROM near) AS total,
         (SELECT count(*) FROM near WHERE hop = 1) AS hop1
       FROM near n JOIN entity e ON e.id = n.id
       ORDER BY n.hop, n.id LIMIT ?2`,
    ).all(id, limit) as { id: string; kind: string; hop: number; total: number; hop1: number }[]
    return {
      total: rows[0]?.total ?? 0,
      hop1: rows[0]?.hop1 ?? 0,
      nodes: rows.map(({ id: nid, kind, hop }) => ({ id: nid, kind, hop })),
    }
  }
}
