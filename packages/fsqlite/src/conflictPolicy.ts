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
//     NOTFOUND/CONSTRAINT/FOREIGN_KEY is SQLITE_MISUSE and throws. Every nonreplaceable
//     conflict aborts.
//
// Apply executes ordinary statements on the target, so foreign-key actions and triggers
// there would fire again on rows the changeset already changed. Apply therefore runs with
// foreign-key enforcement off, and one explicit `foreign_key_check` after the last pass
// closes the envelope, so a parent may still land in a later pass than its child.
// node:sqlite cannot disable triggers, so SnapshotStore rejects trigger schemas instead.

import type { DatabaseSync } from 'node:sqlite'
import { constants, foreignKeyCheck, OWNED_TABLES, rollbackQuietly } from './driver.ts'
import { FsqliteError, PermanentConflictError, StrictConflictError } from './errors.ts'
import type { ConflictPolicyInput, NormalizedPolicy } from './types.ts'

/**
 * `@types/node` 22 omits `SQLITE_CHANGESET_CONSTRAINT`, which node:sqlite exports on every
 * supported line; this widening covers only that one name.
 */
const constraintConstant = (
  constants as typeof constants & { SQLITE_CHANGESET_CONSTRAINT?: number }
).SQLITE_CHANGESET_CONSTRAINT

function requiredConstant(name: string, value: number | undefined): number {
  if (value === undefined) {
    throw new FsqliteError('incompatible', `node:sqlite is missing required constant ${name}`)
  }
  return value
}

const CHANGESET_DATA = constants.SQLITE_CHANGESET_DATA
const CHANGESET_NOTFOUND = constants.SQLITE_CHANGESET_NOTFOUND
const CHANGESET_CONFLICT = constants.SQLITE_CHANGESET_CONFLICT
const CHANGESET_CONSTRAINT = requiredConstant('SQLITE_CHANGESET_CONSTRAINT', constraintConstant)
const CHANGESET_FOREIGN_KEY = constants.SQLITE_CHANGESET_FOREIGN_KEY
const CHANGESET_REPLACE = constants.SQLITE_CHANGESET_REPLACE
const CHANGESET_OMIT = constants.SQLITE_CHANGESET_OMIT
const CHANGESET_ABORT = constants.SQLITE_CHANGESET_ABORT

const replaceable = (type: number): boolean =>
  type === CHANGESET_DATA || type === CHANGESET_CONFLICT

const FSQLITE_OWNED_TABLES: ReadonlySet<string> = new Set(OWNED_TABLES)

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

type Action = (typeof ACTIONS)[number]

/**
 * Every accepted action spelling. A Map, so an Object.prototype member name such as
 * `constructor` or `toString` is never mistaken for an action.
 */
const ACTION_SPELLINGS: ReadonlyMap<string, Action> = new Map([
  ['lww', 'replace'],
  ['union', 'omit'],
  ['replace', 'replace'],
  ['omit', 'omit'],
  ['strict', 'strict'],
])

/**
 * A policy maps each table name to an action, with `'*'` as the default.
 * Aliases: 'lww' = 'replace' (last-writer-wins), 'union' = 'omit' (set-union /
 * first-writer-wins).
 *
 *   { url_index: 'lww', relationships: 'union', '*': 'strict' }
 *
 * The result has a null prototype, so a table named like an Object.prototype member
 * (`constructor`, `__proto__`) is an ordinary key, never an inherited value.
 */
export function normalize(policy: ConflictPolicyInput = {}): NormalizedPolicy {
  const out = Object.create(null) as NormalizedPolicy
  for (const [table, value] of Object.entries(policy as Record<string, unknown>)) {
    const action = typeof value === 'string' ? ACTION_SPELLINGS.get(value) : undefined
    if (action === undefined) {
      throw new TypeError(`unknown conflict action '${String(value)}' for table '${table}'`)
    }
    out[table] = action
  }
  if (!Object.hasOwn(out, '*')) {
    out['*'] = 'strict' // deny-by-default: never silently pick a winner
  }
  return Object.freeze(out)
}

const ownAction = (policy: NormalizedPolicy, key: string): Action | undefined =>
  Object.hasOwn(policy, key) ? policy[key] : undefined

/**
 * The action for `table`: its own entry, else the policy's own `'*'`, else `strict`. Only
 * own keys count, so a plain-object policy cannot route `constructor` or `toString` to an
 * inherited Object.prototype member.
 */
export function actionFor(policy: NormalizedPolicy, table: string): Action {
  return ownAction(policy, table) ?? ownAction(policy, '*') ?? 'strict'
}

function conflictResult(
  action: Action,
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
 *
 * Foreign-key enforcement is off for the transaction, so the changeset's recorded
 * foreign-key action effects land exactly once; `foreign_key_check` then runs before
 * `beforeCommit`. A connection opened with enforcement on has it restored afterward.
 */
export function applyWithPolicy(
  db: DatabaseSync,
  changeset: Uint8Array,
  policy: NormalizedPolicy,
  beforeCommit: () => void = () => undefined,
): void {
  for (const [table, action] of Object.entries(policy as Record<string, unknown>)) {
    if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
      throw new TypeError(
        `policy maps table '${table}' to '${String(action)}', which is not one of ` +
          `${ACTIONS.join(', ')}; pass the policy through normalize()`,
      )
    }
  }
  // Every table routes to its own action or the fallback, so running a pass for each of
  // these applies every table. Without the fallback, a hand-built policy lacking '*' would
  // skip unlisted tables silently while the envelope is ledgered as applied.
  const used = new Set([...Object.values(policy), ownAction(policy, '*') ?? 'strict'])
  // SQLite ignores this pragma inside a transaction, so it is set before BEGIN.
  const enforced =
    (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys === 1
  if (enforced) {
    db.exec('PRAGMA foreign_keys = OFF')
  }
  try {
    applyInTransaction(db, changeset, policy, used, beforeCommit)
  } finally {
    if (enforced) {
      db.exec('PRAGMA foreign_keys = ON')
    }
  }
}

function applyInTransaction(
  db: DatabaseSync,
  changeset: Uint8Array,
  policy: NormalizedPolicy,
  used: ReadonlySet<Action>,
  beforeCommit: () => void,
): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const action of ACTIONS) {
      if (!used.has(action)) {
        continue
      }
      const ownedTables = new Set<string>()
      const filter = (table: string): boolean => {
        if (FSQLITE_OWNED_TABLES.has(table)) {
          ownedTables.add(table)
          return false
        }
        return actionFor(policy, table) === action
      }
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
          throw new PermanentConflictError(permanent.map(conflictName), { cause: error })
        }
        if (strict.length > 0) {
          throw new StrictConflictError(strict.map(conflictName), { cause: error })
        }
        throw error
      }
      if (ownedTables.size > 0) {
        throw new PermanentConflictError(
          [...ownedTables].sort().map((table) => `fsqlite-owned table ${table}`),
        )
      }
      // `ok === false` means the apply was aborted. Surface the recorded conflict types so
      // the caller can quarantine the envelope with an actionable reason.
      if (!ok) {
        if (permanent.length > 0) {
          throw new PermanentConflictError(permanent.map(conflictName))
        }
        if (strict.length > 0) {
          throw new StrictConflictError(strict.map(conflictName))
        }
        throw new PermanentConflictError([`unexpected-abort-on-${action}-pass`])
      }
    }
    foreignKeyCheck(db)
    beforeCommit()
    db.exec('COMMIT')
  } catch (e) {
    rollbackQuietly(db)
    throw e
  }
}
