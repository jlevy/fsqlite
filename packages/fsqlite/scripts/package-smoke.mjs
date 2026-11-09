// Clean-project package smoke test: pack the built tarball, install it into a throwaway
// project with no development tooling, and exercise the published contract: the library
// import (`fsqlite`) and the CLI bin (`fsqlite`). This test verifies what npm
// consumers actually get, independent of the source checkout. It normally requires
// `dist/`; the release workflow can instead verify an exact registry package spec or the
// release tarball it packed.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const pkgDir = fileURLToPath(new URL('..', import.meta.url))
const registryPackage = process.env.FSQLITE_SMOKE_PACKAGE
if (registryPackage === undefined) {
  assert.ok(
    existsSync(join(pkgDir, 'dist', 'index.mjs')),
    'dist/ is missing: run `npm run build` first',
  )
}

/** @param {string} cmd @param {string[]} args @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [opts] */
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts })

// pnpm exports its own settings as npm_config_* variables. npm warns about settings
// it does not understand, so keep the consumer simulation independent of the package
// manager that launched this script.
const ignoredNpmConfig = new Set([
  'npm_config_minimum_release_age',
  'npm_config_frozen_lockfile',
  'NPM_CONFIG_MINIMUM_RELEASE_AGE',
  'NPM_CONFIG_FROZEN_LOCKFILE',
])
/** @type {NodeJS.ProcessEnv} */
const npmEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !ignoredNpmConfig.has(key)),
)

/** @param {string} output */
function packedFilename(output) {
  /** @type {unknown} */
  const value = JSON.parse(output)
  if (!Array.isArray(value)) {
    throw new Error('npm pack did not return an array')
  }
  const entries = /** @type {unknown[]} */ (value)
  const first = entries[0]
  if (typeof first !== 'object' || first === null || !('filename' in first)) {
    throw new Error('npm pack result is missing filename')
  }
  const filename = /** @type {Record<string, unknown>} */ (first).filename
  if (typeof filename !== 'string') {
    throw new Error('npm pack filename is not a string')
  }
  return filename
}

/** @param {string} output */
function publishedVersion(output) {
  /** @type {unknown} */
  const value = JSON.parse(output)
  if (typeof value !== 'object' || value === null || !('current' in value)) {
    throw new Error('CLI info result is missing current')
  }
  return value.current
}

// By default, pack exactly what would publish. The release workflow can instead pass an
// exact registry spec (the first owner-authenticated publication) or a packed tarball.
const tarball =
  registryPackage === undefined
    ? packedFilename(run('npm', ['pack', '--json'], { cwd: pkgDir, env: npmEnv }))
    : undefined
const packageSpec = tarball === undefined ? registryPackage : join(pkgDir, tarball)
assert.ok(packageSpec, 'package smoke test requires a tarball or registry package spec')
try {
  const proj = mkdtempSync(join(tmpdir(), 'fsqlite-smoke-'))
  try {
    // Install the tarball into a clean, dependency-free ESM project.
    writeFileSync(
      join(proj, 'package.json'),
      JSON.stringify({ name: 'smoke', private: true, type: 'module' }),
    )
    run('npm', ['install', '--no-audit', '--no-fund', '--no-save', packageSpec], {
      cwd: proj,
      env: npmEnv,
    })
    assert.ok(
      existsSync(join(proj, 'node_modules', 'fsqlite', 'dist', 'index.mjs')),
      'installed package is missing dist/index.mjs',
    )

    // Exercise the library entry through the package name to verify exports and types.
    const storeDir = join(proj, 'store')
    writeFileSync(
      join(proj, 'use-lib.mjs'),
      [
        "import { SnapshotStore, DirectStore, inspectFilesystem } from 'fsqlite'",
        "import assert from 'node:assert/strict'",
        `const s = new SnapshotStore(${JSON.stringify(storeDir)}, { schema: 'CREATE TABLE kv(k TEXT PRIMARY KEY NOT NULL, v TEXT)', conflictPolicy: { '*': 'lww' } }).init()`,
        "s.write('w1', (db) => db.prepare('INSERT INTO kv VALUES (?,?)').run('a', '1'))",
        's.reconcile()',
        "assert.equal(s.read((db) => db.prepare('SELECT v FROM kv WHERE k=?').get('a')).v, '1')",
        "assert.equal(typeof DirectStore, 'function')",
        "assert.equal(typeof inspectFilesystem, 'function')",
        "console.log('  library import and write/reconcile/read OK')",
      ].join('\n'),
    )
    process.stdout.write(run('node', ['use-lib.mjs'], { cwd: proj }))

    // The `default` export condition also serves CommonJS consumers through require(esm).
    writeFileSync(
      join(proj, 'use-require.cjs'),
      [
        "const assert = require('node:assert/strict')",
        "const { SnapshotStore, DirectStore, inspectFilesystem } = require('fsqlite')",
        "assert.equal(typeof SnapshotStore, 'function')",
        "assert.equal(typeof DirectStore, 'function')",
        "assert.equal(typeof inspectFilesystem, 'function')",
        "console.log('  library require OK')",
      ].join('\n'),
    )
    process.stdout.write(run('node', ['use-require.cjs'], { cwd: proj }))

    // The `fsqlite/cli` export is importable: it runs no command and leaves the exit code.
    writeFileSync(
      join(proj, 'use-cli.mjs'),
      [
        "import { main } from 'fsqlite/cli'",
        "import assert from 'node:assert/strict'",
        "assert.equal(typeof main, 'function')",
        'assert.equal(process.exitCode, undefined)',
        'const out = []',
        `assert.equal(main(['validate', ${JSON.stringify(storeDir)}], { out: (l) => out.push(l), err: () => {} }), 0)`,
        "assert.deepEqual(out, ['sealed'])",
        "console.log('  CLI module import and main() OK')",
      ].join('\n'),
    )
    process.stdout.write(run('node', ['use-cli.mjs'], { cwd: proj }))

    // Exercise the installed CLI to verify its bin entry and shebang.
    const bin = join(proj, 'node_modules', '.bin', 'fsqlite')
    assert.match(run(bin, ['--help'], { cwd: proj }), /usage: fsqlite/, 'CLI --help')
    assert.match(run(bin, ['--version'], { cwd: proj }), /^\d+\.\d+\.\d+/, 'CLI --version')
    assert.equal(
      publishedVersion(run(bin, ['info', storeDir, '--json'], { cwd: proj })),
      1,
      'CLI info --json reports published head',
    )
    run(bin, ['validate', storeDir], { cwd: proj }) // exits 0 on a healthy store
    console.log('  CLI bin help, version, info --json, and validate OK')

    console.log('package smoke test passed')
  } finally {
    rmSync(proj, { recursive: true, force: true })
  }
} finally {
  if (tarball !== undefined) {
    rmSync(join(pkgDir, tarball), { force: true })
  }
}
