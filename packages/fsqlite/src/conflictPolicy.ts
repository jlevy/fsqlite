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
//     NOTFOUND/CONSTRAINT/FOREIGN_KEY is SQLITE_MISUSE and throws. Those nonreplaceable
//     conflicts abort and quarantine the envelope instead of silently dropping a change.

import type { DatabaseSync } from 'node:sqlite'
import { constants } from './driver.ts'
import type { ConflictAction, ConflictPolicyInput, NormalizedPolicy } from './types.ts'

const C = constants as unknown as Record<string, number>

function sqliteConstant(name: string): number {
  const value = C[name]
  if (value === undefined) {
    throw new Error(`node:sqlite is missing required constant ${name}`)
  }
  return value
}

const CHANGESET_DATA = sqliteConstant('SQLITE_CHANGESET_DATA')
const CHANGESET_NOTFOUND = sqliteConstant('SQLITE_CHANGESET_NOTFOUND')
const CHANGESET_CONFLICT = sqliteConstant('SQLITE_CHANGESET_CONFLICT')
const CHANGESET_CONSTRAINT = sqliteConstant('SQLITE_CHANGESET_CONSTRAINT')
const CHANGESET_FOREIGN_KEY = sqliteConstant('SQLITE_CHANGESET_FOREIGN_KEY')
const CHANGESET_REPLACE = sqliteConstant('SQLITE_CHANGESET_REPLACE')
const CHANGESET_OMIT = sqliteConstant('SQLITE_CHANGESET_OMIT')
const CHANGESET_ABORT = sqliteConstant('SQLITE_CHANGESET_ABORT')

const replaceable = (type: number): boolean =>
  type === CHANGESET_DATA || type === CHANGESET_CONFLICT

/** Action vocabulary and normative filtered-pass order. */
export const ACTIONS = Object.freeze(['replace', 'omit', 'strict'] as const)

const NAME: Record<number, string> = {
  [CHANGESET_DATA]: 'DATA',
  [CHANGESET_NOTFOUND]: 'NOTFOUND',
  [CHANGESET_CONFLICT]: 'CONFLICT',
  [CHANGESET_CONSTRAINT]: 'CONSTRAINT',
  [CHANGESET_FOREIGN_KEY]: 'FOREIGN_KEY',
}
export const conflictName = (t: number): string => NAME[t] ?? `UNKNOWN(${t})`

export class StrictConflictError extends Error {
  constructor(types: (number | string)[], options?: ErrorOptions) {
    super(
      `strict conflict (${types.map((t) => (typeof t === 'number' ? conflictName(t) : t)).join(',')})`,
      options,
    )
    this.name = 'StrictConflictError'
  }
}

export class PermanentConflictError extends Error {
  constructor(types: (number | string)[], options?: ErrorOptions) {
    super(
      `permanent conflict (${types.map((t) => (typeof t === 'number' ? conflictName(t) : t)).join(',')})`,
      options,
    )
    this.name = 'PermanentConflictError'
  }
}

/**
 * A policy maps each table name to an action, with `'*'` as the default.
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
  for (const [k, value] of Object.entries(policy as Record<string, unknown>)) {
    if (typeof value !== 'string' || !(value in alias)) {
      throw new Error(`unknown conflict action '${String(value)}' for table '${k}'`)
    }
    const a = alias[value as ConflictAction]
    out[k] = a
  }
  out['*'] ??= 'strict' // deny-by-default: never silently pick a winner
  return out
}

export function actionFor(policy: NormalizedPolicy, table: string): 'replace' | 'omit' | 'strict' {
  return policy[table] ?? policy['*'] ?? 'strict'
}

function conflictResult(
  action: 'replace' | 'omit' | 'strict',
  type: number,
  strict: number[],
  permanent: number[],
): number {
  if (!replaceable(type)) {
    permanent.push(type)
    return CHANGESET_ABORT
  }
  if (action === 'strict') {
    strict.push(type)
    return CHANGESET_ABORT
  }
  return action === 'replace' ? CHANGESET_REPLACE : CHANGESET_OMIT
}

/**
 * Apply `changeset` to `db` honoring a normalized per-table `policy`, in ONE IMMEDIATE
 * transaction. Per-table policy is realized as one filtered apply pass per distinct
 * action (node:sqlite exposes the table name only via `filter`, not to the conflict
 * handler). A 'strict' table conflict makes its pass return `false` (ABORT rolls that
 * pass back); we then roll back the WHOLE tx and raise a typed conflict error so the
 * caller quarantines the envelope atomically. Nonreplaceable conflict types are permanent,
 * even when their table policy would otherwise be retryable.
 */
export function applyWithPolicy(
  db: DatabaseSync,
  changeset: Uint8Array,
  policy: NormalizedPolicy,
  beforeCommit: () => void = () => undefined,
): void {
  const used = new Set(Object.values(policy))
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const action of ACTIONS) {
      if (!used.has(action)) {
        continue
      }
      const filter = (table: string): boolean => actionFor(policy, table) === action
      const strict: number[] = []
      const permanent: number[] = []
      let ok: boolean
      try {
        ok = db.applyChangeset(changeset, {
          filter,
          onConflict: (type) => conflictResult(action, type, strict, permanent),
        })
      } catch (error) {
        if (permanent.length > 0) {
          throw new PermanentConflictError(permanent, { cause: error })
        }
        if (strict.length > 0) {
          throw new StrictConflictError(strict, { cause: error })
        }
        throw error
      }
      // `ok === false` means the apply was aborted. Surface the recorded conflict types so
      // the caller can quarantine the envelope with an actionable reason.
      if (!ok) {
        if (permanent.length > 0) {
          throw new PermanentConflictError(permanent)
        }
        if (strict.length > 0) {
          throw new StrictConflictError(strict)
        }
        throw new PermanentConflictError([`unexpected-abort-on-${action}-pass`])
      }
    }
    beforeCommit()
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
