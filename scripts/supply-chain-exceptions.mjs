// Rules for time-limited audit exceptions, kept free of I/O so that
// supply-chain-exceptions.test.mjs can cover each one with fixtures.
// scripts/check-supply-chain.mjs applies them to the repository files.

/**
 * The furthest ahead a review date may be set, so every exception is re-approved at
 * least this often.
 */
export const EXCEPTION_WINDOW_DAYS = 90

const DAY_MS = 24 * 60 * 60 * 1000
const ADVISORY_ID_SOURCE = 'GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}|CVE-[0-9]{4}-[0-9]{4,}'
// Any GHSA or CVE ID in the text, in any case, not embedded in a longer token.
const ADVISORY_ID = new RegExp(`(?<![0-9a-z])(?:${ADVISORY_ID_SOURCE})(?![0-9a-z])`, 'gi')
const EXACT_ADVISORY_ID = new RegExp(`^(?:${ADVISORY_ID_SOURCE})$`, 'i')
// An audit settings section: the `audit` key pnpm 11.16 introduced, as a block or flow
// mapping key, quoted or not, or `audit.ignore`; or the deprecated `auditConfig`, whose
// `ignoreGhsas` pnpm still honors when `audit.ignore` is unset (pnpm 11 no longer reads
// `ignoreCves`). Mentions in comments count too.
const AUDIT_SECTION =
  /(?:^|[{,])\s*["']?audit["']?\s*:|audit\.ignore|audit-?config|ignore-?ghsas|ignore-?cves/im
const TIME_LIMITED_HEADING = /time[-\s]limited/i
const REVIEW_PHRASE = /review\s+this\s+exception\s+by\b/gi
const REVIEW_DATE = /review\s+this\s+exception\s+by\s+([0-9]{4}-[0-9]{2}-[0-9]{2})(?![0-9])/i
const REVIEW_TARGET = /review\s+this\s+exception\s+by\s+([^\s,;:)]*)/i
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const CODE_FENCE = /^\s*(?:```|~~~)/

/**
 * Normalizes an advisory ID to its canonical spelling: GHSA IDs have an uppercase prefix
 * and a lowercase body, and CVE IDs are uppercase.
 * @param {string} id
 */
export const normalizeAdvisoryId = (id) => {
  const upper = id.toUpperCase()
  return upper.startsWith('GHSA-') ? `GHSA-${upper.slice('GHSA-'.length).toLowerCase()}` : upper
}

/**
 * Every GHSA or CVE ID in the text, normalized, deduplicated, and sorted. Scanning the
 * whole text, rather than parsing YAML, keeps every list form, quoting style, comment,
 * and spelling in view.
 * @param {string} text
 */
export const findAdvisoryIds = (text) =>
  [...new Set([...text.matchAll(ADVISORY_ID)].map((match) => normalizeAdvisoryId(match[0])))].sort()

/** @param {string} text */
const isCalendarDate = (text) => {
  if (!ISO_DATE.test(text)) {
    return false
  }
  const time = Date.parse(`${text}T00:00:00Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === text
}

/** @param {string} date @param {number} days */
const addDays = (date, days) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)

/**
 * Splits Markdown into one section per heading, each marked by whether that heading or
 * an enclosing one says "Time-Limited". Headings inside code fences are ignored.
 * @param {string} markdown
 */
const policySections = (markdown) => {
  /** @type {{ level: number, title: string }[]} */
  const headings = []
  /** @type {{ timeLimited: boolean, lines: string[] }[]} */
  const sections = []
  let inFence = false
  for (const line of markdown.split(/\r?\n/)) {
    if (CODE_FENCE.test(line)) {
      inFence = !inFence
    }
    const heading = inFence ? null : HEADING.exec(line)
    if (heading) {
      const level = heading[1].length
      while (headings.length > 0 && headings[headings.length - 1].level >= level) {
        headings.pop()
      }
      headings.push({ level, title: heading[2] })
      sections.push({
        timeLimited: headings.some(({ title }) => TIME_LIMITED_HEADING.test(title)),
        lines: [line],
      })
    } else {
      sections[sections.length - 1]?.lines.push(line)
    }
  }
  return sections.map(({ timeLimited, lines }) => ({ timeLimited, text: lines.join('\n') }))
}

/**
 * @param {string} id
 * @param {string} reviewBy
 * @param {string} today
 */
const reviewDatePassedMessage = (id, reviewBy, today) =>
  `${id}: the exception's review date ${reviewBy} has passed (today is ${today}). ` +
  "Until it is resolved, pnpm verify fails, including the publish workflow's verify gate, " +
  'so releases are blocked too. Re-run `pnpm audit`. If the advisory no longer applies, ' +
  'remove the ignore from pnpm-workspace.yaml and move the record to "Resolved Exceptions" ' +
  'in SUPPLY-CHAIN-SECURITY.md; otherwise have the maintainer re-approve the exception ' +
  `there with a new review date at most ${EXCEPTION_WINDOW_DAYS} days out.`

/**
 * Checks that every advisory ID in pnpm-workspace.yaml has exactly one exception record
 * under a "Time-Limited" heading of SUPPLY-CHAIN-SECURITY.md, and that the record's review
 * date is a real calendar date, not in the past, and at most EXCEPTION_WINDOW_DAYS ahead.
 * The ID scan is key-agnostic, so IDs under `audit.ignore`, the deprecated
 * `auditConfig.ignoreGhsas`, or anywhere else in the file all count. The date rules apply
 * only to these advisory IDs; other records, such as a `trustPolicyExclude` entry, are
 * not exceptions to them.
 * @param {{ workspaceText: string, policyText: string, today: string }} input
 *   `today` is a UTC `YYYY-MM-DD` date.
 * @returns {{ ids: string[], errors: string[] }}
 */
export const checkAuditExceptions = ({ workspaceText, policyText, today }) => {
  if (!isCalendarDate(today)) {
    throw new TypeError(`today must be a YYYY-MM-DD calendar date, not ${JSON.stringify(today)}`)
  }
  const ids = findAdvisoryIds(workspaceText)
  /** @type {string[]} */
  const errors = []
  if (ids.length === 0 && AUDIT_SECTION.test(workspaceText)) {
    errors.push(
      'pnpm-workspace.yaml configures audit (or the deprecated auditConfig), but no ' +
        'GHSA-xxxx-xxxx-xxxx or CVE-YYYY-NNNN advisory ID was found in it; write each ' +
        'ignored advisory by ID under audit.ignore, or remove the empty audit settings.',
    )
  }
  const records = policySections(policyText).filter(({ timeLimited }) => timeLimited)
  const latestReviewBy = addDays(today, EXCEPTION_WINDOW_DAYS)
  for (const id of ids) {
    const matching = records.filter(({ text }) => findAdvisoryIds(text).includes(id))
    if (matching.length !== 1) {
      errors.push(
        matching.length === 0
          ? `${id} appears in pnpm-workspace.yaml but has no exception record under a ` +
              '"Time-Limited" heading in SUPPLY-CHAIN-SECURITY.md.'
          : `${id} is named in ${matching.length} time-limited exception records in ` +
              'SUPPLY-CHAIN-SECURITY.md; keep exactly one.',
      )
      continue
    }
    const [{ text }] = matching
    const reviewPhrases = text.match(REVIEW_PHRASE)?.length ?? 0
    if (reviewPhrases !== 1) {
      errors.push(
        reviewPhrases === 0
          ? `${id} exception record has no "Review this exception by YYYY-MM-DD" date.`
          : `${id} exception record states ${reviewPhrases} review dates; keep exactly one.`,
      )
      continue
    }
    const reviewBy = REVIEW_DATE.exec(text)?.[1]
    if (reviewBy === undefined || !isCalendarDate(reviewBy)) {
      const stated = reviewBy ?? REVIEW_TARGET.exec(text)?.[1] ?? ''
      errors.push(
        `${id} exception review date ${JSON.stringify(stated)} is not a real YYYY-MM-DD calendar date.`,
      )
    } else if (reviewBy < today) {
      errors.push(reviewDatePassedMessage(id, reviewBy, today))
    } else if (reviewBy > latestReviewBy) {
      errors.push(
        `${id} exception review date ${reviewBy} is more than ${EXCEPTION_WINDOW_DAYS} days ` +
          `after ${today}; set a review date no later than ${latestReviewBy}.`,
      )
    }
  }
  return { ids, errors }
}

/** The command whose output crossCheckPnpmAudit reads. */
export const PNPM_AUDIT_COMMAND = ['config', 'get', 'audit', '--json']
const PNPM_AUDIT_COMMAND_TEXT = `pnpm ${PNPM_AUDIT_COMMAND.join(' ')}`

/**
 * Compares the advisories pnpm actually ignores, as printed by
 * `pnpm config get audit --json`, with the IDs the text scan found, so an ignore that
 * pnpm reads from somewhere the scan does not look, or in a form it does not recognize,
 * still fails the gate. Since 11.23, pnpm reports the effective `audit` section whichever
 * key set it: `{ "ignore": [...] }` for `audit.ignore` or the deprecated
 * `auditConfig.ignoreGhsas`, and `audit.ignore` alone when both are set. Every array in
 * the output is read as a list of advisory IDs, so the deprecated `auditConfig` shape
 * (`ignoreGhsas`, `ignoreCves`) is accepted too; other values, such as `level`, are not.
 * @param {{ ids: string[], pnpmOutput: string }} input
 * @returns {string[]} errors
 */
export const crossCheckPnpmAudit = ({ ids, pnpmOutput }) => {
  const output = pnpmOutput.trim()
  /** @type {unknown} */
  let config = {}
  if (output !== '' && output !== 'undefined') {
    try {
      config = JSON.parse(output)
    } catch {
      return [`Cannot parse \`${PNPM_AUDIT_COMMAND_TEXT}\` output: ${output}`]
    }
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return [`pnpm reports audit settings that are not an object: ${output}`]
  }
  /** @type {string[]} */
  const errors = []
  const reported = new Set()
  for (const [key, value] of Object.entries(config)) {
    if (!Array.isArray(value)) {
      continue
    }
    for (const entry of value) {
      if (typeof entry === 'string' && EXACT_ADVISORY_ID.test(entry.trim())) {
        reported.add(normalizeAdvisoryId(entry.trim()))
      } else {
        errors.push(
          `pnpm reports audit ${key} entry ${JSON.stringify(entry)}, which is not a GHSA or ` +
            'CVE advisory ID.',
        )
      }
    }
  }
  const scanned = new Set(ids)
  for (const id of [...reported].sort()) {
    if (!scanned.has(id)) {
      errors.push(
        `pnpm ignores ${id}, but pnpm-workspace.yaml does not name it; record and configure ` +
          'every ignored advisory in pnpm-workspace.yaml.',
      )
    }
  }
  for (const id of ids) {
    if (!reported.has(id)) {
      errors.push(
        `pnpm-workspace.yaml names ${id}, but pnpm does not report it as ignored; list it ` +
          'under audit.ignore (pnpm drops the deprecated auditConfig when audit.ignore is ' +
          'set), or remove the ID if it appears only in a comment.',
      )
    }
  }
  return errors
}
