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
  if (/file:\/\//iu.test(source) || /\/(?:Users|home)\/[\w.-]+\//u.test(source)) {
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

function checkEditorialSafety() {
  const proseFiles = filesBelow(repoDir, (path) => proseExtensions.has(extname(path)))
  for (const path of proseFiles) {
    const repoPath = relative(repoDir, path).split(sep).join('/')
    if (generatedProse.has(repoPath)) {
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

/** @param {number} nodeTests */
export function checkDocClaims(nodeTests) {
  checkEditorialSafety()
  const markdown = filesBelow(repoDir, (path) => extname(path) === '.md')
  const claimPatterns = [
    {
      label: 'node:test',
      expected: nodeTests,
      patterns: [/(\d+)\s+`node:test`\s+cases/giu, /node:test reports `# pass (\d+)`/giu],
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
    checkMarkdownSafety(path, source)
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
