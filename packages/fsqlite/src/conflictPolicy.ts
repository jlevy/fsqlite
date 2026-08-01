// conflictPolicy.ts: pluggable per-table merge semantics.
//
// fsqlite realizes a per-table merge policy on top of node:sqlite's changeset apply. Four
// properties of the binding shape how the mapping is implemented (upstream-source-
// confirmations.md pins each to the SQLite and node:sqlite source):
//
//   - The `onConflict` handler receives only an integer conflict type, not the table name.
//     The C `xConflict(pCtx, eConflict, pIter)` has the iterator `pIter` (from which
//     `sqlite3changeset_op` yields the table), but the binding passes only `eConflict` to
//     JS, so policy cannot be routed by table from the conflict handler.
//   - The `applyChangeset` `filter(tableName)` callback does receive the table name. It is
//     the only place the table is exposed at apply time, so per-table policy is realized as
//     one filtered apply pass per distinct action.
//   - `SQLITE_CHANGESET_ABORT` rolls back the whole apply; node maps that to a `false`
//     return value from `applyChangeset`, not a throw, so a strict conflict is detected by
//     `=== false`.
//   - `REPLACE` is legal only for DATA and CONFLICT conflicts; returning it for
//     NOTFOUND/CONSTRAINT/FOREIGN_KEY is SQLITE_MISUSE and throws. So last-writer-wins must
//     be conflict-type-aware: REPLACE on DATA/CONFLICT, OMIT otherwise.


import type { DatabaseSync } from 'node:sqlite'
import { constants } from './driver.ts'
import type { ConflictAction, ConflictPolicyInput, NormalizedPolicy } from './types.ts'

const C = constants as unknown as Record<string, number>

const replaceable = (type: number): boolean =>
  type === C.SQLITE_CHANGESET_DATA || type === C.SQLITE_CHANGESET_CONFLICT

/** Action vocabulary (the only values node:sqlite actually honors as returns). */
export const ACTIONS = ['replace', 'omit', 'strict'] as const

const NAME: Record<number, string> = Object.fromEntries(
  ['DATA', 'NOTFOUND', 'CONFLICT', 'CONSTRAINT', 'FOREIGN_KEY'].map((n) => [
    C[`SQLITE_CHANGESET_${n}`],
    n,
  ]),
)
export const conflictName = (t: number): string => NAME[t] ?? `UNKNOWN(${t})`

export class StrictConflictError extends Error {
  constructor(types: (number | string)[]) {
    super(`strict conflict (${types.map((t) => (typeof t === 'number' ? conflictName(t) : t)).join(',')})`)
    this.name = 'StrictConflictError'
  }
}

/**
 * A policy maps table name → action, with `'*'` the default for unlisted tables.
 * Aliases: 'lww' = 'replace' (last-writer-wins), 'union' = 'omit' (set-union /
 * first-writer-wins).
 *
 *   { url_index: 'lww', relationships: 'union', '*': 'strict' }
 */
export function normalize(policy: ConflictPolicyInput = {}): NormalizedPolicy {
  const alias: Record<ConflictAction, 'replace' | 'omit' | 'strict'> = {
    lww: 'replace',
    union: 'omit',
    replace: 'replace',
    omit: 'omit',
    strict: 'strict',
  }
  const out: NormalizedPolicy = {}
  for (const [k, v] of Object.entries(policy)) {
    const a = alias[v]
    if (!a) throw new Error(`unknown conflict action '${v}' for table '${k}'`)
    out[k] = a
  }
  if (!out['*']) out['*'] = 'strict' // deny-by-default: never silently pick a winner
  return out
}

export function actionFor(policy: NormalizedPolicy, table: string): 'replace' | 'omit' | 'strict' {
  return policy[table] ?? policy['*']
}

// Conflict-type-aware handler returns. REPLACE only where SQLite permits it
// (DATA/CONFLICT); OMIT elsewhere; ABORT for strict (detected via the false return).
const HANDLER_RETURN: Record<'replace' | 'omit' | 'strict', (type: number) => number> = {
  replace: (type) => (replaceable(type) ? C.SQLITE_CHANGESET_REPLACE : C.SQLITE_CHANGESET_OMIT),
  omit: () => C.SQLITE_CHANGESET_OMIT,
  strict: () => C.SQLITE_CHANGESET_ABORT,
}

/**
 * Apply `changeset` to `db` honoring a normalized per-table `policy`, in ONE IMMEDIATE
 * transaction. Per-table policy is realized as one filtered apply pass per distinct
 * action (node:sqlite exposes the table name only via `filter`, not to the conflict
 * handler). A 'strict' table conflict makes its pass return `false` (ABORT rolls that
 * pass back); we then roll back the WHOLE tx and raise StrictConflictError so the caller
 * quarantines the envelope (atomic, since all passes share one tx).
 */
export function applyWithPolicy(db: DatabaseSync, changeset: Uint8Array, policy: NormalizedPolicy): void {
  const used = new Set(Object.values(policy))
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const action of used) {
      const filter = (table: string): boolean => actionFor(policy, table) === action
      const ok = db.applyChangeset(changeset, { filter, onConflict: HANDLER_RETURN[action] })
      // `ok === false` means the apply was aborted. For a 'strict' pass that is the expected
      // signal of a same-row conflict. For 'replace'/'omit' the handler never returns ABORT,
      // so a `false` here is an unexpected internal abort: surface it (don't silently drop
      // the pass) so the envelope is quarantined rather than lost.
      if (ok === false) {
        throw new StrictConflictError([action === 'strict' ? 'aborted-by-strict-table-conflict' : `unexpected-abort-on-${action}-pass`])
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw e
  }
}
