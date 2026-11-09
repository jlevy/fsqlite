// Run the node:test suite, streaming its report, then check the documentation's test-count
// claims against the number of tests that ran.
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkDocClaims } from './check-doc-claims.mjs'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testFiles = readdirSync(join(packageDir, 'test'))
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => join('test', name))

/** @type {number[]} Every `tests N` summary the reporter printed. */
const totals = []
let pending = ''
const child = spawn(
  process.execPath,
  ['--test', '--test-reporter=spec', '--test-concurrency=2', '--test-timeout=30000', ...testFiles],
  { cwd: packageDir, stdio: ['ignore', 'pipe', 'inherit'] },
)
child.stdout.setEncoding('utf8')
child.stdout.on('data', (/** @type {string} */ chunk) => {
  process.stdout.write(chunk)
  const lines = (pending + chunk).split('\n')
  pending = lines.pop() ?? ''
  for (const line of lines) {
    const match = /^(?:ℹ|#) tests (\d+)$/u.exec(line)
    if (match) {
      totals.push(Number(match[1]))
    }
  }
})
/** @type {[number | null, NodeJS.Signals | null]} */
const [code, signal] = await new Promise((resolveExit, reject) => {
  child.on('error', reject)
  child.on('close', (exitCode, exitSignal) => {
    resolveExit([exitCode, exitSignal])
  })
})
if (code !== 0) {
  console.error(`node --test exited ${String(code ?? signal)}`)
  process.exit(typeof code === 'number' && code !== 0 ? code : 1)
}
const summary = totals.at(-1)
if (summary === undefined) {
  throw new Error('node:test completed without a parseable test-count summary')
}
checkDocClaims(summary)
