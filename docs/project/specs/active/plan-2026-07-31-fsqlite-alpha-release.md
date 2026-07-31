# Feature: fsqlite Alpha Release

**Date:** 2026-07-31

**Author:** Joshua Levy (with LLM assistance)

**Status:** Draft

## Overview

Bring the `fsqlite` package out of the `finterm-main` monorepo into this standalone repo
(`github.com/jlevy/fsqlite`) and publish an alpha to npm.

The package is filesystem-friendly concurrent SQLite: immutable snapshot-publish plus
transaction-envelope changesets behind an NFS-safe `mkdir` lease, with an easy-local
`DirectStore` mode, over plain SQLite files, server-free, on any filesystem.

The source arrives in unusually good shape.
A review of all 57 files found **zero** imports escaping the package, zero absolute
paths, zero `process.env` reads, and zero sibling-package references in `src/`,
`workers/`, or `test/`. The suite passes 75/75 in under seven seconds, and copying the
package verbatim outside the monorepo with no installs still passes both the unit suite
and the 24 CLI goldens.

The work is therefore not disentanglement.
It is three things: rebuild a toolchain that currently borrows from the monorepo root,
fix a set of genuine data-loss defects the review surfaced, and raise the docs and
public API to the bar of a package other people are expected to depend on.

## Goals

- A standalone repo that builds, typechecks, lints, tests, and publishes with no
  reference to any other repository.
- The full lint, format, type, and supply-chain floor from the tbd guidelines, enforced
  in CI and in pre-push hooks rather than by convention.
- The three high-severity correctness defects fixed, each with a regression test.
- An honest `engines` range, so no consumer can install a version that cannot load.
- Docs fit for a public repo: no monorepo residue, no internal tracker IDs, no
  references to unpublished internal documents.
- A published `0.1.0-alpha.1` on npm under the `alpha` dist-tag, installable and usable
  from a clean project.

## Non-Goals

- **Re-opening the package manager decision.** pnpm is committed.
  See Design.
- **A 1.0 release, or any stability promise.** Alpha exists so the format and API can
  still move.
- **The real cross-host NFS/EFS concurrency gate.** It remains the headline honesty gap
  and stays disclosed, not closed.
  Tracked as post-alpha.
- **Windows support.** The CLI golden harness uses `#!/bin/sh` wrappers and the test
  glob relies on POSIX expansion.
  The package targets POSIX shared filesystems for alpha.
- **Migrating off `node --test` to vitest.** The zero-dependency test story is a product
  property, not an accident.
- **Building the second package.** The layout leaves room for one; nothing beyond
  `packages/fsqlite` is built in this cycle.
- **Consumer integration.** Wiring any downstream application onto `fsqlite` is out of
  scope and stays in that application’s own repo.

## Background

`fsqlite` was built inside `finterm-main` as `packages/fsqlite`, deliberately excluded
from the pnpm workspace (`'!packages/fsqlite'`) so its devDeps stayed out of the
monorepo lockfile. It was always intended to be extracted; this spec is that extraction.

Because of that exclusion, the package has **never had a lockfile** and its seven
devDependencies have never been resolved.
Every tool it declares is currently resolved from the monorepo root, including through a
hardcoded path into the pnpm virtual store.
The first `pnpm install` in this repo is therefore a genuinely new resolution, not a
re-hydration, and is the single riskiest step in the plan.

The npm name `fsqlite` is unclaimed (the registry returns 404).

## Design

### Toolchain: pnpm, Node, `node --test`, tsdown

Decided and not revisited.
The deciding evidence: Bun cannot resolve `node:sqlite` at all, which is the module the
entire storage engine is built on.
Beyond that, under `bun test` `process.execPath` is the Bun binary, so the multi-process
crash, kill, and fencing tests would silently spawn Bun children instead of Node ones,
and would keep passing while testing the wrong engine.
A concurrency suite that misreports which engine it exercised is worse than one that
fails.

| Layer | Choice |
| --- | --- |
| Package manager | pnpm 11.x, newest release clearing the 14-day cool-off |
| Runtime | Node, floor set by the `node:sqlite` surface actually imported |
| Test runner | `node --test` with native type-stripping |
| CLI goldens | tryscript, resolved from devDeps rather than a network runner |
| Build | tsdown, ESM plus `.d.mts`, validated by publint |
| Lint and format | ESLint flat config plus Prettier, per lint-format Profile A |
| Markdown | flowmark |
| Hooks | lefthook, auto-fix at commit, full verify at push |
| Release | Tag-triggered publish with npm provenance, no Changesets |

One deviation from the guidelines is deliberate: `moduleResolution` is `NodeNext`, not
`Bundler`, because this package’s `.ts` import specifiers are resolved by Node at
runtime rather than by a bundler.

### Repo layout: workspace from day one

The repo uses a `packages/` workspace with `packages/fsqlite` as the single published
package, per the pnpm guideline’s “start mono, stay sane” advice.

The case for it is concrete rather than speculative.
The format spec already commits to shipping **conformance fixtures and a verifier**, a
deliverable that is naturally its own package: it is consumed by other implementations,
versioned against the format rather than against the Node library, and should not ship
inside the runtime tarball.
The design also anticipates a rebaser adapter, which would carry dependencies the core
package refuses to take.
Converting a flat repo to a workspace later means moving every path, rewriting CI, and
breaking every doc link, whereas paying for the structure now is a root `package.json`
and `-F` filters in a few scripts.

The one real cost is the README split: GitHub renders the repo root, npm renders the
package. Resolve it by making `packages/fsqlite/README.md` canonical (it must be in the
tarball) and keeping the root `README.md` a short repo overview that links to it, rather
than maintaining two copies that drift.

Format-level and research documentation lives in the repo-root `docs/`, since it spans
implementations rather than belonging to the Node library.
The package README links to it with absolute URLs, which is required in any case because
`files` excludes `docs/` from the published tarball.

```
README.md                    short repo overview, links to the package
LICENSE
package.json                 private root, workspace scripts
pnpm-workspace.yaml
docs/
  fsqlite-design.md
  fsql-format-spec.md
  upstream-source-confirmations.md
  qa-runbook.md
  roadmap.md
  research/research-2026-06-06-portable-concurrent-sqlite.md
packages/
  fsqlite/
    README.md                canonical, npm landing page
    CHANGELOG.md
    package.json
    src/ test/ workers/ examples/ scripts/
```

The repo keeps a `pnpm-workspace.yaml` for the workspace globs, which is also where pnpm
11 reads `minimumReleaseAge`; its default is only one day.

### Supply-chain posture

A package with zero runtime dependencies can credibly run **no lifecycle scripts at
all**. That is a real security property and should be stated in the README, not just
configured:

```yaml
# pnpm-workspace.yaml
packages:
  - packages/*
minimumReleaseAge: 20160 # 14 days in minutes
blockExoticSubdeps: true
allowBuilds: [] # zero runtime deps: nothing needs to build
```

### The `engines` defect

`src/driver.ts:15` is a static named import:

```ts
import { DatabaseSync, constants, backup } from 'node:sqlite'
```

ESM resolves named imports at link time, so on a Node where `node:sqlite` exists but
does not export `backup`, the entire module graph fails to load.
This is not a lazy runtime failure that a capability check can absorb, and in fact the
`typeof backup === 'function'` probe at `driver.ts:122` is unreachable on exactly the
versions it was written to defend.

Three independent floors are in play, and the currently declared range satisfies only
the weakest:

| Requirement | Introduced | Status |
| --- | --- | --- |
| `node:sqlite` unflagged | 22.13.0 / 23.4.0 | matches declared `engines` |
| `backup` export | later than 22.13 | **not satisfied**, hard load failure |
| Unflagged `.ts` type-stripping | 22.18.0 | required to run from source |

The exact release that added `backup` must be confirmed against the Node changelog
before the floor is set.
CI must then pin an explicit job at the declared floor, because `node-version: 22`
resolves to latest 22.x and hides precisely this class of bug.

### Correctness defects to fix

Three high-severity findings, all in the recovery and durability paths that the
package’s value proposition rests on:

- **`repair()` destroys the store when it cannot repair it.** `snapshotStore.ts:759-767`
  unlinks each snapshot as it fails integrity check, then throws when none is clean, by
  which point every snapshot is gone.
  A partially readable snapshot is often salvageable by hand; this removes that option
  and undercuts the R1 bounded-loss guarantee the README advertises.
  The scan must be non-destructive, deleting only after a good version is identified.

- **`repair()` takes no lock.** Unlike `init()` and `reconcile()`, it deletes snapshots
  unfenced. A concurrent publish that has renamed its snapshot but not yet swapped the
  pointer loses that file, and the swap then lands on a nonexistent path.
  It also breaks `publish.lock` on mtime alone, which can free the lock while a live
  holder is inside its critical section.
  Either fence it, or make it refuse to run against a store with a live lock.

- **The applied-tx ledger is not committed with its data.** `snapshotStore.ts:516-527`
  applies the changeset in one transaction and writes the `applied_tx` row in a second,
  while the module header at `:18-20` asserts they commit together as a load-bearing
  invariant. If the ledger write throws, the tx is quarantined after its data has already
  committed, and any operator replay of that envelope double-applies it.

A medium tier follows the same theme of failing open on the destructive side: an
unparseable lease file is silently treated as no lease, so `gc` collects a pinned
snapshot; `ReadLease.heartbeat()` no-ops once its lease has been swept, so a holder
believes it is pinned when it is not; a failed `owner.json` write orphans the lock
directory; and `writeWithRetry` retries four permanently-failing conditions and then
misreports all of them as a persistent conflict.

### Test suite hardening

The suite is strong and stays as-is structurally.
Three specific reliability problems need fixing, and two CI flags are non-negotiable.

`seed.test.ts` asserts wall-clock benchmark comparisons inside the correctness gate;
margins are wide locally but a throttled shared runner can redden a PR that changed
nothing. `kill.test.ts:60` sleeps 15ms before `SIGKILL`, far less than Node cold-start,
so on CI the child is almost certainly killed before doing any work and the test passes
as a **silent false green**, never exercising the mid-build property it claims to cover.
`fsinspect.test.ts:66-72` asserts a numeric mtime resolution, but the probe legitimately
returns `null` on a filesystem with one-second granularity.

`node:test` has **no default timeout**, so a wedged lock hangs to the CI job ceiling:
`--test-timeout` is required.
And `--test-concurrency=2` matters because the default is CPU count, and on a two-core
runner the spawn-heavy files co-schedule dozens of processes, shrinking every timing
budget in the suite proportionally.

### Public API surface

Four rough edges are worth settling while breaking changes are still free:

- `constants` is a raw `node:sqlite` re-export, leaking the binding into the public API
  of a package that otherwise argues its format is binding-agnostic.
- `backupTo(db, ...)` takes a `DatabaseSync` that the public API gives no clean way to
  obtain, since `read()` only lends one inside a callback.
- `sqliteFacts` is public in practice (the CLI uses it) but not exported.
- `_snapshotVersions()` and `_publishPointer()` are underscore-named to signal privacy
  but are public and cross-module, so they land in the published `.d.mts` as API the
  package implicitly promises to keep.

Format open issue **O1** (the `<storeDir>/data/catalog/` nesting, described in the spec
as “first-consumer heritage”) is format-breaking and the format spec says to decide it
before publish. Alpha is the cheapest moment to resolve it.

### Docs

The design doc ships as-is.
The format spec needs about four lines touched.
Everything else needs work, and the QA runbook needs the most: eleven monorepo
references, including a Part C entry describing a constraint that ceases to exist on
extraction.

The research doc carries `attic/` paths, citations to an unpublished internal survey,
references to a `SOURCES.md` that does not exist, and stale test counts in four places.
The monorepo plan spec is **not ported**: it is explicitly the finterm-side build plan
and carries 24 internal bead IDs and references to sibling packages.
Its open items are mined into this repo’s beads, then it is left behind.

The README needs a rewrite as an npm landing page.
It currently has no install instructions anywhere in 176 lines, no badges, no license
section, the Node floor buried at line 170, and relative links into `docs/` that resolve
to nothing on npmjs.com because `files` excludes them.

## Implementation Plan

### Phase 1: Foundation and faithful lift

Goal: this repo builds, typechecks, lints, tests, and packs green, with behavior
unchanged from the source.
Keeping the lift faithful keeps the port diff reviewable and lets each later fix land
with its own test.

- [ ] Import the package tree into `packages/fsqlite`, preserving git history where
  practical so 26 commits of design rationale survive
- [ ] Scaffold the workspace: private root `package.json`, `pnpm-workspace.yaml` with
  globs plus hardening keys, `packageManager`, `.npmrc`, `.nvmrc`
- [ ] First dependency resolution and committed lockfile, honoring the cool-off; expect
  friction from the tsdown/rolldown transitive
- [ ] Delete the `typeRoots` escape into the monorepo pnpm store and its rationale
  comment
- [ ] Restore `tsdown.config.ts` to `defineConfig`
- [ ] tsconfig floor: `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noImplicitReturns`, `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`,
  plus `erasableSyntaxOnly` and `NodeNext`
- [ ] ESLint to the floor: strict type-checked preset, `curly: ['error', 'all']`, drop
  the deprecated `brace-style`, keep the existing stricter additions
- [ ] Add Prettier and `eslint-config-prettier`, ordered so the floor rules survive it
- [ ] Add flowmark for Markdown
- [ ] Add lefthook: auto-fix at pre-commit, full verify at pre-push
- [ ] Bring `scripts/` into lint and typecheck scope
- [ ] Package metadata: `repository` with `directory`, `homepage`, `bugs`, `author`;
  publint will demand them
- [ ] LICENSE attribution corrected for this repo
- [ ] Move the format, design, runbook, and research docs to the repo-root `docs/`,
  fixing cross-links
- [ ] CI workflow: ubuntu and macos, Node matrix including an explicit job at the
  declared floor, `--test-timeout`, `--test-concurrency=2`, verify-only commands
  throughout
- [ ] Resolve tryscript from devDeps rather than a network runner
- [ ] Confirm a clean-room `pnpm install --frozen-lockfile` reproduces green from
  scratch

### Phase 2: Correctness and hardening

Goal: the recovery paths behave as the docs claim.
Every item lands with a regression test that fails before the fix.

- [ ] Confirm the Node release that added `backup`, then set an honest `engines` floor
  and pin a CI job to it
- [ ] Make `repair()` non-destructive until a clean snapshot is identified
- [ ] Fence `repair()`, or make it refuse to run against a store with a live lock
- [ ] Commit changeset data and its `applied_tx` ledger row in one transaction
- [ ] Make lease reads fail safe: an unparseable but fresh lease must block collection
- [ ] Make `heartbeat()` report loss of the lease instead of silently no-opping
- [ ] Remove the orphaned lock directory when the `owner.json` write fails
- [ ] Classify permanent versus retryable failures in `writeWithRetry` and carry the
  real reason into the error
- [ ] Cover the session-capability failure branch, currently asserted only in its happy
  case
- [ ] Move the wall-clock benchmark out of the correctness gate
- [ ] Gate the `kill.test.ts` mid-build kill on an observable rather than a fixed sleep
- [ ] Accept a legitimately null mtime resolution in `fsinspect.test.ts`
- [ ] Log or seed the fuzz parameters so a failure is reproducible
- [ ] Extract the magic numbers that carry the correctness argument into named
  constants, starting with the lease and retry tunables

### Phase 3: Usability, docs, and alpha publish

Goal: a stranger can find, understand, install, and use this.

- [ ] Decide format open issue O1 while breaking changes are still free
- [ ] Settle the four public-API rough edges
- [ ] Rewrite the package README as a landing page: pitch, badges, install, quickstart,
  condensed comparison table, consolidated limitations, links out
- [ ] Write the short root README pointing at the package
- [ ] Split out CONTRIBUTING.md and start CHANGELOG.md
- [ ] Scrub the QA runbook of monorepo assumptions and delete the Part C entry that the
  extraction resolves
- [ ] Scrub the research doc: `attic/` paths, the unpublished-survey citations, the
  `SOURCES.md` references, the stale test counts, the already-answered next step
- [ ] Light scrub of the format spec, including the broken internal link
- [ ] Reframe `attic/` in `upstream-source-confirmations.md` as a reproducible local
  checkout convention
- [ ] Write `docs/roadmap.md` from the mined open items, with no inherited tracker IDs
- [ ] Wire a doc-claim drift guard so test counts in prose cannot rot again
- [ ] Tag-triggered publish workflow with npm provenance
- [ ] Publish `0.1.0-alpha.1` under the `alpha` dist-tag
- [ ] Verify a clean install from the registry in an empty project

## Testing Strategy

The existing suite is the baseline and must stay green throughout: 75 `node:test` cases
including real multi-process concurrency, crash injection, `SIGKILL` recovery, lease
fencing, NFS simulation, and fuzz, plus 24 tryscript CLI goldens and a package smoke
test that packs, clean-installs the tarball, and exercises both the library entry and
the `bin`.

That smoke test is the only check that proves the published contract, and it becomes
more important once this repo publishes for real.

Each Phase 2 fix lands with a regression test that fails before it.
CI runs the full gate on every push: format check, Markdown check, zero-warning lint,
`tsc --noEmit`, the test suite, the goldens, the build with publint, and the smoke test.

Deferred and disclosed rather than silently missing: the real cross-host NFS/EFS gate,
power-loss fault injection, and Windows.

## Rollout Plan

Publish `0.1.0-alpha.1` to npm under the `alpha` dist-tag, so `npm install fsqlite` does
not resolve to it by default.
The README states plainly that the format is draft, the API may move, and the cross-host
concurrency gate is pending.

Alpha feedback and the O1 decision inform a beta.
The 1.0 bar is the real NFS gate, conformance fixtures with a verifier, and a settled
public API.

## Open Questions

- **Git history**: preserve the 26 commits via `git filter-repo` onto a branch here, or
  take a single squashed import?
  History preservation is more useful than usual for a package whose design rationale is
  this dense, at the cost of more setup.
- **LICENSE attribution**: currently `Copyright (c) 2026 finterm` while this repo is
  `jlevy/fsqlite`. Reassign, keep, or dual-attribute?
- **O1, the catalog-root nesting**: flatten to `<storeDir>/` or keep `data/catalog/` and
  document it as intentional rather than inherited?
- **ESLint major version**: ESLint 9 is reported to reach end of life on 2026-08-06,
  days from now, and ESLint 10 removes `.eslintrc.*` entirely.
  Confirm the date and scaffold directly on the version that will be supported.
- **`node:sqlite` stability language**: it is now Release Candidate rather than
  experimental, and the warning is gone on recent Node.
  Decide how prominently the README should carry that caveat.
- **Publishing identity**: is there an npm org or scope preference, or does this publish
  unscoped as `fsqlite`?

## References

- Source: `finterm-ai/finterm-main` PR #27, branch `claude/vibrant-mendel-sfd27`
- `docs/fsqlite-design.md`, `docs/fsql-format-spec.md` (ported with the package)
- tbd guidelines: `typescript-lint-format-rules`, `supply-chain-hardening`,
  `typescript-rules`, `error-handling-rules`, `general-testing-rules`,
  `common-doc-guidelines`
- The monorepo plan spec `plan-2026-06-06-fsqlite-standalone-sqlite-package.md`, mined
  for open items and deliberately not ported

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
