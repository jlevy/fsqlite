# Feature: fsqlite Standalone Alpha Release

**Date:** 2026-07-31

**Author:** Joshua Levy (with LLM assistance)

**Status:** In progress

**Tracking epic:** `fsq-mh41`

## Overview

Establish `github.com/jlevy/fsqlite` as the standalone home of `fsqlite` and publish an
alpha to npm.

The package is filesystem-friendly concurrent SQLite: immutable snapshot publication and
transaction-envelope changesets behind a fenced `mkdir` lease, with a local
single-writer `DirectStore` mode, over plain SQLite files, server-free, on any
filesystem that supplies the protocol’s required coordination and durability behavior.

The runtime code is already self-contained: no source, worker, or test import escapes
the package. The work is to establish an independent toolchain, fix the recovery-path
defects found during review, define the standalone `f1.0` store format, and raise the
documentation and public API to the standard expected of a published package.

## Goals

- A standalone repo that builds, typechecks, lints, tests, and publishes with no
  reference to any other repository.
- The full lint, format, type, and supply-chain floor from the tbd guidelines, enforced
  in CI and in pre-push hooks rather than by convention.
- The four P0 correctness and compatibility defects fixed, each with a regression test.
- An honest `engines` range, so no consumer can install a version that cannot load.
- Public docs describe fsqlite only and link only to public, maintained material.
- A published `0.1.0` on npm under the `alpha` dist-tag, installable and usable from a
  clean project.

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
- **Compatibility with unpublished layouts or APIs.** This is a new project.
  The alpha defines its first public API and on-disk format without compatibility shims
  for development-only predecessors.
- **Automatic caller-schema migration.** `f1.0` has one immutable caller-schema
  identity. A different schema version or exact DDL hash is incompatible until a
  separate, deterministic migration protocol is specified.

## Background

The initial standalone package did not have a lockfile, and its declared development
dependencies had not been resolved together.
The first workspace install is therefore a new dependency resolution and remains the
riskiest foundation step.

The npm name `fsqlite` is unclaimed (the registry returns 404).

## Design

### Toolchain: pnpm, Node, `node --test`, and tsdown

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
| Release | Owner-authenticated bootstrap, then tag-triggered npm trusted publishing; no Changesets |

One deviation from the guidelines is deliberate: `moduleResolution` is `NodeNext`, not
`Bundler`, because this package’s `.ts` import specifiers are resolved by Node at
runtime rather than by a bundler.

### Repo Layout: Workspace From Day One

The repo uses a `packages/` workspace with `packages/fsqlite` as the single published
package.

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
package. Resolve it by making `packages/fsqlite/README.md` the primary package guide.
It must be in the tarball.
Keep the root `README.md` as a short repository overview that links to it rather than
maintaining two copies that drift.

Format-level and research documentation lives in the repo-root `docs/`, since it spans
implementations rather than belonging to the Node library.
The package README links to it with absolute URLs, which is required in any case because
`files` excludes `docs/` from the published tarball.

```
README.md                    short repo overview, links to the package
LICENSE
CHANGELOG.md                 repository and package release history
CONTRIBUTING.md
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
    README.md                primary npm landing page
    package.json
    src/ test/ workers/ examples/ scripts/
```

The repo keeps a `pnpm-workspace.yaml` for the workspace globs, which is also where pnpm
11 reads `minimumReleaseAge`; its default is only one day.

### Project Identity

This is a new standalone open-source project.
Copyright is solely Joshua Levy under the MIT License.
Public source, documentation, metadata, tests, and tracker records refer only to fsqlite
and this repository.
The npm package is published unscoped as `fsqlite` from Joshua Levy’s `jlevy` account.

The project uses ordinary `0.x` semantic versions without prerelease suffixes.
Documentation and the npm `alpha` dist-tag communicate the project phase, while package
version `0.1.0` and Git tag `v0.1.0` identify the first release.

### Supply-Chain Posture

A package with zero runtime dependencies needs **no lifecycle scripts**. State that
security property in the README as well as configuring it:

```yaml
# pnpm-workspace.yaml
packages:
  - packages/*
minimumReleaseAge: 20160 # 14 days in minutes
blockExoticSubdeps: true
allowBuilds: [] # zero runtime deps: nothing needs to build
```

### The `engines` Defect

`src/driver.ts:15` is a static named import:

```ts
import { DatabaseSync, constants, backup } from 'node:sqlite'
```

ESM resolves named imports at link time, so on a Node where `node:sqlite` exists but
does not export `backup`, the entire module graph fails to load.
This is not a lazy runtime failure that a capability check can absorb, and in fact the
`typeof backup === 'function'` probe at `driver.ts:122` is unreachable on exactly the
versions it was written to defend.

Three independent floors were in play; the earlier `>=22.13.0` range satisfied only the
weakest:

| Requirement | Introduced | Status |
| --- | --- | --- |
| `node:sqlite` unflagged | 22.13.0 / 23.4.0 | matches declared `engines` |
| `backup` export | 22.16.0 / 23.8.0 | satisfied by the declared floor |
| Unflagged `.ts` type-stripping | 22.18.0 | required to run from source |

Node’s API history records `backup` in 22.16.0 and 23.8.0. The published range is
therefore `>=22.18.0 <23 || >=24.0.0`: 22.18 is the higher source-development floor, the
non-LTS Node 23 line is excluded rather than expressing a misleading partial range, and
Node 24 is fully supported.
CI pins an explicit 22.18.0 job because `node-version: 22` resolves to latest 22.x and
hides precisely this class of bug.

ESLint 9 reaches end of support on 2026-08-06, and ESLint 10 removes eslintrc support.
The standalone scaffold therefore starts on ESLint 10 with a flat configuration rather
than creating configuration debt days before the release.

### Correctness Defects to Fix

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

### Test Suite Hardening

The suite keeps its structure.
Three specific reliability problems need fixing, and two CI flags are required.

The writer-seeding benchmark must stay outside the correctness gate because a throttled
shared runner can redden a PR that changed nothing.
`kill.test.ts:60` sleeps 15ms before `SIGKILL`, far less than Node cold-start, so on CI
the child is almost certainly killed before doing any work and the test passes as a
**silent false green**, never exercising the mid-build property it claims to cover.
`fsinspect.test.ts:66-72` asserts a numeric mtime resolution, but the probe legitimately
returns `null` on a filesystem with one-second granularity.

`node:test` has **no default timeout**, so a wedged lock hangs to the CI job ceiling:
`--test-timeout` is required.
And `--test-concurrency=2` matters because the default is CPU count, and on a two-core
runner the spawn-heavy files co-schedule dozens of processes, shrinking every timing
budget in the suite proportionally.

### Public API Surface

Four rough edges are worth settling while breaking changes are still free:

- `constants` is a raw `node:sqlite` re-export, leaking the binding into the public API
  of a package that otherwise argues its format is binding-agnostic.
- `backupTo(db, ...)` takes a `DatabaseSync` that the public API gives no clean way to
  obtain, since `read()` only lends one inside a callback.
- `sqliteFacts` is public in practice (the CLI uses it) but not exported.
- `_snapshotVersions()` and `_publishPointer()` are underscore-named to signal privacy
  but are public and cross-module, so they land in the published `.d.mts` as API the
  package implicitly promises to keep.

### Standalone Store Identity

The caller-provided directory is the store root.
A visible `fsqlite.json` marker makes it self-identifying without relying on generic
path names. The marker carries `format: "fsqlite"`, `format_version: "f1.0"`,
`required_features`, and a UUID `store_id`. The version grammar is `f<major>.<minor>`:
major revisions are incompatible, while minor revisions are additive and require an
explicit compatibility declaration before an older implementation accepts them.
Snapshots repeat the format version and store identity so copied or mixed store contents
fail validation. Transaction manifests repeat both values as well.
Snapshot files use the fixed SQLite `application_id` `0x4653514C` (`FSQL`); callers own
`PRAGMA user_version` and `schema_hash`, not the fsqlite file identity.
Those two caller fields form one immutable `f1.0` schema identity.
Incrementing `schemaVersion` rejects an existing store and does not migrate it.
The hash covers the exact UTF-8 schema string rather than canonical SQL.

The marker is visible JSON rather than hidden YAML because it is machine-owned format
identity, not user configuration: Node parses it without another dependency, its types
are unambiguous, and directory recognition remains obvious to both people and tools.

Normal opens never upgrade a store.
Optional marker fields may be added without a format bump, mandatory capabilities use
`required_features`, and incompatible layout or protocol changes increment the major
component. A future explicit upgrade command will write and validate a side-by-side
destination, preserve `store_id`, and leave the source untouched until operator cutover.

### Consolidated Design Constraints

`docs/fsqlite-design.md` owns the stable `C1` through `C12` system-constraint registry.
`docs/fsql-format-spec.md` remains the sole normative protocol authority, and the QA
runbook maps constraints to tests.
Package prose, research, and plans link to those authorities rather than restating a
competing contract.

The design review identified two unsafe edges that are resolved before publication:

- The schema-only writer seed is removed from `f1.0`. A callback now always observes a
  full copy of the published head, so updates, deletes, and existing-key inserts cannot
  silently operate against an empty database.
- Application callbacks cannot mutate fsqlite-owned rows, persistent or temporary SQLite
  schema, application ID, or caller schema version.
  DirectStore reasserts identity and reserved-table invariants before publishing its
  candidate.

The review also narrows two claims.
Different primary keys may still conflict through a UNIQUE or foreign-key constraint.
Bounded-loss backup applies to pinned immutable snapshots and supported backup/seal
operations, not an arbitrary recursive copy of a live directory.
Long DirectStore and repair critical sections remain safe through fencing but need a
heartbeat or shorter critical section for better liveness.

The final schema and workload review adds four calibrated boundaries:

- application mutation verifies exact schema compatibility even when a handle skipped
  `init()`;
- required directory fsync failures abort instead of silently weakening the power-loss
  claim;
- `seal()` pins its selected source snapshot against aggressive GC;
- snapshot bytes, pending work, concurrent writer copies, and lifetime ledger count are
  the operational scale variables.
  Table count alone is secondary.

The detailed evidence and reconsideration triggers are in
`docs/research/research-2026-08-01-schema-evolution-and-workload-fit.md`.

The comprehensive architecture revision adds one first-principles decision boundary.
Ordinary local SQLite remains the default when writers can take turns.
DirectStore adds immutable publication for one application writer.
SnapshotStore adds independent capture and deterministic reconciliation, with full-head
copying, delayed visibility, and nonserializable merge semantics as explicit costs.
Schema maintenance is quiescent and application-managed in `f1.0`; future migration must
coordinate old envelopes and writers around SQLite’s ordinary DDL steps.

### Documentation

The design, format specification, QA runbook, source confirmations, and research report
describe the standalone project and the `f1.0` layout consistently.
Implementation-independent material lives under the root `docs/` directory.
The package README is the npm landing page, with install instructions, runtime
requirements, alpha limitations, and absolute links to public repository documentation
because `files` excludes `docs/` from the tarball.
The root README provides a short project and documentation map.
Contributor, release, roadmap, changelog, and supply-chain documents cover
repository-level operations without duplicating the technical references.

## Implementation Plan

### Phase 1: Foundation and Reproducible Baseline

Goal: this repo builds, typechecks, lints, tests, and packs green from an explicit
standalone baseline.
Keeping that baseline stable makes each later correctness fix reviewable with its own
regression test.

- [x] (`fsq-6jy5`) Establish `packages/fsqlite` as the initial standalone package
  baseline
- [x] (`fsq-1pjs`) Scaffold the workspace: private root `package.json`,
  `pnpm-workspace.yaml` with globs plus hardening keys, `packageManager`, `.npmrc`,
  `.nvmrc`
- [x] (`fsq-iakz`) First dependency resolution and committed lockfile, honoring the
  cool-off; expect friction from the tsdown/rolldown transitive
- [x] (`fsq-sih0`) Delete the hardcoded `typeRoots` escape and its rationale comment
- [x] (`fsq-sih0`) Restore `tsdown.config.ts` to `defineConfig`
- [x] (`fsq-sywj`) tsconfig floor: `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noImplicitReturns`, `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`,
  plus `erasableSyntaxOnly` and `NodeNext`
- [x] (`fsq-4ns2`) ESLint to the floor: strict type-checked preset,
  `curly: ['error', 'all']`, drop the deprecated `brace-style`, keep the existing
  stricter additions
- [x] (`fsq-4ns2`) Add Prettier and `eslint-config-prettier`, ordered so the floor rules
  survive it
- [x] (`fsq-6tbg`) Add flowmark for Markdown
- [x] (`fsq-6tbg`) Add lefthook: auto-fix at pre-commit, full verify at pre-push
- [x] (`fsq-5qu5`) Bring `scripts/` into lint and typecheck scope
- [x] (`fsq-9kc3`) Package metadata: `repository` with `directory`, `homepage`, `bugs`,
  `author`; publint will demand them
- [x] (`fsq-9kc3`) LICENSE attribution corrected for this repo
- [x] (`fsq-tu9u`) Move the format, design, runbook, and research docs to the repo-root
  `docs/`, fixing cross-links
- [x] (`fsq-vryt`) CI workflow: ubuntu and macos, Node matrix including an explicit job
  at the declared floor, `--test-timeout`, `--test-concurrency=2`, verify-only commands
  throughout
- [x] (`fsq-34ry`) Disable setup-uv’s unused Python dependency cache so CI does not
  report permanent cache-invalidation annotations
- [x] (`fsq-u390`) Resolve tryscript from devDeps rather than a network runner
- [x] (`fsq-x211`) Confirm a clean-room `pnpm install --frozen-lockfile` reproduces
  green from scratch

### Phase 2: Correctness and Hardening

Goal: the recovery paths behave as the docs claim.
Every item lands with a regression test that fails before the fix.

- [x] (`fsq-fiba`) Confirm the Node release that added `backup`, then set an honest
  `engines` floor and pin a CI job to it
- [x] (`fsq-s9w6`) Make `repair()` non-destructive until a clean snapshot is identified
- [x] (`fsq-vi82`) Fence `repair()`, or make it refuse to run against a store with a
  live lock
- [x] (`fsq-8f1t`) Commit changeset data and its `applied_tx` ledger row in one
  transaction
- [x] (`fsq-jor0`) Make lease reads fail safe: an unparseable but fresh lease must block
  collection
- [x] (`fsq-h6lw`) Make `heartbeat()` report loss of the lease instead of silently
  no-opping
- [x] (`fsq-v3ma`) Remove the orphaned lock directory when the `owner.json` write fails
- [x] (`fsq-ty0i`) Classify permanent versus retryable failures in `writeWithRetry` and
  carry the real reason into the error
- [x] (`fsq-sjyj`) Cover the session-capability failure branch, currently asserted only
  in its happy case
- [x] (`fsq-0kvh`) Move the wall-clock benchmark out of the correctness gate
- [x] (`fsq-0kvh`) Gate the `kill.test.ts` mid-build kill on an observable rather than a
  fixed sleep
- [x] (`fsq-0kvh`) Accept a legitimately null mtime resolution in `fsinspect.test.ts`
- [x] (`fsq-pbse`) Log or seed the fuzz parameters so a failure is reproducible
- [x] (`fsq-soz0`) Extract the magic numbers that carry the correctness argument into
  named constants, starting with the lease and retry tunables
- [x] (`fsq-eyak`) Validate each envelope manifest transaction ID against its directory
  name before apply
- [x] (`fsq-v99d`) Preserve a pending envelope when its quarantine reason cannot be
  written
- [x] (`fsq-xc8i`) Treat an envelope already consumed by another reconciler as a benign
  quarantine race without weakening fail-closed reason writes
- [x] (`fsq-rysf`) Protect the callback trust boundary and reassert candidate identity
  before DirectStore publication
- [x] (`fsq-hv1n`) Reject callback removal or alteration of temporary protection
  triggers in both write strategies
- [x] (`fsq-jwyo`) Remove the unsafe schema-only seed mode from the public API and
  `f1.0` protocol
- [x] (`fsq-auor`) Validate caller-schema version inputs and reject wrong-schema
  mutation before callback or envelope work
- [x] (`fsq-pwiv`) Fail closed when a required directory fsync is unavailable and
  include it in the `fsinspect` safe verdict
- [x] (`fsq-ji7m`) Pin the selected snapshot throughout `seal()` so aggressive GC cannot
  remove its source

### Phase 3: Usability, Documentation, and Alpha Publish

Goal: a stranger can find, understand, install, and use this.

- [x] (`fsq-hhve`) Complete the flat, self-identifying `f1.0` store root and marker,
  including distinct not-a-store, invalid, unsupported, and corrupt classifications
- [x] (`fsq-fnh1`) Verify that the fixed `FSQL` SQLite `application_id` is
  collision-free and record it with SQLite’s application-id registry process
- [x] (`fsq-rkix`) Settle the four public-API rough edges
- [x] (`fsq-7qhj`) Complete concurrent backup-and-restore validation against the settled
  public backup surface
- [x] (`fsq-c03w`) Rewrite the package README as a landing page: pitch, badges, install,
  quickstart, condensed comparison table, consolidated limitations, links out
- [x] (`fsq-jyul`) Write the short root README pointing at the package
- [x] (`fsq-jyul`) Split out CONTRIBUTING.md and start CHANGELOG.md
- [x] (`fsq-wb94`) Align the QA runbook with standalone workspace commands, current
  counts, and the self-identifying store checks
- [x] (`fsq-45ej`) Publish the research report as dated background aligned with the
  current runtime, format, source map, and tracked forward agenda
- [x] (`fsq-j8gz`) Align the format spec with `f1.0` identity, recognition states, fixed
  application id, and explicit upgrade rules
- [x] (`fsq-j8gz`) Make upstream source confirmations reproducible from repository URLs,
  commits, and repo-relative source paths
- [x] (`fsq-t218`) Remove external product references from source, docs, metadata,
  tests, and tbd records
- [x] (`fsq-xkb7`) Write `docs/roadmap.md` from the mined open items, with no inherited
  tracker IDs
- [x] (`fsq-5jcy`) Wire a doc-claim drift guard so test counts in prose cannot rot again
- [x] (`fsq-s3sf`) Audit the complete design and research documentation set, publish a
  standalone documentation map, and guard local links and machine-local paths
- [x] (`fsq-97v8`) Tag-triggered publish workflow with npm provenance
- [x] (`fsq-6vfa`) Document the owner-authenticated first-publish bootstrap and
  transition to npm trusted publishing in `docs/releasing.md`
- [x] (`fsq-h8wt`) Make the tag workflow verify the manually published bootstrap version
  rather than attempting to publish the immutable version twice
- [x] (`fsq-qqvg`) Apply common documentation guidelines across maintained prose, with
  per-file beads and automated dash and footer drift checks
- [x] (`fsq-dq4o`) Complete the schema evolution and workload-fit design review, align
  all design-facing documents, and publish the standalone assessment
- [x] (`fsq-bd76`) Make the snapshot-size, table-count, and independent-agent workload
  calibrations reproducible with maintained JSON-emitting benchmarks
- [x] (`fsq-qvw1`) Complete the first-principles architecture revision, tracked one
  maintained document per child bead
  - [x] (`fsq-xmcx`) Orient the root README around ordinary SQLite and immutable
    publication
  - [x] (`fsq-kiov`) Add the consumer decision guide, schema procedure, and mitigation
    boundaries to the package README
  - [x] (`fsq-6kya`) Consolidate the three-way architecture, integrity, isolation, and
    performance comparison in the design
  - [x] (`fsq-epa1`) Consolidate official SQLite evidence, migration guidance, workload
    math, and severity in the focused research assessment
  - [x] (`fsq-wtv3`) Clarify format roles, terminology, schema epochs, and changeset
    compatibility evidence in the normative specification
  - [x] (`fsq-etm3`) Separate stable-release adoption blockers from performance and
    recovery improvements in the roadmap
  - [x] (`fsq-fmpm`) Align this release plan and remove accidental import-history detail
  - [x] (`fsq-ovpq`) Align the future plan with the schema-maintenance fallback and
    stable-release outcomes
  - [x] (`fsq-g3er`) Clarify the public documentation hierarchy and standalone project
    plan boundary
  - [x] (`fsq-er9w`) Align the dated background research with the current bounded
    capture, durability, and adoption language
- [x] (`fsq-g34y`) Address the late closing-hook review follow-ups
  - [x] (`fsq-jgnl`) Recognize literal, unquoted `eval git push` without interpreting
    quoted or dynamically constructed programs
  - [x] (`fsq-vfb2`) Keep closing-hook tests independent of machine-local CLI installs
- [ ] (`fsq-cggp`) Publish `0.1.0` under the `alpha` dist-tag
- [ ] (`fsq-cggp`) Verify a clean install from the registry in an empty project

## Testing Strategy

The current suite is the baseline and must stay green throughout: 127 `node:test` cases
including real multi-process concurrency, crash injection, `SIGKILL` recovery, lease
fencing, NFS simulation, and fuzz, plus 24 tryscript CLI goldens and a package smoke
test that packs, clean-installs the tarball, and exercises both the library entry and
the `bin`.

That smoke test is the only check that proves the published contract, and it becomes
more important once this repo publishes for real.

Each Phase 2 fix lands with a regression test that fails before it.
CI runs the full gate on every push: format check, Markdown check, zero-warning lint,
`tsc --noEmit`, the test suite, the goldens, the build with publint, and the smoke test.

Deferred and disclosed rather than silently missing: the real cross-host NFS/EFS gate
(`fsq-at6m`), power-loss fault injection (`fsq-hm6r`), and Windows publication
validation (`fsq-kkdi`). Deterministic caller-schema migration (`fsq-xma9`), applied
ledger checkpointing (`fsq-bllj`), and capacity observability (`fsq-3a09`) are explicit
post-alpha work.

## Rollout Plan

Publish `0.1.0` to npm under the `alpha` dist-tag, so `npm install fsqlite` does not
resolve to it by default.
The README states plainly that the format is draft, the API may move, and the cross-host
concurrency gate is pending.

Alpha feedback informs a beta.
The 1.0 bar is the real NFS gate, conformance fixtures with a verifier, a settled public
API, a supported caller-schema maintenance protocol, and bounded or explicitly
rollover-managed ledger growth.

## Open Questions

None for the first publication.

## References

- `docs/fsqlite-design.md`, `docs/fsql-format-spec.md`
- `docs/research/research-2026-08-01-schema-evolution-and-workload-fit.md`
- tbd guidelines: `typescript-lint-format-rules`, `supply-chain-hardening`,
  `typescript-rules`, `error-handling-rules`, `general-testing-rules`,
  `common-doc-guidelines`
- Future work is governed by
  `docs/project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md`.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
