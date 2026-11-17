// C7 plan audit for the W3 table queries: does SQLite use each view's partial expression
// index for the ordered page on its own, or only when forced with INDEXED BY? Also keeps
// the earlier people_by_org form (an IN subquery) as the "before" of its rewrite.
//
// Usage: node plans.ts <store-dir> --scale S0
// Writes results/fsqlite/<scale>/w3-plans.json.

import { isMain, nowMs, parseArgs, percentile, round, writeResult } from './common.ts'
import { TABLE_VIEWS } from './mapping.ts'
import { genericStore, openReader, queryInstances } from './w3.ts'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

function probe(db: DatabaseSync, sql: string, params: SQLInputValue[]) {
  const stmt = db.prepare(sql)
  const first = JSON.stringify(stmt.all(...params))
  const times: number[] = []
  for (let i = 0; i < 50; i++) {
    const t = nowMs()
    stmt.all(...params)
    times.push(nowMs() - t)
  }
  times.sort((a, b) => a - b)
  return {
    sql: sql.replace(/\s+/g, ' ').trim(),
    plan: (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map(
      (r) => r.detail,
    ),
    p50_ms: round(percentile(times, 50), 4),
    result_hash: first.length,
    rows: first,
  }
}

function main(): void {
  const { flags, args } = parseArgs(process.argv.slice(2))
  const scale = flags.scale ?? 'S0'
  const store = genericStore(args[0] ?? '').init()
  const lease = store.readLease()
  const db = openReader(store.snapshotPath(lease.version))
  const out: Record<string, unknown> = {}
  for (const q of queryInstances(scale).filter((i) => i.category === 'table')) {
    const p = q.params
    if (p.offset === 'last') {
      continue // the audit covers fixed offsets; the last page shares their plans
    }
    if (p.table === 'people_by_org') {
      const page = 'ORDER BY e.label, e.id LIMIT ? OFFSET ?'
      const args: SQLInputValue[] = [String(p.org), Number(p.limit), Number(p.offset)]
      const after = probe(
        db,
        `SELECT e.id, e.label FROM (SELECT DISTINCT source FROM edge
           WHERE target = ? AND relation = 'affiliated_with') m
         CROSS JOIN entity e ON e.id = m.source WHERE e.kind = 'person' ${page}`,
        args,
      )
      const hinted = probe(
        db,
        `SELECT e.id, e.label FROM (SELECT DISTINCT source FROM edge
           WHERE target = ? AND relation = 'affiliated_with') m
         CROSS JOIN entity e ON e.id = m.source WHERE +e.kind = 'person' ${page}`,
        args,
      )
      const before = probe(
        db,
        `SELECT e.id, e.label FROM entity e WHERE e.kind = 'person' AND e.id IN
           (SELECT source FROM edge WHERE target = ? AND relation = 'affiliated_with') ${page}`,
        args,
      )
      out[q.name] = {
        in_subquery_original: before,
        cross_join_unhinted: after,
        cross_join_hinted_used_by_w3: hinted,
        same_rows: before.rows === after.rows && after.rows === hinted.rows,
      }
      continue
    }
    const v = TABLE_VIEWS.find((x) => x.name === p.table)
    if (!v) {
      continue
    }
    const filter = v.filter ? ` AND ${v.filter} = ?` : ''
    const sql = (hint: string): string =>
      `SELECT id, label, ${v.value} AS value FROM entity ${hint}
       WHERE kind = '${v.kind}'${filter}
       ORDER BY ${v.sort}${v.descending ? ' DESC' : ''}, id LIMIT ? OFFSET ?`
    const params: SQLInputValue[] = [
      ...(v.filter ? [v.name === 'sessions_by_start' ? 'false' : String(p.language)] : []),
      Number(p.limit),
      Number(p.offset),
    ]
    const planner = probe(db, sql(''), params)
    const forced = probe(db, sql(`INDEXED BY ix_view_${v.name}`), params)
    out[q.name] = {
      planner,
      indexed_by: forced,
      planner_uses_view_index: planner.plan.some((d) => d.includes(`ix_view_${v.name}`)),
      planner_sorts: planner.plan.some((d) => d.includes('TEMP B-TREE')),
      same_rows: planner.rows === forced.rows,
    }
  }
  db.close()
  lease.release()
  for (const entry of Object.values(out) as Record<string, Record<string, unknown>>[]) {
    for (const probeResult of Object.values(entry)) {
      if (typeof probeResult === 'object' && probeResult !== null) {
        delete (probeResult as Record<string, unknown>).rows
        delete (probeResult as Record<string, unknown>).result_hash
      }
    }
  }
  console.log(writeResult(scale, 'w3-plans', { workflow: 'W3 plan audit (C7)', queries: out }))
}

if (isMain(import.meta.url)) {
  main()
}
