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

## Time-Limited Audit Exception

`pnpm audit` reports
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), a
moderate-severity denial of service in `minimatch` before 11.0.1 caused by amplified
glob parts. Here `minimatch` 10.x is reachable only through ESLint, which expands glob
patterns from this repository’s own configuration and command lines; fsqlite ships no
runtime dependencies, so the published package is unaffected.

The only patched release, `minimatch@11.0.1`, was published on 2026-10-27, inside the
14-day cool-off, and no ESLint release accepts `minimatch` 11. Forcing a major-version
override under ESLint would run fresh, untested code in the lint gate, so the advisory
is instead ignored by ID in `pnpm-workspace.yaml` (`audit.ignore`; pnpm 11.16 renamed
the deprecated `auditConfig.ignoreGhsas`). The maintainer approved this exception on
2026-11-08. No other advisory is ignored, and the lockfile is unchanged by the
exception.

Review this exception by 2026-12-08, or earlier when an ESLint release depends on a
patched `minimatch`. Remove the ignore once the resolved graph contains no affected
version.

## Trust Policy and Build Scripts

`pnpm-workspace.yaml` sets `trustPolicy: no-downgrade`, so pnpm rejects a release whose
provenance or trusted-publisher evidence is weaker than an earlier release of the same
package, both when resolving and when re-verifying the committed lockfile.
Prefer the previous release over an exclusion.
`strictDepBuilds: true` makes any dependency build script that `allowBuilds` does not
decide fail the install; `esbuild` and `lefthook` are the only packages in the graph
with install scripts, and both are denied because their platform binaries ship as
optional dependencies.

One exclusion is listed, and it needs maintainer sign-off before this policy change
lands: `trustPolicyExclude` admits exactly `undici-types@6.21.0`. Every `@types/node`
22.x release requires `undici-types ~6.21.0`, and 6.21.0 (2024-11-13) was published
without provenance after earlier releases carried it.
It is a types-only package that was already in the lockfile before the policy was
enabled, so the exclusion admits nothing new.
Review it when `@types/node` leaves the 22 line, and remove it then.

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
  2026-11-08 the override moved to `brace-expansion@5.0.12`, which has cleared the
  cool-off and also patches GHSA-rgw5-rvv9-x895, GHSA-6j4f-fj2g-mc7p,
  GHSA-qhr7-859c-m2p7, and GHSA-q2hr-2g5m-vwhr, and the exception and override were
  removed because `minimatch`’s own `^5.0.5` range now resolves that release.
- `tryscript` moved from 0.1.7 to 0.3.1 on 2026-11-08 so the graph resolves `zod@4.6.6`,
  which patches GHSA-mrhx-c7xc-m3w5; `zod` 3.x has no patched release.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
