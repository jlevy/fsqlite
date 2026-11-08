# Supply-Chain Security

fsqlite has no runtime dependencies and allows no dependency lifecycle scripts.
Development dependencies are locked with pnpm and ordinarily must have been published
for at least 14 days before they can enter the lockfile.

## Pinned Tools

- pnpm is pinned by `packageManager` in `package.json`, and the development and release
  Node version by `.nvmrc`.
- The Markdown formatter runs as `uvx --isolated --from flowmark-rs==X.Y.Z`, an exact
  pin with no dependencies of its own.
- CI pins the `uv` release it installs, so the tool that fetches the formatter does not
  float to a release inside the cool-off.
- GitHub Actions are pinned to full commit SHAs, with the release tag in a trailing
  comment. Pin only a release that has itself cleared the cool-off.
- Dependabot (`.github/dependabot.yml`) proposes action and npm updates as pull requests
  after a 14-day cooldown and skips the held upgrades below.
  The cooldown governs only version updates; the frozen install in CI re-verifies any
  proposed lockfile against `minimumReleaseAge` and `trustPolicy`, whoever proposed it.
- Every workflow checks out without persisting credentials and installs with
  `--frozen-lockfile --ignore-scripts`.

## Trust Policy and Build Scripts

`pnpm-workspace.yaml` sets `trustPolicy: no-downgrade`, so pnpm rejects a release whose
provenance or trusted-publisher evidence is weaker than an earlier release of the same
package, both when resolving and when re-verifying the committed lockfile.
Prefer the previous release over an exclusion; the one exclusion is recorded under
“Conditional Trust-Policy Exclusion” below.
`strictDepBuilds: true` makes any dependency build script that `allowBuilds` does not
decide fail the install; `esbuild` and `lefthook` are the only packages in the graph
with install scripts, and both are denied because their platform binaries ship as
optional dependencies.

## Time-Limited Audit Exception

`pnpm audit` reports
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), a
moderate-severity denial of service in `minimatch` before 11.0.1 caused by amplified
glob parts. Here `minimatch` 10.x is reachable only through ESLint and typescript-eslint
(`@typescript-eslint/typescript-estree`), which expand glob patterns from this
repository’s own configuration and command lines; fsqlite ships no runtime dependencies,
so the published package is unaffected.

The first patched release, `minimatch@11.0.1`, was published on 2026-10-27; it and the
later 11.0.x releases are all inside the 14-day cool-off, and no ESLint or
typescript-eslint release accepts `minimatch` 11. Forcing a major-version override under
them would run fresh, untested code in the lint gate, so the advisory is instead ignored
by ID in `pnpm-workspace.yaml` (`audit.ignore`, which replaced the deprecated
`auditConfig.ignoreGhsas` in pnpm 11.16). The maintainer approved this exception on
2026-11-08. No other advisory is ignored, and the lockfile is unchanged by the
exception.

Review this exception by 2026-12-08, or earlier when an ESLint release depends on a
patched `minimatch`. Remove the ignore once the resolved graph contains no affected
version.

`pnpm verify`, which also gates the publish workflow, runs
`scripts/check-supply-chain.mjs`. It finds every GHSA or CVE ID anywhere in
`pnpm-workspace.yaml`, in any letter case or YAML form, and fails unless those IDs are
exactly the ones `pnpm config get audit --json` reports (it skips only this comparison,
with a message, when pnpm is not installed).
pnpm reports the IDs it acts on under `audit.ignore` whichever key set them, so IDs left
under the deprecated `auditConfig.ignoreGhsas` still count; when both keys are set, pnpm
uses only `audit.ignore`, and the gate fails on the IDs it drops.
The gate also fails when an `audit` or `auditConfig` section is present but names no ID.
Each ID needs exactly one record under a “Time-Limited” heading in this document, with a
single review date that is a real calendar date, not in the past, and no more than 90
days ahead.
When a review date passes, re-run `pnpm audit`, then either remove the ignore
or have the maintainer re-approve the exception with a new review date.

## Conditional Trust-Policy Exclusion

`trustPolicy: no-downgrade` rejects `undici-types@6.21.0`, which was published on
2024-11-13 without the provenance that earlier `undici-types` releases carried.
Every `@types/node` 22.x release requires `undici-types ~6.21.0`, and `@types/node`
stays on 22.x to match the Node 22 floor, so the graph cannot avoid this release.
It is a types-only package that was already in the lockfile before the policy was
enabled, so admitting it adds nothing new; fsqlite ships no runtime dependencies, so the
published package is unaffected.

`trustPolicyExclude` in `pnpm-workspace.yaml` therefore admits exactly
`undici-types@6.21.0`, by version, so every other `undici-types` release still faces the
policy. The maintainer approved this exclusion on 2026-11-08. No other package is
excluded.

This exclusion has no calendar review date, because it is needed for as long as
`@types/node` stays on 22.x: review it whenever `@types/node` moves to another major
line, and remove it then.
The review-date rules of `scripts/check-supply-chain.mjs` cover only advisories ignored
for `pnpm audit`, not this exclusion; the frozen install in CI re-verifies the lockfile
against the trust policy on every change.

## Held Upgrades

These newer releases clear the cool-off but are deliberately not taken:

- **TypeScript 7.** TypeScript stays on 6.0.3. TypeScript 7.0 type-checks this
  repository cleanly, but it ships no compiler API (that returns in 7.1),
  typescript-eslint 8.72 accepts only `typescript <6.1.0`, and tsdown generates
  declarations through the TypeScript API. Revisit when typescript-eslint accepts
  TypeScript 7 and 7.1 ships its API.
- **lefthook 2.2.2.** Every release through 2.2.1 was published from GitHub Actions with
  provenance; 2.2.2 was published from a personal account without it, which pnpm’s
  `trustPolicy: no-downgrade` reports as a possible package takeover.
  Stay on 2.2.1 until a later release restores provenance.
- **tsdown 0.23.2.** It requires `rolldown-plugin-dts ^0.29.0-beta.2`, which resolves to
  a prerelease under the cool-off.
  Stay on 0.23.1.
- **pnpm 12.** The Rust rewrite rewrites `pnpm-lock.yaml` even under `--frozen-lockfile`
  and validates workspace settings more strictly.
  Adopting it is a separate review; the pnpm 11 line is still maintained.

## Resolved Exceptions

- `brace-expansion@5.0.8` was pinned on 2026-07-31 inside the cool-off to patch
  [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg). On
  2026-11-08 the exception and its override were removed: `minimatch`’s own `^5.0.5`
  range now resolves `brace-expansion@5.0.12`, which has cleared the cool-off and also
  patches GHSA-rgw5-rvv9-x895, GHSA-6j4f-fj2g-mc7p, GHSA-qhr7-859c-m2p7, and
  GHSA-q2hr-2g5m-vwhr.
- `tryscript` moved from 0.1.7 to 0.3.1 on 2026-11-08 so the graph resolves `zod@4.6.6`,
  which patches GHSA-mrhx-c7xc-m3w5; `zod` 3.x has no patched release.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
