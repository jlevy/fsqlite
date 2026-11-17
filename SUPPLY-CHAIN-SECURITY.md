# Supply-Chain Security

fsqlite has no runtime dependencies and allows no dependency lifecycle scripts.
Development dependencies are locked with pnpm and ordinarily must have been published
for at least 14 days before they can enter the lockfile.
First-party packages are exempt, as “First-Party Packages” below records.

## Pinned Tools

- pnpm is pinned by `packageManager` in `package.json`, and the development and release
  Node version by `.nvmrc`.
- The Markdown formatter runs as `uvx --isolated --no-build --from flowmark-rs==X.Y.Z`.
  It uses a wheel of the pinned release and has no dependencies of its own.
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

`pnpm verify` checks the configuration pnpm reports.
It requires a strict cool-off of at least 14 days that exempts only the recorded
first-party packages, publish timestamps, lockfile policy verification, the trust policy
and build-script controls described above, registry-only transitive sources, and engine
checks.

## First-Party Packages

On 2026-11-17 the maintainer decided that first-party packages have no cool-off.
A package is first-party when the maintainer’s registry account publishes it: npm user
`ojoshe` (the package’s `maintainers`) or PyPI user `jlevy` (its owner), with the source
on GitHub under `jlevy`. Author names and repository URLs in package metadata are not
evidence, since any uploader can set them.
The list below is closed: only an edit by the maintainer adds a name, after checking the
registry account. The dependencies of a first-party package, direct and transitive, are
exempt too. Direct third-party dependencies keep the 14-day cool-off.
None of these packages is a runtime dependency: fsqlite ships with no runtime
dependencies, and tbd is a developer-time tool.

The first-party packages are:

- `get-tbd` on npm
- `tryscript` on npm
- `softschema` on npm and PyPI
- `flowmark` on PyPI
- `flowmark-rs` on PyPI

`get-tbd` is the tbd CLI. Neither PyPI-only name is first-party on npm: the npm package
`flowmark` is the registry’s placeholder, and `flowmark-rs` is not registered on npm.

Each tool expresses the exemption differently:

- **pnpm.** `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` lists the first-party
  packages that fsqlite installs through pnpm, today only `tryscript`. pnpm matches an
  entry by package name, so it exempts that package and not its dependencies.
  When a first-party package’s lockfile entry pulls a dependency that is inside the
  cool-off, list that dependency too, as `name@x.y.z` so that only that version is
  exempt, with a comment that names its first-party parent.
  Record it directly under this heading as the line “- `name@x.y.z` on npm, a dependency
  of `parent`”, where `parent` is a first-party npm package listed above; any
  description goes in a sentence of its own.
  `pnpm install --frozen-lockfile --ignore-scripts` re-verifies the lockfile against the
  policy. On 2026-11-17 every entry had cleared the cool-off, so no dependency is listed.
- **uv.** fsqlite sets no uv cool-off, and runs the formatter at an exact version.
  Where a developer or CI sets one, such as `UV_EXCLUDE_NEWER="14 days"`, pass
  `--exclude-newer-package flowmark-rs=false` to exempt the package, or set
  `exclude-newer-package = { flowmark-rs = false }` under `[tool.uv]` in
  `pyproject.toml` or at the top level of `uv.toml`. A date in place of `false` gives
  the package its own cutoff; `true` is rejected.
  `uvx`, as this repository runs it, reads the user’s `~/.config/uv/uv.toml`, the file
  that `UV_CONFIG_FILE` names, or a file passed with `--config-file`, not a `uv.toml` in
  the working directory, and uv documents no environment variable for this setting.
  These are inherited: a stricter `exclude-newer` there applies to the formatter too,
  and stops it, unless that file also exempts the package.
  This was verified with uv 0.11.32.
- **tbd launcher fallback.** The hook launchers’ npx fallback runs the pinned `get-tbd`
  release with `--ignore-scripts`, `--registry=https://registry.npmjs.org/`, and a
  dedicated `--cache`. No lockfile pins get-tbd’s third-party dependencies there, so the
  launcher first reads the pin’s own publish time from the public registry
  (`npm view --registry=https://registry.npmjs.org/ get-tbd@<pin> time --json`) and
  passes it as `--before`: the pin and the dependency versions it resolved to at release
  install with no cool-off, and nothing published later does.
  If that lookup fails, the launcher stops without running the fallback.
  Command-line flags take precedence over environment variables and `.npmrc` files, so
  an inherited `registry`, `before`, or `ignore-scripts` setting does not change these.
  The dedicated cache is trust on first use: npx reuses an exact-spec install without
  verifying it again, and looks in the project’s `node_modules` and the global prefix
  before the cache.

`scripts/check-supply-chain.mjs` fails unless every `minimumReleaseAgeExclude` entry is
an exact package name, optionally with exact versions, and has its record directly under
this heading.
A record is a whole line in one of two forms and nothing else: “- `name` on
npm” (or “on npm and PyPI”) for a first-party package, and “- `name@x.y.z` on npm, a
dependency of `parent`” for exact versions of a dependency, where `parent` has a
first-party record. Lines in code fences, indented code, or HTML comments, or under any
other heading, are not records.
The gate rejects glob and `!` patterns, fails if pnpm reports any exclusion that
`pnpm-workspace.yaml` does not list, and fails if pnpm does not apply one it lists.

## Release Controls

- No npm token is stored in GitHub.
  Releases use npm trusted publishing: the Publish workflow’s `stage` job alone gets
  `id-token: write`, and only inside the GitHub environment `npm`, which accepts only
  `v*` tags.
- The `build` job, which installs and runs the development dependencies, has no OIDC
  permission. It runs `pnpm verify`, packs the tarball, and smoke-tests that exact file;
  the `stage` job checks out and installs nothing and stages that tarball.
- `npm stage publish` requires provenance, and a staged version stays private until an
  owner approves it with `npm stage approve`, which requires 2FA.
- CI runs `pnpm audit --audit-level=moderate` and `pnpm audit signatures` on every
  change and weekly.

The [release runbook](docs/releasing.md) has the one-time setup and the release steps.

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
exactly the ones `pnpm config get audit --json` reports.
pnpm reports the IDs it acts on under `audit.ignore` whichever key set them, so IDs left
under the deprecated `auditConfig.ignoreGhsas` still count; when both keys are set, pnpm
uses only `audit.ignore`, and the gate fails on the IDs it drops.
The gate also fails when an audit ignore list (`audit.ignore`, or the deprecated
`ignoreGhsas` or `ignoreCves`) is present but names no ID; an `audit` section that only
sets `level` names no advisory and passes.
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
The gate does require every `trustPolicyExclude` entry, at its exact version, to be
named under a heading that says “Trust-Policy Exclusion” in this document, and it fails
unless those entries are exactly the ones `pnpm config get trustPolicyExclude --json`
reports.

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
