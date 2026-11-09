import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  EXCEPTION_WINDOW_DAYS,
  checkAuditExceptions,
  checkTrustPolicyExclusions,
  crossCheckPnpmAudit,
  crossCheckPnpmTrustPolicy,
  findAdvisoryIds,
  findTrustPolicyExcludes,
} from './supply-chain-exceptions.mjs'

const TODAY = '2026-11-08'
const RECORDED = 'GHSA-g3hv-75wg-m249'
const UNRECORDED = 'GHSA-aaaa-bbbb-cccc'

/** @param {string} auditSettings */
const workspace = (auditSettings) =>
  'packages:\n  - packages/*\n\nminimumReleaseAge: 20160\ntrustPolicy: no-downgrade\n' +
  `trustPolicyExclude:\n  - undici-types@6.21.0\n# Time-limited audit exception.\n${auditSettings}`

/** The current section and list keys, then the deprecated ones pnpm still honors alone. */
const AUDIT_KEYS = [
  ['audit', 'ignore'],
  ['auditConfig', 'ignoreGhsas'],
]

/** The form pnpm-workspace.yaml uses today, pnpm 11.16's `audit.ignore`. */
const CURRENT_WORKSPACE = workspace(`audit:\n  ignore:\n    - ${RECORDED}\n`)

/** @param {string} body @param {string} [heading] */
const policy = (body, heading = '## Time-Limited Audit Exception') =>
  `# Supply-Chain Security\n\nIntro.\n\n${heading}\n\n${body}\n\n` +
  '## Resolved Exceptions\n\n- GHSA-zzzz-zzzz-zzzz was removed; Review this exception by 2020-01-01.\n'

/** @param {string} reviewBy @param {string} [id] */
const record = (reviewBy, id = RECORDED) =>
  `\`pnpm audit\` reports [${id}](https://github.com/advisories/${id}).\n\n` +
  `Review this exception by ${reviewBy}, or earlier when a patched release clears the cool-off.`

const CURRENT_POLICY = policy(record('2026-12-08'))

/** A trustPolicyExclude record in the shape SUPPLY-CHAIN-SECURITY.md uses. */
const TRUST_POLICY_RECORD =
  '## Conditional Trust-Policy Exclusion\n\n`trustPolicyExclude` admits exactly ' +
  '`undici-types@6.21.0`. The maintainer approved this exclusion on 2026-11-08.\n\n' +
  'This exclusion has no calendar review date: review it whenever `@types/node` moves ' +
  'to another major line, and remove it then.'

/** @param {string} date @param {number} days */
const addDays = (date, days) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10)

/** @param {Partial<Parameters<typeof checkAuditExceptions>[0]>} input */
const check = (input) =>
  checkAuditExceptions({
    workspaceText: CURRENT_WORKSPACE,
    policyText: CURRENT_POLICY,
    today: TODAY,
    ...input,
  })

/** @param {ReturnType<typeof checkAuditExceptions>} result @param {RegExp} pattern */
const assertOneError = (result, pattern) => {
  assert.equal(result.errors.length, 1, `expected one error, got ${JSON.stringify(result.errors)}`)
  assert.match(result.errors[0], pattern)
}

describe('checkAuditExceptions', () => {
  test('accepts the current audit.ignore form with a current record', () => {
    assert.deepEqual(check({}), { ids: [RECORDED], errors: [] })
  })

  test('accepts the deprecated auditConfig.ignoreGhsas form with a current record', () => {
    const workspaceText = workspace(`auditConfig:\n  ignoreGhsas:\n    - ${RECORDED}\n`)
    assert.deepEqual(check({ workspaceText }), { ids: [RECORDED], errors: [] })
  })

  test('accepts a workspace without audit settings or advisory IDs', () => {
    assert.deepEqual(check({ workspaceText: workspace('') }), { ids: [], errors: [] })
    assert.deepEqual(
      check({
        workspaceText: workspace(
          '# No audit exception is active.\nupdate:\n  ignoreDeps:\n    - webpack\n',
        ),
      }),
      { ids: [], errors: [] },
    )
  })

  // Each form hides an unrecorded advisory next to the recorded one; the gate must find it
  // under the current key and under the deprecated one.
  for (const [section, list] of AUDIT_KEYS) {
    const hiddenForms = {
      'flow list': `${section}:\n  ${list}: [${RECORDED}, ${UNRECORDED}]\n`,
      'quoted IDs': `${section}:\n  ${list}:\n    - "${RECORDED}"\n    - '${UNRECORDED}'\n`,
      'comment before items': `${section}:\n  ${list}:\n    # why these are ignored\n    - ${RECORDED}\n    - ${UNRECORDED}\n`,
      'trailing comments': `${section}:\n  ${list}:\n    - ${RECORDED} # minimatch\n    - ${UNRECORDED} # other\n`,
      'blank lines': `${section}:\n  ${list}:\n\n    - ${RECORDED}\n   \n    - ${UNRECORDED}\n`,
      'uppercase ID': `${section}:\n  ${list}:\n    - ${RECORDED}\n    - ${UNRECORDED.toUpperCase()}\n`,
      'flow mapping': `${section}: { ${list}: ["${RECORDED}", "${UNRECORDED}"] }\n`,
    }
    for (const [form, auditSettings] of Object.entries(hiddenForms)) {
      test(`finds an unrecorded advisory in ${section}.${list} written as: ${form}`, () => {
        const result = check({ workspaceText: workspace(auditSettings) })
        assert.deepEqual(result.ids, [RECORDED, UNRECORDED].sort())
        assertOneError(
          result,
          new RegExp(`^${UNRECORDED} appears in pnpm-workspace.yaml .* no exception record`),
        )
      })
    }
  }

  test('finds an unrecorded advisory when both keys are set', () => {
    const result = check({
      workspaceText: workspace(
        `audit:\n  ignore:\n    - ${RECORDED}\nauditConfig:\n  ignoreGhsas:\n    - ${UNRECORDED}\n`,
      ),
    })
    assert.deepEqual(result.ids, [RECORDED, UNRECORDED].sort())
    assertOneError(result, new RegExp(`^${UNRECORDED} appears in pnpm-workspace.yaml`))
  })

  test('finds an unrecorded CVE in ignoreCves', () => {
    const result = check({
      workspaceText: workspace(
        `auditConfig:\n  ignoreGhsas:\n    - ${RECORDED}\n  ignoreCves:\n    - cve-2026-12345\n`,
      ),
    })
    assert.deepEqual(result.ids, ['CVE-2026-12345', RECORDED])
    assertOneError(result, /^CVE-2026-12345 appears in pnpm-workspace.yaml .* no exception record/)
  })

  test('matches records regardless of ID case', () => {
    const result = check({
      workspaceText: workspace(`audit:\n  ignore:\n    - ${RECORDED.toUpperCase()}\n`),
    })
    assert.deepEqual(result, { ids: [RECORDED], errors: [] })
  })

  test('fails when an audit section is present but names no recognizable ID', () => {
    for (const auditSettings of [
      'audit:\n  ignore: []\n',
      'audit:\n  ignore:\n    - GHSA-g3hv-75wg\n',
      'audit: { ignore: [] }\n',
      '"audit":\n  "ignore": []\n',
      '# audit.ignore is empty for now.\n',
      'auditConfig:\n  ignoreGhsas: []\n',
      'auditConfig:\n  ignoreGhsas:\n    - GHSA-g3hv-75wg\n',
    ]) {
      assertOneError(
        check({ workspaceText: workspace(auditSettings) }),
        /configures audit .* no GHSA-.* ID was found/,
      )
    }
  })

  test('accepts an audit section that sets only the level, with no ignore list', () => {
    for (const auditSettings of [
      'audit:\n  level: high\n',
      'audit: { level: moderate }\n',
      '# audit level only\naudit:\n  level: high\n',
    ]) {
      assert.deepEqual(check({ workspaceText: workspace(auditSettings) }), { ids: [], errors: [] })
    }
    assertOneError(
      check({ workspaceText: workspace('audit:\n  level: high\n  ignore: []\n') }),
      /configures audit .* no GHSA-.* ID was found/,
    )
  })

  test('does not read a trust-policy exclusion record as an audit exception', () => {
    const policyText = policy(`${record('2026-12-08')}\n\n${TRUST_POLICY_RECORD}`)
    assert.deepEqual(check({ policyText }), { ids: [RECORDED], errors: [] })
    assert.deepEqual(check({ workspaceText: workspace(''), policyText }), {
      ids: [],
      errors: [],
    })
    assertOneError(
      check({ policyText: `# Supply-Chain Security\n\n${TRUST_POLICY_RECORD}\n` }),
      /no exception record under a "Time-Limited" heading/,
    )
  })

  test('requires the record to sit under a Time-Limited heading', () => {
    assertOneError(
      check({ policyText: policy(record('2026-12-08'), '## Audit Notes') }),
      /no exception record under a "Time-Limited" heading/,
    )
  })

  test('accepts a record in a subsection of a Time-Limited heading', () => {
    const policyText = policy(
      `### ${RECORDED} in minimatch\n\n${record('2026-12-08')}`,
      '## Time-Limited Audit Exceptions',
    )
    assert.deepEqual(check({ policyText }), { ids: [RECORDED], errors: [] })
  })

  test('ignores headings inside code fences', () => {
    const policyText = `# Supply-Chain Security\n\n\`\`\`text\n## Time-Limited\n${record('2026-12-08')}\n\`\`\`\n`
    assertOneError(check({ policyText }), /no exception record/)
  })

  test('requires exactly one record and exactly one review date', () => {
    assertOneError(
      check({
        policyText: policy(`${record('2026-12-08')}\n\n## Time-Limited Again\n\n${RECORDED}`),
      }),
      /named in 2 time-limited exception records/,
    )
    assertOneError(
      check({ policyText: policy(`${RECORDED} has no date.`) }),
      /has no "Review this exception by YYYY-MM-DD" date/,
    )
    assertOneError(
      check({
        policyText: policy(`${record('2026-12-08')}\nReview this exception by 2026-12-01.`),
      }),
      /states 2 review dates/,
    )
  })

  test('rejects review dates that are not real calendar dates', () => {
    for (const reviewBy of ['2026-02-30', '2026-13-01', '2026-11-31', '2026-1-5', 'soon']) {
      assertOneError(
        check({ policyText: policy(record(reviewBy)) }),
        /is not a real YYYY-MM-DD calendar date/,
      )
    }
  })

  test('explains a review date that has passed', () => {
    const result = check({ policyText: policy(record(addDays(TODAY, -1))) })
    assertOneError(result, /review date 2026-11-07 has passed \(today is 2026-11-08\)/)
    assert.match(result.errors[0], /publish workflow's verify gate/)
    assert.match(result.errors[0], /Re-run `pnpm audit`/)
    assert.match(result.errors[0], /remove the ignore/)
    assert.match(result.errors[0], /re-approve the exception .* new review date/)
    assert.doesNotMatch(result.errors[0], /expired/)
  })

  test(`limits review dates to ${EXCEPTION_WINDOW_DAYS} days ahead`, () => {
    for (const days of [0, EXCEPTION_WINDOW_DAYS]) {
      assert.deepEqual(check({ policyText: policy(record(addDays(TODAY, days))) }).errors, [])
    }
    for (const reviewBy of [addDays(TODAY, EXCEPTION_WINDOW_DAYS + 1), '2099-01-01']) {
      assertOneError(
        check({ policyText: policy(record(reviewBy)) }),
        new RegExp(`more than ${EXCEPTION_WINDOW_DAYS} days after ${TODAY}`),
      )
    }
  })

  test('rejects an invalid today', () => {
    assert.throws(() => check({ today: '2026-02-30' }), TypeError)
  })
})

describe('findAdvisoryIds', () => {
  test('normalizes case and ignores IDs embedded in longer tokens', () => {
    assert.deepEqual(
      findAdvisoryIds(
        'GHSA-G3HV-75WG-M249 ghsa-g3hv-75wg-m249 cve-2026-1234 xGHSA-aaaa-bbbb-cccc GHSA-aaaa-bbbb-ccccc',
      ),
      ['CVE-2026-1234', RECORDED],
    )
  })
})

describe('crossCheckPnpmAudit', () => {
  test('accepts the IDs the scan found', () => {
    const pnpmOutput = JSON.stringify({
      level: 'moderate',
      ignore: [RECORDED.toUpperCase()],
      ignorePrune: true,
    })
    assert.deepEqual(crossCheckPnpmAudit({ ids: [RECORDED], pnpmOutput }), [])
    assert.deepEqual(crossCheckPnpmAudit({ ids: [], pnpmOutput: '\n' }), [])
  })

  test('accepts the deprecated auditConfig shape', () => {
    const pnpmOutput = JSON.stringify({ ignoreGhsas: [RECORDED] })
    assert.deepEqual(crossCheckPnpmAudit({ ids: [RECORDED], pnpmOutput }), [])
  })

  test('fails when pnpm ignores an ID the scan did not find', () => {
    const errors = crossCheckPnpmAudit({
      ids: [RECORDED],
      pnpmOutput: JSON.stringify({ ignore: [RECORDED, 'CVE-2026-12345'] }),
    })
    assert.equal(errors.length, 1)
    assert.match(errors[0], /pnpm ignores CVE-2026-12345, but pnpm-workspace.yaml does not name it/)
  })

  test('fails when the scan finds an ID pnpm does not ignore', () => {
    const errors = crossCheckPnpmAudit({
      ids: [RECORDED, UNRECORDED],
      pnpmOutput: JSON.stringify({ ignore: [RECORDED] }),
    })
    assert.equal(errors.length, 1)
    assert.match(errors[0], /names GHSA-aaaa-bbbb-cccc, but pnpm does not report it/)
    assert.equal(crossCheckPnpmAudit({ ids: [RECORDED], pnpmOutput: '' }).length, 1)
  })

  test('fails on an ID left under auditConfig when audit.ignore is also set', () => {
    // pnpm reports only audit.ignore when both keys are set, and ignores only those IDs.
    const errors = crossCheckPnpmAudit({
      ids: [RECORDED, UNRECORDED].sort(),
      pnpmOutput: JSON.stringify({ ignore: [RECORDED] }),
    })
    assert.equal(errors.length, 1)
    assert.match(errors[0], /names GHSA-aaaa-bbbb-cccc, .* drops the deprecated auditConfig/)
  })

  test('fails on entries that are not advisory IDs and on unparsable output', () => {
    const [entryError] = crossCheckPnpmAudit({
      ids: [RECORDED],
      pnpmOutput: JSON.stringify({ ignore: [RECORDED, 'bogus'] }),
    })
    assert.match(entryError, /audit ignore entry "bogus", which is not a GHSA or CVE/)
    assert.match(
      crossCheckPnpmAudit({ ids: [], pnpmOutput: '{' })[0],
      /Cannot parse `pnpm config get audit --json` output/,
    )
    assert.match(
      crossCheckPnpmAudit({ ids: [], pnpmOutput: '[]' })[0],
      /pnpm reports audit settings that are not an object/,
    )
  })
})

describe('checkTrustPolicyExclusions', () => {
  const TRUST_POLICY_TEXT = policy(`${record('2026-12-08')}\n\n${TRUST_POLICY_RECORD}`)

  test('finds the entries of a block or flow list, ignoring quotes and comments', () => {
    assert.deepEqual(findTrustPolicyExcludes(CURRENT_WORKSPACE), ['undici-types@6.21.0'])
    assert.deepEqual(
      findTrustPolicyExcludes(
        'trustPolicyExclude:\n  # why\n  - "a@1.0.0" # first\n\n  - \'b@2.0.0\'\nnext: 1\n',
      ),
      ['a@1.0.0', 'b@2.0.0'],
    )
    assert.deepEqual(findTrustPolicyExcludes('trustPolicyExclude: [a@1.0.0, "b@2.0.0"]\n'), [
      'a@1.0.0',
      'b@2.0.0',
    ])
    assert.deepEqual(findTrustPolicyExcludes('trustPolicy: no-downgrade\n'), [])
  })

  test('accepts an exclusion with a record under a Trust-Policy Exclusion heading', () => {
    assert.deepEqual(
      checkTrustPolicyExclusions({
        workspaceText: CURRENT_WORKSPACE,
        policyText: TRUST_POLICY_TEXT,
      }),
      { entries: ['undici-types@6.21.0'], errors: [] },
    )
  })

  test('fails for an exclusion with no record, or a record elsewhere', () => {
    const workspaceText = CURRENT_WORKSPACE.replace(
      '  - undici-types@6.21.0\n',
      '  - undici-types@6.21.0\n  - left-pad@1.3.0\n',
    )
    const { errors } = checkTrustPolicyExclusions({ workspaceText, policyText: TRUST_POLICY_TEXT })
    assert.equal(errors.length, 1)
    assert.match(errors[0], /^left-pad@1\.3\.0 is excluded from trustPolicy .* no record under/)
    const elsewhere = policy(`${record('2026-12-08')}\n\nWe also trust left-pad@1.3.0.`)
    assert.equal(
      checkTrustPolicyExclusions({ workspaceText, policyText: elsewhere }).errors.length,
      2,
      'a mention outside a Trust-Policy Exclusion section is not a record',
    )
    assert.equal(
      checkTrustPolicyExclusions({
        workspaceText: CURRENT_WORKSPACE.replace('undici-types@6.21.0', 'undici-types@6.21.01'),
        policyText: TRUST_POLICY_TEXT,
      }).errors.length,
      1,
      'a record names the exact version',
    )
  })
})

describe('crossCheckPnpmTrustPolicy', () => {
  test('accepts the entries the scan found, and an unset list', () => {
    assert.deepEqual(
      crossCheckPnpmTrustPolicy({
        entries: ['undici-types@6.21.0'],
        pnpmOutput: JSON.stringify(['undici-types@6.21.0']),
      }),
      [],
    )
    assert.deepEqual(crossCheckPnpmTrustPolicy({ entries: [], pnpmOutput: 'undefined\n' }), [])
  })

  test('fails when pnpm and the scan disagree, or pnpm prints something else', () => {
    const errors = crossCheckPnpmTrustPolicy({
      entries: ['a@1.0.0'],
      pnpmOutput: JSON.stringify(['b@2.0.0']),
    })
    assert.equal(errors.length, 2)
    assert.match(errors[0], /pnpm excludes b@2\.0\.0 from trustPolicy, but the scan of/)
    assert.match(errors[1], /names a@1\.0\.0, but pnpm does not exclude it/)
    assert.match(
      crossCheckPnpmTrustPolicy({ entries: [], pnpmOutput: '{}' })[0] ?? '',
      /not a list/,
    )
  })
})
