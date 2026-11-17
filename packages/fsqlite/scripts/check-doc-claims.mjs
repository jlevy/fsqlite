import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoDir = resolve(packageDir, '../..')
const realRepoDir = realpathSync(repoDir)
const generatedMarkdown = new Set(['.agents/skills/tbd/SKILL.md', '.claude/skills/tbd/SKILL.md'])
// Files tbd setup writes verbatim and the project does not adapt.
const generatedProse = new Set([
  ...generatedMarkdown,
  '.claude/scripts/ensure-gh-cli.sh',
  '.codex/ensure-gh-cli.sh',
  'pnpm-lock.yaml',
])
// Benchmark output the research spikes write. Its `.json` files quote dataset text
// verbatim, so the editorial rules for maintained prose do not apply to them; any other
// file in these directories, such as a README, is checked. `.prettierignore` lists the
// same globs, and check-doc-claims.test.mjs checks that the two lists agree.
export const generatedDataGlobs = [
  'docs/research/spikes/*/harness/expected/',
  'docs/research/spikes/*/results/',
]
// Patched prototype copies of the package, whose READMEs state their own test counts.
export const prototypeDocGlob = 'docs/research/spikes/*/fsqlite-v2/'

/**
 * A directory glob, where `*` is one path segment, as a pattern for the paths inside it.
 * @param {string} glob
 */
const globPrefix = (glob) =>
  new RegExp(
    `^${glob
      .split('*')
      .map((part) => part.replace(/[^\w/-]/gu, '\\$&'))
      .join('[^/]+')}`,
    'u',
  )
const generatedData = generatedDataGlobs.map(globPrefix)
const prototypeDocs = globPrefix(prototypeDocGlob)

/** Whether the editorial rules skip a file: spike benchmark `.json` only. @param {string} repoPath */
export const isGeneratedData = (repoPath) =>
  extname(repoPath) === '.json' && generatedData.some((pattern) => pattern.test(repoPath))

/** Whether the test-count check skips a Markdown file. @param {string} repoPath */
export const skipsTestCountClaims = (repoPath) => prototypeDocs.test(repoPath)

/**
 * Whether a text holds a machine-local path: a `file://` URL, a home directory, or an
 * agent session's scratch directory.
 * @param {string} source
 */
export const hasMachineLocalPath = (source) =>
  /file:\/\//iu.test(source) || /\/(?:Users|home)\/[\w.-]+\/|\/tmp\/claude-\d+\//u.test(source)
// Sub-agent definitions are agent prompts, not docs, so they carry no doc footer.
const agentPromptDirs = ['.claude/agents/']
const executableMarkdown = new Set(['packages/fsqlite/test/cli-golden/cli.tryscript.md'])
const proseExtensions = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.mts',
  '.sh',
  '.ts',
  '.yaml',
  '.yml',
])

/** @param {string} dir @param {(path: string) => boolean} accept @returns {string[]} */
function filesBelow(dir, accept) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === '.git' ||
      entry.name === '.tbd' ||
      entry.name === 'attic' ||
      entry.name === 'dist' ||
      entry.name === 'node_modules'
    ) {
      continue
    }
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...filesBelow(path, accept))
    } else if (accept(path)) {
      files.push(path)
    }
  }
  return files
}

const goldenPath = join(packageDir, 'test/cli-golden/cli.tryscript.md')
const goldenCases = readFileSync(goldenPath, 'utf8').match(/^\$ /gm)?.length ?? 0

/** @param {string} source */
function withoutMarkdownCode(source) {
  let fence
  const prose = []
  for (const line of source.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1]
    if (fence === undefined && marker !== undefined) {
      fence = marker
      continue
    }
    if (
      fence !== undefined &&
      marker !== undefined &&
      marker.startsWith(fence.slice(0, 1)) &&
      marker.length >= fence.length
    ) {
      fence = undefined
      continue
    }
    if (fence === undefined) {
      prose.push(line)
    }
  }
  return prose.join('\n').replace(/`+[^`\n]*`+/gu, '')
}

/** @param {string} path */
function isInsideRepo(path) {
  const repoRelative = relative(realRepoDir, path)
  return (
    repoRelative === '' ||
    (repoRelative !== '..' && !repoRelative.startsWith(`..${sep}`) && !isAbsolute(repoRelative))
  )
}

/** @param {string} path @param {string} source */
function checkMarkdownSafety(path, source) {
  if (hasMachineLocalPath(source)) {
    throw new Error(`${path}: documentation contains a machine-local path`)
  }

  const prose = withoutMarkdownCode(source)
  for (const match of prose.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
    let target = match[1]?.trim()
    if (target === undefined || target === '' || target.startsWith('#')) {
      continue
    }
    if (target.startsWith('<') && target.endsWith('>')) {
      target = target.slice(1, -1)
    }
    if (/^[a-z][a-z\d+.-]*:/iu.test(target)) {
      continue
    }

    const relativePath = target.split('#', 1)[0]?.split('?', 1)[0]
    if (relativePath === undefined || relativePath === '') {
      continue
    }
    if (relativePath.startsWith('/')) {
      throw new Error(`${path}: documentation link uses an absolute local path: ${target}`)
    }

    const resolved = resolve(dirname(path), decodeURIComponent(relativePath))
    if (!isInsideRepo(resolved)) {
      throw new Error(`${path}: documentation link escapes the repository: ${target}`)
    }
    let realTarget
    try {
      statSync(resolved)
      realTarget = realpathSync(resolved)
    } catch {
      throw new Error(`${path}: broken local documentation link: ${target}`)
    }
    if (!isInsideRepo(realTarget)) {
      throw new Error(`${path}: documentation link resolves outside the repository: ${target}`)
    }
  }
}

/**
 * Remove the blocks tbd setup regenerates verbatim (for example in AGENTS.md); the
 * surrounding project prose stays subject to the editorial rules.
 * @param {string} source
 */
function withoutTbdManagedBlocks(source) {
  return source.replace(/<!-- BEGIN TBD INTEGRATION\b[\s\S]*?<!-- END TBD INTEGRATION -->/gu, '')
}

/** Fail on an em or en dash or a missing doc footer in maintained prose. */
export function checkEditorialSafety(root = repoDir) {
  const proseFiles = filesBelow(root, (path) => proseExtensions.has(extname(path)))
  for (const path of proseFiles) {
    const repoPath = relative(root, path).split(sep).join('/')
    if (generatedProse.has(repoPath) || isGeneratedData(repoPath)) {
      continue
    }

    const source = readFileSync(path, 'utf8')
    if (/[\u2013\u2014]/u.test(withoutTbdManagedBlocks(source))) {
      throw new Error(`${path}: maintained prose contains an em dash or en dash`)
    }
    if (
      extname(path) === '.md' &&
      !executableMarkdown.has(repoPath) &&
      !agentPromptDirs.some((dir) => repoPath.startsWith(dir)) &&
      !source.includes('This document follows common-doc-guidelines.md.')
    ) {
      throw new Error(`${path}: maintained Markdown is missing the common-doc-guidelines footer`)
    }
  }
}

/**
 * Fail on a JSON file under docs/ that does not parse or that holds a machine-local path.
 * The editorial rules skip the spike result files, and Prettier ignores them, so this is
 * the check that reads them.
 */
export function checkDataFiles(root = repoDir) {
  const files = filesBelow(join(root, 'docs'), (path) => extname(path) === '.json')
  for (const path of files) {
    const source = readFileSync(path, 'utf8')
    if (hasMachineLocalPath(source)) {
      throw new Error(`${path}: data file contains a machine-local path`)
    }
    try {
      JSON.parse(source)
    } catch (error) {
      throw new Error(
        `${path}: not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }
  return files.length
}

/** Fail on a machine-local path or a broken, escaping local link in any Markdown file. */
export function checkMarkdownLinks() {
  const markdown = filesBelow(repoDir, (path) => extname(path) === '.md')
  for (const path of markdown) {
    checkMarkdownSafety(path, readFileSync(path, 'utf8'))
  }
  return markdown.length
}

/**
 * Fail when a documented `node:test` or CLI golden count differs from the suite's.
 * @param {number} nodeTests
 */
export function checkDocClaims(nodeTests) {
  // The v2 prototypes document patched copies of the package, whose test counts differ
  // from the package's by design, so their count claims are not checked here.
  const markdown = filesBelow(
    repoDir,
    (path) =>
      extname(path) === '.md' &&
      !skipsTestCountClaims(relative(repoDir, path).split(sep).join('/')),
  )
  const claimPatterns = [
    {
      label: 'node:test',
      expected: nodeTests,
      patterns: [/(\d+)\s+`node:test`\s+cases/giu, /node:test reports `(?:#|ℹ) tests (\d+)`/giu],
    },
    {
      label: 'CLI golden',
      expected: goldenCases,
      patterns: [/(\d+)\s+(?:tryscript\s+)?CLI golden(?: cases|s)/giu, /goldens `(\d+) passed`/giu],
    },
  ]

  let checked = 0
  for (const path of markdown) {
    const source = readFileSync(path, 'utf8')
    for (const claim of claimPatterns) {
      for (const pattern of claim.patterns) {
        for (const match of source.matchAll(pattern)) {
          checked += 1
          const stated = Number(match[1])
          if (stated !== claim.expected) {
            throw new Error(
              `${path}: stale ${claim.label} count ${stated}; current count is ${claim.expected}`,
            )
          }
        }
      }
    }
  }

  if (checked === 0) {
    throw new Error('no documentation test-count claims found')
  }

  console.log(
    `documentation claims match ${nodeTests} node:test cases and ${goldenCases} CLI cases`,
  )
}
