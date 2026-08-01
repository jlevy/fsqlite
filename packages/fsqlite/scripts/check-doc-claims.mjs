import { readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoDir = resolve(packageDir, '../..')

/** @param {string} dir @param {(path: string) => boolean} accept @returns {string[]} */
function filesBelow(dir, accept) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.tbd' || entry.name === 'node_modules') {
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

/** @param {number} nodeTests */
export function checkDocClaims(nodeTests) {
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
