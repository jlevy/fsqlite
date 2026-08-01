// Clean-project package smoke test: pack the built tarball, install it into a throwaway
// project with no dev tooling, and exercise the published contract -- the library import
// (`fsqlite`) and the CLI bin (`fsqlite`). This is the only test that proves what npm
// consumers actually get, independent of the source checkout. Requires `dist/` to be built.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const pkgDir = fileURLToPath(new URL('..', import.meta.url))
assert.ok(existsSync(join(pkgDir, 'dist', 'index.mjs')), 'dist/ is missing -- run `npm run build` first')

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts })

// Pack the package exactly as it would publish (only the `files` allowlist ships).
const tarball = JSON.parse(run('npm', ['pack', '--json'], { cwd: pkgDir }))[0].filename
const tarballPath = join(pkgDir, tarball)
try {
  const proj = mkdtempSync(join(tmpdir(), 'fsqlite-smoke-'))
  try {
    // Install the tarball into a clean, dependency-free ESM project.
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module' }))
    run('npm', ['install', '--no-audit', '--no-fund', '--no-save', tarballPath], { cwd: proj })
    assert.ok(
      existsSync(join(proj, 'node_modules', 'fsqlite', 'dist', 'index.mjs')),
      'installed package is missing dist/index.mjs',
    )

    // Exercise the library entry through the package name (proves exports resolution + types shape).
    const room = join(proj, 'room')
    writeFileSync(
      join(proj, 'use-lib.mjs'),
      [
        "import { SnapshotStore, DirectStore, inspect } from 'fsqlite'",
        "import assert from 'node:assert/strict'",
        `const s = new SnapshotStore(${JSON.stringify(room)}, { schema: 'CREATE TABLE kv(k TEXT PRIMARY KEY NOT NULL, v TEXT)', conflictPolicy: { '*': 'lww' } }).init()`,
        "s.write('w1', (db) => db.prepare('INSERT INTO kv VALUES (?,?)').run('a', '1'))",
        's.reconcile()',
        "assert.equal(s.read((db) => db.prepare('SELECT v FROM kv WHERE k=?').get('a')).v, '1')",
        "assert.equal(typeof DirectStore, 'function')",
        "assert.equal(typeof inspect, 'function')",
        "console.log('  library import + write/reconcile/read OK')",
      ].join('\n'),
    )
    process.stdout.write(run('node', ['use-lib.mjs'], { cwd: proj }))

    // Exercise the CLI bin through the installed package (proves the `bin` + shebang resolve).
    const bin = join(proj, 'node_modules', '.bin', 'fsqlite')
    assert.match(run(bin, ['--help'], { cwd: proj }), /usage: fsqlite/, 'CLI --help')
    assert.equal(JSON.parse(run(bin, ['info', room], { cwd: proj })).current, 1, 'CLI info reports published head')
    run(bin, ['validate', room], { cwd: proj }) // exits 0 on a healthy store
    console.log('  CLI bin --help / info / validate OK')

    console.log('package smoke test passed')
  } finally {
    rmSync(proj, { recursive: true, force: true })
  }
} finally {
  rmSync(tarballPath, { force: true })
}
