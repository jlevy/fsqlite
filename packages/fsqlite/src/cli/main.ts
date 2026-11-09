// fsqlite CLI: operate a store from the shell with no server and no app code.
//
// The commands work on any fsqlite store without knowing the caller's schema or merge
// policy: they operate on snapshots, pointers, envelopes, and leases rather than table
// data. Reconcile remains a library call because folding envelopes needs the
// application's per-table merge policy. Run `fsqlite --help` for commands, options, and
// exit codes.
//
// This module has no import-time effects: `main(argv, io)` runs one invocation and
// returns its exit code. The `fsqlite` bin (bin.ts) wires it to the process.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { parseArgs } from 'node:util'
import type { ParseArgsOptionsConfig } from 'node:util'
import packageInfo from '../../package.json' with { type: 'json' }
import { DEFAULT_RETAINED_SNAPSHOTS, SnapshotStore } from '../snapshotStore.ts'
import { inspectFilesystem, formatInspectReport } from '../fsinspect.ts'
import { capabilities } from '../driver.ts'
import { errorMessage, FsqliteError } from '../errors.ts'
import type { FsqliteErrorCode } from '../errors.ts'
import { isSqliteFile, sqliteFacts, integrityReport } from '../sqliteFacts.ts'
import type { SqliteFacts } from '../sqliteFacts.ts'
import { hasStoreMarker } from '../storeFormat.ts'
import type { RepairResult, StoreValidationState, ValidateResult } from '../types.ts'

/** Where one CLI invocation writes its output, one line per call. */
export interface CliIo {
  out: (line: string) => void
  err: (line: string) => void
}

/** The process streams, for the bin. */
export const processIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
}

/**
 * The CLI's exit codes. A command that reports on a store (`info`, `validate`, `stats`,
 * `doctor`, `repair`) exits with the code of the state it reports; any command that fails
 * exits with the code of its error (see {@link exitCodeForError}).
 */
export const EXIT = Object.freeze({
  /** Success; a reported store is `sealed` or `live`. */
  ok: 0,
  /** The operation failed for any reason without a more specific code. */
  failure: 1,
  /** In flight: a capture, publication, or maintenance step is mid-flight. */
  inFlight: 2,
  /** The store is invalid (malformed marker) or corrupt. */
  invalidOrCorrupt: 3,
  /** The store needs a newer format version or feature. */
  unsupported: 4,
  /** `fsinspect`: the filesystem cannot host a store. */
  unsafeFilesystem: 5,
  /** A usage error, or the path is not an fsqlite store (sysexits EX_USAGE). */
  usage: 64,
})

/** The exit code for a store state (spec section 11). */
export function exitCodeForState(state: StoreValidationState): number {
  switch (state) {
    case 'sealed':
    case 'live':
      return EXIT.ok
    case 'in-flight-capture':
      return EXIT.inFlight
    case 'invalid':
    case 'corrupt':
      return EXIT.invalidOrCorrupt
    case 'unsupported':
      return EXIT.unsupported
    case 'not-a-store':
      return EXIT.usage
  }
}

/** The exit code for an error: recognition and health codes map like states. */
export function exitCodeForError(error: unknown): number {
  if (!(error instanceof FsqliteError)) {
    return EXIT.failure
  }
  const code: FsqliteErrorCode = error.code
  switch (code) {
    case 'not-a-store':
      return EXIT.usage
    case 'invalid':
    case 'corrupt':
      return EXIT.invalidOrCorrupt
    case 'unsupported':
      return EXIT.unsupported
    case 'in-flight':
      return EXIT.inFlight
    case 'conflict':
    case 'pending':
    case 'outcome-unknown':
    case 'retryable':
    case 'post-publish':
    case 'incompatible':
    case 'refused':
    case 'io':
      return EXIT.failure
  }
}

/** Causes printed below an error; a cycle or a deep chain stops here. */
const MAX_REPORTED_CAUSES = 8

/** A usage error: the message is printed with a pointer to help, and the CLI exits 64. */
class UsageError extends Error {
  readonly command: string | null

  constructor(message: string, command: string | null) {
    super(message)
    this.name = 'UsageError'
    this.command = command
  }
}

/** Parsed arguments of one command invocation. */
interface Invocation {
  io: CliIo
  /** The positional arguments, one per name in the command's `positionals`. */
  args: string[]
  values: Record<string, string | boolean | undefined>
  json: boolean
}

interface CommandSpec {
  summary: string
  /** Arguments as the usage line shows them, such as `<dir> [--retain N]`. */
  usage: string
  /** Positional argument names, in order; every one is required. */
  positionals: readonly string[]
  /** Command-specific options; every command also takes `--json` and `--help`. */
  options: ParseArgsOptionsConfig
  /** Help lines for the command-specific options. */
  optionHelp: readonly string[]
  /** Further help paragraphs. */
  notes: readonly string[]
  run: (inv: Invocation) => number
}

const COMMON_OPTIONS: ParseArgsOptionsConfig = {
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
}

/** Width of the arguments column in the global command list. */
const USAGE_COLUMN = 18

const COMMON_OPTION_HELP = [
  '--json        Print JSON instead of text',
  '-h, --help    Show this help',
]

const EXIT_CODE_HELP = [
  'Exit codes:',
  '  0   success; a reported store is sealed or live',
  '  1   the operation failed',
  '  2   in flight: a capture, publication, or maintenance step is mid-flight',
  '  3   the store is invalid or corrupt',
  '  4   the store needs a newer format version or feature',
  '  5   fsinspect: the filesystem cannot host a store',
  '  64  usage error, or the path is not an fsqlite store',
]

const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  info: {
    summary: "Show a store's state, head, snapshots, and pending tail",
    usage: '<dir>',
    positionals: ['dir'],
    options: {},
    optionHelp: [],
    notes: ['Exits with the code of the store state, as validate does.'],
    run: runInfo,
  },
  validate: {
    summary: "Classify a store's health; the exit code is the state's",
    usage: '<dir>',
    positionals: ['dir'],
    options: {},
    optionHelp: [],
    notes: [],
    run: runValidate,
  },
  stats: {
    summary: 'Facts about an fsqlite store or a plain SQLite file',
    usage: '<path>',
    positionals: ['path'],
    options: {},
    optionHelp: [],
    notes: ['A store exits with the code of its state; a plain SQLite file exits 0.'],
    run: runStats,
  },
  gc: {
    summary: 'Delete superseded snapshots',
    usage: '<dir> [--retain N]',
    positionals: ['dir'],
    options: { retain: { type: 'string' } },
    optionHelp: [
      `--retain N    Predecessors of current to keep (default ${DEFAULT_RETAINED_SNAPSHOTS})`,
    ],
    notes: [
      'gc refuses to delete from a store whose head fails validation, exiting with that',
      "state's code. A gc with nothing to delete skips the full integrity check, so use",
      'validate to detect corruption.',
    ],
    run: runGc,
  },
  seal: {
    summary: 'Export the head as a standalone SQLite file',
    usage: '<dir> <out.sqlite>',
    positionals: ['dir', 'out.sqlite'],
    options: {},
    optionHelp: [],
    notes: [
      'Use a new destination outside the store with no SQLite sidecar files.',
      'A pending tail must be reconciled first.',
    ],
    run: runSeal,
  },
  repair: {
    summary: 'Restore the last consistent point',
    usage: '<dir> [--dry-run]',
    positionals: ['dir'],
    options: { 'dry-run': { type: 'boolean' } },
    optionHelp: ['--dry-run     Print the steps repair would take, and change nothing'],
    notes: [
      'Run repair with all store clients stopped. Repair refuses an existing publish.lock.',
      'To recover an abandoned lock, prevent all clients on every host from restarting,',
      'verify none can resume, remove publish.lock, then run repair before restarting clients.',
      'Exits with the resulting state (the current state with --dry-run).',
    ],
    run: runRepair,
  },
  doctor: {
    summary: 'Binding capabilities and store or SQLite file health',
    usage: '<path> [--fix]',
    positionals: ['path'],
    options: { fix: { type: 'boolean' } },
    optionHelp: ['--fix         Run repair on an in-flight or corrupt store'],
    notes: [
      'Exits with the code of the final store state; a plain SQLite file exits 0 when',
      'clean and 3 when it fails integrity validation. Stop all store clients before',
      'using --fix, which runs repair.',
    ],
    run: runDoctor,
  },
  fsinspect: {
    summary: 'Probe whether a filesystem can host a store',
    usage: '<dir>',
    positionals: ['dir'],
    options: {},
    optionHelp: [],
    notes: ['Exits 0 when the filesystem can host a store and 5 when it cannot.'],
    run: runFsinspect,
  },
}

function globalHelp(): string[] {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length))
  return [
    'usage: fsqlite <command> [options]',
    '',
    'Operate an fsqlite store from the shell, without application schema code.',
    '',
    'Commands:',
    ...Object.entries(COMMANDS).map(
      ([name, spec]) =>
        `  ${name.padEnd(width)}  ${spec.usage.padEnd(USAGE_COLUMN)}  ${spec.summary}`,
    ),
    '',
    'Options:',
    '  --json         Print JSON instead of text (every command)',
    '  -h, --help     Show help; also `fsqlite <command> --help` or `fsqlite help <command>`',
    '  -V, --version  Show the version',
    '',
    ...EXIT_CODE_HELP,
  ]
}

function commandHelp(name: string, spec: CommandSpec): string[] {
  return [
    `usage: fsqlite ${name} ${spec.usage} [--json]`,
    '',
    spec.summary,
    '',
    'Options:',
    ...[...spec.optionHelp, ...COMMON_OPTION_HELP].map((line) => `  ${line}`),
    ...(spec.notes.length > 0 ? ['', ...spec.notes] : []),
    '',
    ...EXIT_CODE_HELP,
  ]
}

/** Run one CLI invocation (`argv` excludes the node and script paths). */
export function main(argv: readonly string[], io: CliIo = processIo): number {
  const endOfOptions = argv.indexOf('--')
  const json = (endOfOptions === -1 ? argv : argv.slice(0, endOfOptions)).includes('--json')
  try {
    return dispatch(argv, io)
  } catch (error: unknown) {
    if (error instanceof UsageError) {
      if (json) {
        reportError(io, error, true)
        return EXIT.usage
      }
      io.err(`fsqlite: ${error.message}`)
      io.err(
        error.command === null
          ? 'Run `fsqlite --help` for usage.'
          : `Run \`fsqlite ${error.command} --help\` for usage.`,
      )
      return EXIT.usage
    }
    reportError(io, error, json)
    return exitCodeForError(error)
  }
}

function dispatch(argv: readonly string[], io: CliIo): number {
  const [first, ...rest] = argv
  if (first === undefined) {
    for (const line of globalHelp()) {
      io.err(line)
    }
    return EXIT.usage
  }
  if (first === '--help' || first === '-h') {
    for (const line of globalHelp()) {
      io.out(line)
    }
    return EXIT.ok
  }
  if (first === '--version' || first === '-V') {
    io.out(packageInfo.version)
    return EXIT.ok
  }
  if (first === 'help') {
    return runHelp(rest, io)
  }
  if (first.startsWith('-')) {
    throw new UsageError(
      `unknown option '${first}' before the command; options follow it, as in ` +
        "'fsqlite <command> --json <path>'",
      null,
    )
  }
  const spec = Object.hasOwn(COMMANDS, first) ? COMMANDS[first] : undefined
  if (spec === undefined) {
    throw new UsageError(`unknown command '${first}'`, null)
  }
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: rest,
      options: { ...spec.options, ...COMMON_OPTIONS },
      strict: true,
      allowPositionals: true,
    })
  } catch (error) {
    throw new UsageError(parseErrorMessage(error), first)
  }
  const values = parsed.values as Invocation['values']
  if (values.help === true) {
    for (const line of commandHelp(first, spec)) {
      io.out(line)
    }
    return EXIT.ok
  }
  const args = parsed.positionals
  if (args.length < spec.positionals.length) {
    const missing = spec.positionals.slice(args.length).map((p) => `<${p}>`)
    throw new UsageError(`'${first}' needs ${missing.join(' ')}`, first)
  }
  if (args.length > spec.positionals.length) {
    throw new UsageError(
      `'${first}' takes ${spec.positionals.length} argument(s); unexpected '${args[spec.positionals.length] ?? ''}'`,
      first,
    )
  }
  return spec.run({ io, args, values, json: values.json === true })
}

/**
 * One sentence for a parseArgs error, in the CLI's own phrasing. parseArgs appends tips on
 * later lines and sentences; the one that matters, `--name=<value>` for a value that
 * starts with a dash, is kept.
 */
function parseErrorMessage(error: unknown): string {
  const first = (errorMessage(error).split('\n', 1)[0] ?? '').split('. ', 1)[0] ?? ''
  const sentence = first.replace(/\.$/, '')
  const option = /'(--?[^' ]+)/.exec(sentence)?.[1] ?? ''
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    return `unknown option '${option}'`
  }
  if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
    if (sentence.includes('does not take an argument')) {
      return `option '${option}' takes no value`
    }
    return `option '${option}' needs a value; write ${option}=<value> for one that starts with '-'`
  }
  return sentence.charAt(0).toLowerCase() + sentence.slice(1)
}

function runHelp(rest: string[], io: CliIo): number {
  const [name, extra] = rest
  if (extra !== undefined) {
    throw new UsageError(`'help' takes at most one command; unexpected '${extra}'`, null)
  }
  if (name === undefined) {
    for (const line of globalHelp()) {
      io.out(line)
    }
    return EXIT.ok
  }
  const spec = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined
  if (spec === undefined) {
    throw new UsageError(`unknown command '${name}'`, null)
  }
  for (const line of commandHelp(name, spec)) {
    io.out(line)
  }
  return EXIT.ok
}

/** Print an error and its cause chain; the stack too when FSQLITE_DEBUG=1. */
function reportError(io: CliIo, error: unknown, json: boolean): void {
  const causes: string[] = []
  let cause = error instanceof Error ? error.cause : undefined
  while (cause !== undefined && causes.length < MAX_REPORTED_CAUSES) {
    causes.push(errorMessage(cause))
    cause = cause instanceof Error ? cause.cause : undefined
  }
  if (json) {
    io.err(
      JSON.stringify({
        error: {
          code:
            error instanceof UsageError
              ? 'usage'
              : error instanceof FsqliteError
                ? error.code
                : null,
          message: errorMessage(error),
          causes,
        },
      }),
    )
  } else {
    io.err(`fsqlite: ${errorMessage(error)}`)
    for (const message of causes) {
      io.err(`  caused by: ${message}`)
    }
  }
  if (
    !json &&
    process.env.FSQLITE_DEBUG === '1' &&
    error instanceof Error &&
    error.stack !== undefined
  ) {
    io.err(error.stack)
  }
}

/** Print `data` as JSON, or the text lines `text()` returns. */
function emit(inv: Invocation, data: unknown, text: () => string[]): void {
  if (inv.json) {
    inv.io.out(JSON.stringify(data, null, 2))
    return
  }
  for (const line of text()) {
    inv.io.out(line)
  }
}

/** Refuse a path that is not a store, before any command reads it. */
function requireStore(dir: string): SnapshotStore {
  if (!hasStoreMarker(dir)) {
    throw new FsqliteError('not-a-store', `'${dir}' is not an fsqlite store (missing fsqlite.json)`)
  }
  return new SnapshotStore(dir) // no schema or policy is needed for these operations
}

/** The pointer's version, or null when it is missing, torn, or unreadable. */
function readableCurrent(store: SnapshotStore): number | null {
  try {
    return store.currentVersion()
  } catch {
    return null
  }
}

const stateLine = (v: ValidateResult): string =>
  `${v.state}${v.issues.length ? ': ' + v.issues.join('; ') : ''}`

const countEntries = (dir: string, suffix: string): number =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(suffix)).length : 0

function sqliteFactLines(f: SqliteFacts, indent: string): string[] {
  return [
    `${indent}sqlite_version: ${f.sqliteVersion}`,
    `${indent}page_size: ${f.pageSize}`,
    `${indent}page_count: ${f.pageCount}`,
    `${indent}file_bytes: ${f.fileBytes}`,
    `${indent}application_id: ${f.applicationId}`,
    `${indent}user_version: ${f.userVersion}`,
    `${indent}journal_mode: ${f.journalMode}`,
    `${indent}tables: ${f.tables.map((t) => `${t.name}=${t.rows}`).join(' ') || '(none)'}`,
  ]
}

/** stats and doctor accept a store directory or a plain SQLite file (by its header). */
function classifyPath(path: string): 'store' | 'sqlite-file' {
  if (hasStoreMarker(path)) {
    return 'store'
  }
  if (isSqliteFile(path)) {
    return 'sqlite-file'
  }
  throw new FsqliteError('not-a-store', `'${path}' is neither an fsqlite store nor a SQLite file`)
}

function positional(inv: Invocation, index: number): string {
  const value = inv.args[index]
  if (value === undefined) {
    throw new Error(`internal error: missing positional ${index}`)
  }
  return value
}

function runInfo(inv: Invocation): number {
  const path = positional(inv, 0)
  const store = requireStore(path)
  const v = store.validate()
  const report = {
    path,
    state: v.state,
    current: readableCurrent(store),
    snapshots: store.snapshotVersions(),
    pending: store.pendingTxns().length,
    issues: v.issues,
  }
  emit(inv, report, () => [
    `fsqlite info: ${path}`,
    `  state: ${report.state}`,
    `  current: ${report.current ?? '(unreadable)'}`,
    `  snapshots: ${report.snapshots.join(' ') || '(none)'}`,
    `  pending: ${report.pending}`,
    ...report.issues.map((issue) => `  issue: ${issue}`),
  ])
  return exitCodeForState(v.state)
}

function runValidate(inv: Invocation): number {
  const path = positional(inv, 0)
  const v = requireStore(path).validate()
  emit(inv, { path, ...v }, () => [stateLine(v)])
  return exitCodeForState(v.state)
}

function runStats(inv: Invocation): number {
  const path = positional(inv, 0)
  if (classifyPath(path) === 'sqlite-file') {
    const f = sqliteFacts(path)
    emit(inv, { path, kind: 'plain-sqlite', sqlite: f }, () => [
      `fsqlite stats: ${path}`,
      '  kind: plain-sqlite (no fsqlite layer)',
      ...sqliteFactLines(f, '  '),
    ])
    return EXIT.ok
  }
  const store = new SnapshotStore(path)
  const v = store.validate()
  const cur = readableCurrent(store)
  const fsqlite = {
    current: cur,
    snapshots: store.snapshotVersions().length,
    pending: store.pendingTxns().length,
    applied: countEntries(store.txApplied, '.txn'),
    quarantine: countEntries(store.txQuarantine, '.txn'),
    leases: countEntries(store.leaseDir, '.lease'),
    state: v.state,
  }
  const snapshot =
    cur !== null && existsSync(store.snapshotPath(cur))
      ? sqliteFacts(store.snapshotPath(cur))
      : null
  emit(inv, { path, kind: 'fsqlite-store', fsqlite, snapshot }, () => [
    `fsqlite stats: ${path}`,
    '  kind: fsqlite-store',
    `  current: ${fsqlite.current ?? '(unreadable)'}`,
    `  snapshots: ${fsqlite.snapshots}`,
    `  pending: ${fsqlite.pending}  applied: ${fsqlite.applied}  quarantine: ${fsqlite.quarantine}`,
    `  leases: ${fsqlite.leases}`,
    `  state: ${fsqlite.state}`,
    ...(snapshot ? ['  current snapshot (SQLite):', ...sqliteFactLines(snapshot, '    ')] : []),
  ])
  return exitCodeForState(v.state)
}

function runGc(inv: Invocation): number {
  const path = positional(inv, 0)
  const raw = inv.values.retain
  let retain = DEFAULT_RETAINED_SNAPSHOTS
  if (typeof raw === 'string') {
    // Number('') and Number(' ') are 0, so an unset shell variable must not mean retain 0.
    retain = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
    if (!Number.isSafeInteger(retain)) {
      throw new UsageError(
        `--retain must be a non-negative integer; received ${JSON.stringify(raw)}`,
        'gc',
      )
    }
  }
  const result = requireStore(path).gc({ retain })
  emit(inv, { path, retain, ...result }, () => [
    `removed ${result.removed} snapshot(s); kept ${result.kept}; ` +
      `leased: ${result.leased.join(' ') || 'none'}`,
  ])
  return EXIT.ok
}

function runSeal(inv: Invocation): number {
  const path = positional(inv, 0)
  const output = requireStore(path).seal(positional(inv, 1))
  emit(inv, { path, output }, () => [`sealed → ${output}`])
  return EXIT.ok
}

function repairLines(path: string, result: RepairResult, dryRun: boolean): string[] {
  const heading = dryRun
    ? `repair plan for ${path} (now ${result.state}):`
    : `repaired ${path}: ${result.state}`
  const none = dryRun ? '  (nothing to do)' : '  (no action needed)'
  return [heading, ...(result.actions.length ? result.actions.map((a) => `  ${a}`) : [none])]
}

function runRepair(inv: Invocation): number {
  const path = positional(inv, 0)
  const store = requireStore(path)
  const dryRun = inv.values['dry-run'] === true
  const result = dryRun ? store.planRepair() : store.repair()
  emit(inv, { path, dryRun, ...result }, () => repairLines(path, result, dryRun))
  return exitCodeForState(result.state)
}

function runDoctor(inv: Invocation): number {
  const path = positional(inv, 0)
  if (classifyPath(path) === 'sqlite-file') {
    const problems = integrityReport(path)
    const ok = problems.length === 0
    emit(inv, { path, kind: 'plain-sqlite', integrity: { ok, problems } }, () => [
      `fsqlite doctor: ${path}`,
      '  kind: plain-sqlite (no fsqlite layer)',
      `  integrity: ${ok ? 'ok' : problems.join('; ')}`,
    ])
    return ok ? EXIT.ok : EXIT.invalidOrCorrupt
  }
  const caps = capabilities()
  const store = new SnapshotStore(path)
  const before = store.validate()
  let after = before
  let repaired: string[] | null = null
  if (
    inv.values.fix === true &&
    (before.state === 'in-flight-capture' || before.state === 'corrupt')
  ) {
    repaired = store.repair().actions
    after = store.validate()
  }
  const out = {
    path,
    kind: 'fsqlite-store',
    capabilities: caps,
    store: after,
    ...(repaired === null ? {} : { before, repaired }),
  }
  emit(inv, out, () => [
    `fsqlite doctor: ${path}`,
    `  binding: session=${caps.session} backup=${caps.backup} rebaser=${caps.rebaser}`,
    ...(repaired === null
      ? []
      : [`  before: ${stateLine(before)}`, `  repaired: ${repaired.join('; ') || '(nothing)'}`]),
    `  store: ${stateLine(after)}`,
  ])
  return exitCodeForState(after.state)
}

function runFsinspect(inv: Invocation): number {
  const path = positional(inv, 0)
  let isDirectory = false
  try {
    isDirectory = statSync(path).isDirectory()
  } catch {
    // Reported below.
  }
  if (!isDirectory) {
    throw new UsageError(`'${path}' is not an existing directory`, 'fsinspect')
  }
  const report = inspectFilesystem(path)
  if (inv.json) {
    inv.io.out(JSON.stringify(report, null, 2))
  } else {
    inv.io.out(formatInspectReport(report))
  }
  return report.verdict.fsqliteSafe ? EXIT.ok : EXIT.unsafeFilesystem
}
