// Which files the documentation checks cover. Run by `pnpm check:docs` before the checks
// themselves; kept out of the package's node:test suite, whose count the docs state.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  checkDataFiles,
  checkEditorialSafety,
  generatedDataGlobs,
  hasMachineLocalPath,
  isGeneratedData,
  skipsTestCountClaims,
} from './check-doc-claims.mjs'

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const footer =
  '<!-- This document follows common-doc-guidelines.md.\nSee github.com/jlevy/practical-prose and review guidelines before editing.\n-->\n'

/** @param {(root: string) => void} body */
function withTree(body) {
  const root = mkdtempSync(join(tmpdir(), 'doc-claims-'))
  try {
    body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** @param {string} root @param {string} path @param {string} text */
function put(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

void test('the editorial exclusion covers spike benchmark JSON only', () => {
  assert.equal(isGeneratedData('docs/research/spikes/kb/results/fsqlite/S1/w3.json'), true)
  assert.equal(isGeneratedData('docs/research/spikes/other/harness/expected/S0/w3.json'), true)
  assert.equal(isGeneratedData('docs/research/spikes/kb/results/README.md'), false)
  assert.equal(isGeneratedData('docs/research/spikes/kb/results/summarize.py'), false)
  assert.equal(isGeneratedData('docs/research/spikes/kb/harness/queries.json'), false)
  assert.equal(isGeneratedData('docs/research/spikes/a/b/results/x.json'), false)
})

void test('a Markdown file under results/ is still checked, and its JSON is not', () => {
  withTree((root) => {
    put(
      root,
      'docs/research/spikes/kb/results/arm/w3.json',
      `{"title": "A ${String.fromCodePoint(0x2014)} B"}\n`,
    )
    put(root, 'docs/ok.md', `# Ok\n\n${footer}`)
    checkEditorialSafety(root)
    put(root, 'docs/research/spikes/kb/results/README.md', '# Results\n')
    assert.throws(() => {
      checkEditorialSafety(root)
    }, /results\/README\.md: maintained Markdown is missing the common-doc-guidelines footer/u)
  })
})

void test('the test-count skip covers only the v2 prototype docs', () => {
  assert.equal(skipsTestCountClaims('docs/research/spikes/kb/fsqlite-v2/combined/README.md'), true)
  assert.equal(skipsTestCountClaims('docs/research/spikes/kb/harness/README.md'), false)
  assert.equal(skipsTestCountClaims('docs/research/spikes/kb/notes/design.md'), false)
  assert.equal(skipsTestCountClaims('docs/qa-runbook.md'), false)
})

void test('.prettierignore ignores the same spike data directories', () => {
  const ignored = readFileSync(join(repoDir, '.prettierignore'), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('docs/research/spikes/'))
  assert.deepEqual(ignored, generatedDataGlobs)
})

void test('data files under docs/ must parse and hold no machine-local path', () => {
  assert.equal(hasMachineLocalPath('{"kb": "<scratch>/kb-corpora/S1/kb"}'), false)
  assert.equal(hasMachineLocalPath('{"kb": "/tmp/claude-0/-home-x/s/scratchpad/kb"}'), true)
  assert.equal(hasMachineLocalPath('{"src": "/home/user/fsqlite/attic"}'), true)
  withTree((root) => {
    put(root, 'docs/research/spikes/kb/results/a.json', '{"kb": "<scratch>/kb"}\n')
    assert.equal(checkDataFiles(root), 1)
    put(root, 'docs/research/spikes/kb/results/b.json', '{"kb": "/home/user/x/kb"}\n')
    assert.throws(() => checkDataFiles(root), /b\.json: data file contains a machine-local path/u)
    put(root, 'docs/research/spikes/kb/results/b.json', '{"queries": [')
    assert.throws(() => checkDataFiles(root), /b\.json: not valid JSON/u)
  })
})
