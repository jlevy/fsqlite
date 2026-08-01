import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkDocClaims } from './check-doc-claims.mjs'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testFiles = readdirSync(join(packageDir, 'test'))
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => join('test', name))

const result = spawnSync(
  process.execPath,
  ['--test', '--test-reporter=spec', '--test-concurrency=2', '--test-timeout=30000', ...testFiles],
  { cwd: packageDir, encoding: 'utf8' },
)

process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
if (result.error) {
  throw result.error
}
if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

const summary = [...result.stdout.matchAll(/^(?:ℹ|#) tests (\d+)$/gmu)].at(-1)
if (!summary) {
  throw new Error('node:test completed without a parseable test-count summary')
}
checkDocClaims(Number(summary[1]))
