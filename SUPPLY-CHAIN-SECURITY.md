# Supply-Chain Security

fsqlite has no runtime dependencies and allows no dependency lifecycle scripts.
Development dependencies are locked with pnpm and ordinarily must have been published
for at least 14 days before they can enter the lockfile.

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
is instead ignored by ID in `pnpm-workspace.yaml` (`auditConfig.ignoreGhsas`). The
maintainer approved this exception on 2026-11-08. No other advisory is ignored, and the
lockfile is unchanged by the exception.

Review this exception by 2026-12-08, or earlier when an ESLint release depends on a
patched `minimatch`. Remove the ignore once the resolved graph contains no affected
version.

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
