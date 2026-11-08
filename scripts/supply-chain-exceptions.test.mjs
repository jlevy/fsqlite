import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  EXCEPTION_WINDOW_DAYS,
  checkAuditExceptions,
  crossCheckPnpmAuditConfig,
  findAdvisoryIds,
} from './supply-chain-exceptions.mjs'

const TODAY = '2026-11-08'
const RECORDED = 'GHSA-g3hv-75wg-m249'
const UNRECORDED = 'GHSA-aaaa-bbbb-cccc'

/** @param {string} auditConfig */
const workspace = (auditConfig) =>
  `packages:\n  - packages/*\n\nminimumReleaseAge: 20160\n# Time-limited audit exception.\n${auditConfig}`

/** The form pnpm-workspace.yaml uses today. */
const CURRENT_WORKSPACE = workspace(`auditConfig:\n  ignoreGhsas:\n    - ${RECORDED}\n`)

/** @param {string} body @param {string} [heading] */
const policy = (body, heading = '## Time-Limited Audit Exception') =>
  `# Supply-Chain Security\n\nIntro.\n\n${heading}\n\n${body}\n\n` +
  '## Resolved Exceptions\n\n- GHSA-zzzz-zzzz-zzzz was removed; Review this exception by 2020-01-01.\n'

/** @param {string} reviewBy @param {string} [id] */
const record = (reviewBy, id = RECORDED) =>
  `\`pnpm audit\` reports [${id}](https://github.com/advisories/${id}).\n\n` +
  `Review this exception by ${reviewBy}, or earlier when a patched release clears the cool-off.`

const CURRENT_POLICY = policy(record('2026-12-08'))

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
  test('accepts the current block-list form with a current record', () => {
    assert.deepEqual(check({}), { ids: [RECORDED], errors: [] })
  })

  test('accepts a workspace without auditConfig or advisory IDs', () => {
    assert.deepEqual(check({ workspaceText: workspace('') }), { ids: [], errors: [] })
  })

  // Each form hides an unrecorded advisory next to the recorded one; the gate must find it.
  const hiddenForms = {
    'flow list': `auditConfig:\n  ignoreGhsas: [${RECORDED}, ${UNRECORDED}]\n`,
    'quoted IDs': `auditConfig:\n  ignoreGhsas:\n    - "${RECORDED}"\n    - '${UNRECORDED}'\n`,
    'comment before items': `auditConfig:\n  ignoreGhsas:\n    # why these are ignored\n    - ${RECORDED}\n    - ${UNRECORDED}\n`,
    'trailing comments': `auditConfig:\n  ignoreGhsas:\n    - ${RECORDED} # minimatch\n    - ${UNRECORDED} # other\n`,
    'blank lines': `auditConfig:\n  ignoreGhsas:\n\n    - ${RECORDED}\n   \n    - ${UNRECORDED}\n`,
    'uppercase ID': `auditConfig:\n  ignoreGhsas:\n    - ${RECORDED}\n    - ${UNRECORDED.toUpperCase()}\n`,
    'flow mapping': `auditConfig: { ignoreGhsas: ["${RECORDED}", "${UNRECORDED}"] }\n`,
  }
  for (const [form, auditConfig] of Object.entries(hiddenForms)) {
    test(`finds an unrecorded advisory written as: ${form}`, () => {
      const result = check({ workspaceText: workspace(auditConfig) })
      assert.deepEqual(result.ids, [RECORDED, UNRECORDED].sort())
      assertOneError(
        result,
        new RegExp(`^${UNRECORDED} appears in pnpm-workspace.yaml .* no exception record`),
      )
    })
  }

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
      workspaceText: workspace(`auditConfig:\n  ignoreGhsas:\n    - ${RECORDED.toUpperCase()}\n`),
    })
    assert.deepEqual(result, { ids: [RECORDED], errors: [] })
  })

  test('fails when auditConfig is present but names no recognizable ID', () => {
    for (const auditConfig of [
      'auditConfig:\n  ignoreGhsas: []\n',
      'auditConfig:\n  ignoreGhsas:\n    - GHSA-g3hv-75wg\n',
    ]) {
      assertOneError(check({ workspaceText: workspace(auditConfig) }), /no GHSA-.* ID was found/)
    }
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

describe('crossCheckPnpmAuditConfig', () => {
  test('accepts the IDs the scan found', () => {
    const pnpmOutput = JSON.stringify({
      ignoreGhsas: [RECORDED.toUpperCase()],
      ignoreUnfixable: true,
    })
    assert.deepEqual(crossCheckPnpmAuditConfig({ ids: [RECORDED], pnpmOutput }), [])
    assert.deepEqual(crossCheckPnpmAuditConfig({ ids: [], pnpmOutput: '\n' }), [])
  })

  test('fails when pnpm ignores an ID the scan did not find', () => {
    const errors = crossCheckPnpmAuditConfig({
      ids: [RECORDED],
      pnpmOutput: JSON.stringify({ ignoreGhsas: [RECORDED], ignoreCves: ['CVE-2026-12345'] }),
    })
    assert.equal(errors.length, 1)
    assert.match(errors[0], /pnpm ignores CVE-2026-12345, but pnpm-workspace.yaml does not name it/)
  })

  test('fails when the scan finds an ID pnpm does not ignore', () => {
    const errors = crossCheckPnpmAuditConfig({
      ids: [RECORDED, UNRECORDED],
      pnpmOutput: JSON.stringify({ ignoreGhsas: [RECORDED] }),
    })
    assert.equal(errors.length, 1)
    assert.match(errors[0], /names GHSA-aaaa-bbbb-cccc, but pnpm does not report it/)
    assert.equal(crossCheckPnpmAuditConfig({ ids: [RECORDED], pnpmOutput: '' }).length, 1)
  })

  test('fails on entries that are not advisory IDs and on unparsable output', () => {
    const [entryError] = crossCheckPnpmAuditConfig({
      ids: [RECORDED],
      pnpmOutput: JSON.stringify({ ignoreGhsas: [RECORDED, 'bogus'] }),
    })
    assert.match(entryError, /auditConfig\.ignoreGhsas entry "bogus", which is not a GHSA or CVE/)
    assert.match(
      crossCheckPnpmAuditConfig({ ids: [], pnpmOutput: '{' })[0],
      /Cannot parse `pnpm config get auditConfig --json` output/,
    )
  })
})
