// Fails when an advisory ignored in pnpm-workspace.yaml has no recorded exception in
// SUPPLY-CHAIN-SECURITY.md, or when that exception's review date has passed, so a
// time-limited audit exception cannot silently become permanent.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const workspace = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
const policy = readFileSync(join(repoRoot, 'SUPPLY-CHAIN-SECURITY.md'), 'utf8')

const ignoreBlock = /^\s*ignoreGhsas:\s*\n((?:\s+-\s+\S+\s*\n?)*)/m.exec(workspace)?.[1] ?? ''
const ignored = [...ignoreBlock.matchAll(/-\s+(GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4})/g)].map(
  (match) => match[1],
)

const sections = policy.split(/^(?=## )/m)
const today = new Date().toISOString().slice(0, 10)
for (const ghsa of ignored) {
  const section = sections.find((text) => text.includes(ghsa))
  assert(section, `${ghsa} is ignored in pnpm-workspace.yaml but has no exception record`)
  const reviewBy = /Review this exception by (\d{4}-\d{2}-\d{2})/.exec(section)?.[1]
  assert(reviewBy, `${ghsa} exception record has no "Review this exception by" date`)
  assert(
    today <= reviewBy,
    `${ghsa} audit exception expired on ${reviewBy}; review it in SUPPLY-CHAIN-SECURITY.md`,
  )
}

console.log(`supply-chain exceptions current (${ignored.length} ignored advisories)`)
