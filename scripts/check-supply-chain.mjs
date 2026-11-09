// Fails when an advisory ignored in pnpm-workspace.yaml has no current time-limited
// exception record in SUPPLY-CHAIN-SECURITY.md, so an audit exception cannot silently
// become permanent, and when a trustPolicyExclude entry has no recorded reason. The rules
// live in supply-chain-exceptions.mjs; this applies them to the repository files and
// cross-checks the results against what pnpm reports.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PNPM_AUDIT_COMMAND,
  PNPM_TRUST_POLICY_COMMAND,
  checkAuditExceptions,
  checkTrustPolicyExclusions,
  crossCheckPnpmAudit,
  crossCheckPnpmTrustPolicy,
} from './supply-chain-exceptions.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const workspaceText = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
const policyText = readFileSync(join(repoRoot, 'SUPPLY-CHAIN-SECURITY.md'), 'utf8')
const { ids, errors } = checkAuditExceptions({
  workspaceText,
  policyText,
  today: new Date().toISOString().slice(0, 10),
})
const exclusions = checkTrustPolicyExclusions({ workspaceText, policyText })
errors.push(...exclusions.errors)

/**
 * Run a `pnpm config get` command and cross-check its output, or explain why it could
 * not run. A missing pnpm skips the comparison with a warning.
 * @param {string[]} args
 * @param {(pnpmOutput: string) => string[]} crossCheck
 */
const crossCheckWithPnpm = (args, crossCheck) => {
  const command = `pnpm ${args.join(' ')}`
  const pnpm = spawnSync('pnpm', args, { cwd: repoRoot, encoding: 'utf8' })
  if (/** @type {NodeJS.ErrnoException | undefined} */ (pnpm.error)?.code === 'ENOENT') {
    console.warn(
      `supply-chain: pnpm is not on PATH, so the cross-check against \`${command}\` was skipped.`,
    )
  } else if (pnpm.error !== undefined || pnpm.status !== 0) {
    errors.push(
      `\`${command}\` failed (${pnpm.error?.message ?? `exit ${pnpm.status ?? pnpm.signal}`}):\n${pnpm.stderr}`,
    )
  } else {
    errors.push(...crossCheck(pnpm.stdout))
  }
}
crossCheckWithPnpm(PNPM_AUDIT_COMMAND, (pnpmOutput) => crossCheckPnpmAudit({ ids, pnpmOutput }))
crossCheckWithPnpm(PNPM_TRUST_POLICY_COMMAND, (pnpmOutput) =>
  crossCheckPnpmTrustPolicy({ entries: exclusions.entries, pnpmOutput }),
)

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`supply-chain: ${error}`)
  }
  process.exitCode = 1
} else {
  console.log(
    `supply-chain exceptions current (${ids.length} ignored advisories, ` +
      `${exclusions.entries.length} recorded trust-policy exclusions)`,
  )
}
