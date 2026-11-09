// Checks the dependency policy that pnpm applies and requires every audit or trust
// policy exception to have a record in SUPPLY-CHAIN-SECURITY.md.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PNPM_AUDIT_COMMAND,
  PNPM_POLICY_FLOOR_COMMAND,
  PNPM_TRUST_POLICY_COMMAND,
  checkAuditExceptions,
  checkTrustPolicyExclusions,
  crossCheckPnpmAudit,
  crossCheckPnpmPolicyFloor,
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
 * Run a `pnpm config` command and cross-check its output.
 * @param {string[]} args
 * @param {(pnpmOutput: string) => string[]} crossCheck
 */
const crossCheckWithPnpm = (args, crossCheck) => {
  const command = `pnpm ${args.join(' ')}`
  const pnpm = spawnSync('pnpm', args, { cwd: repoRoot, encoding: 'utf8' })
  if (pnpm.error !== undefined || pnpm.status !== 0) {
    errors.push(
      `\`${command}\` failed (${pnpm.error?.message ?? `exit ${pnpm.status ?? pnpm.signal}`}):\n${pnpm.stderr}`,
    )
  } else {
    errors.push(...crossCheck(pnpm.stdout))
  }
}
crossCheckWithPnpm(PNPM_POLICY_FLOOR_COMMAND, crossCheckPnpmPolicyFloor)
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
    `supply-chain policy verified (${ids.length} ignored advisories, ` +
      `${exclusions.entries.length} recorded trust-policy exclusions)`,
  )
}
