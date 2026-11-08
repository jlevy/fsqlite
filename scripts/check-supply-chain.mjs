// Fails when an advisory ignored in pnpm-workspace.yaml has no current time-limited
// exception record in SUPPLY-CHAIN-SECURITY.md, so an audit exception cannot silently
// become permanent. The rules live in supply-chain-exceptions.mjs; this applies them to
// the repository files and cross-checks the result against what pnpm reports.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PNPM_AUDIT_COMMAND,
  checkAuditExceptions,
  crossCheckPnpmAudit,
} from './supply-chain-exceptions.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const { ids, errors } = checkAuditExceptions({
  workspaceText: readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'),
  policyText: readFileSync(join(repoRoot, 'SUPPLY-CHAIN-SECURITY.md'), 'utf8'),
  today: new Date().toISOString().slice(0, 10),
})

const command = `pnpm ${PNPM_AUDIT_COMMAND.join(' ')}`
const pnpm = spawnSync('pnpm', PNPM_AUDIT_COMMAND, { cwd: repoRoot, encoding: 'utf8' })
if (/** @type {NodeJS.ErrnoException | undefined} */ (pnpm.error)?.code === 'ENOENT') {
  console.warn(
    `supply-chain: pnpm is not on PATH, so the audit cross-check against \`${command}\` ` +
      'was skipped.',
  )
} else if (pnpm.error !== undefined || pnpm.status !== 0) {
  errors.push(
    `\`${command}\` failed (${pnpm.error?.message ?? `exit ${pnpm.status ?? pnpm.signal}`}):\n${pnpm.stderr}`,
  )
} else {
  errors.push(...crossCheckPnpmAudit({ ids, pnpmOutput: pnpm.stdout }))
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`supply-chain: ${error}`)
  }
  process.exitCode = 1
} else {
  console.log(`supply-chain exceptions current (${ids.length} ignored advisories)`)
}
