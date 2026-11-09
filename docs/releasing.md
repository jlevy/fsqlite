# Releasing fsqlite

Releases are built from a clean checkout and verified before publication.
Each release commit receives an exact matching version tag; for example, package version
`0.1.0` uses tag `v0.1.0`. The first-publish sequence below creates its tag only after
registry verification.
Only the maintainer runs these steps; agents never create tags, releases, or npm
publications.

## First Publish

The unscoped npm name is `fsqlite`, to be published from the `jlevy` owner account.
npm requires an owner-authenticated first publish before trusted publishing can be
configured for a new package.
An npm version number is immutable: once `0.1.0` is published, even an unpublished
`0.1.0` cannot be published again, so every check below runs before step 6.

1. In the release pull request, replace `(Unreleased)` in the `CHANGELOG.md` heading
   with the publish date, and remove the “not yet published” note from the root README’s
   Install section.
2. Check out the merged commit that will become the release and confirm that its CI run
   is green, including the Dependency audit job, which `pnpm verify` does not run.
3. In a clean checkout, run `pnpm install --frozen-lockfile --ignore-scripts` and
   `pnpm verify`.
4. Confirm that the name is still unclaimed: `npm view fsqlite` must fail with `E404`.
5. From `packages/fsqlite`, confirm that `npm whoami` prints `jlevy`, then run
   `npm pack --dry-run` and review the file list (`dist/`, `README.md`, `LICENSE`,
   `package.json`) and the README that npm will render.
6. From `packages/fsqlite`, run `npm publish --access public --tag alpha` as the owner
   account. npm asks for a 2FA code.
7. Run `npm view fsqlite dist-tags` and check the result against [Dist-Tags](#dist-tags)
   below.
8. Confirm that a fresh consumer install of `fsqlite@alpha` imports the library and runs
   the `fsqlite` bin.
9. Tag the exact published commit and push the tag:
   `git tag v0.1.0 <published-sha> && git push origin v0.1.0`. The tag workflow
   recognizes this one bootstrap version and verifies its registry version, `alpha`
   dist-tag, library import, and CLI instead of attempting to publish the immutable
   version twice.
10. Optionally, create a GitHub release for the tag from the `CHANGELOG.md` entry.

Do not create the release tag until npm identity, package name, and the reviewed commit
are final. A tag is an immutable release assertion, not a staging mechanism.

The bootstrap version is written into `.github/workflows/publish.yml` as the literal
`v0.1.0` (the `if:` conditions and the bootstrap verification step).
If the first publish must use another version, for example `0.1.1` after a failed or
unpublished `0.1.0`, change those literals and this runbook in the same commit as the
version.

## Dist-Tags

npm’s documentation says that `npm publish --tag <tag>` applies that tag instead of
`latest` ([`npm dist-tag`](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag)) and
that `npm install fsqlite` installs the version the `latest` tag names
([`npm install`](https://docs.npmjs.com/cli/v11/commands/npm-install)). It does not say
which tags the registry sets when a package’s first version is published under another
tag, so verify the result with `npm view fsqlite dist-tags` after publishing instead of
assuming `latest` is absent.

If `latest` also names `0.1.0`, a plain `npm install fsqlite` installs the alpha, and
every later `0.x` release, which the workflow stages with `--tag alpha`, leaves `latest`
on the older version.
Until the project decides whether `0.x` releases publish to `latest` directly, move it
after approving each release with `npm dist-tag add fsqlite@<version> latest`.

## Trusted Publishing

After the package exists, configure GitHub and npm once, before pushing any release tag
after `v0.1.0`. GitHub creates a missing environment, without protection rules, the
first time a job names it, so create and restrict `npm` first; without the trusted
publisher, the `stage` job’s `npm stage publish` fails and nothing is staged.

1. In the repository settings on GitHub, create the environment `npm`. Restrict its
   deployment branches and tags to tags matching `v*`. Required reviewers are optional:
   npm already holds every staged release until an owner approves it with 2FA, but a
   reviewer also gates when the workflow can request an OIDC token.

2. On npmjs.com, add a trusted publisher to `fsqlite` with:
   - GitHub organization or user: `jlevy`
   - Repository: `fsqlite`
   - Workflow: `publish.yml`
   - Environment: `npm`
   - Allowed actions: `npm stage publish` only; leave `npm publish` disallowed.

   The command-line equivalent is
   `npm trust github fsqlite --repo jlevy/fsqlite --file publish.yml --env npm --allow-stage-publish`.

3. After the first trusted release, set the package’s publishing access to “Require
   two-factor authentication and disallow tokens”.

Later releases use the tag-triggered `.github/workflows/publish.yml` workflow.
Its `build` job has no OIDC permission: it installs from the committed lockfile, runs
the complete verification gate, confirms the tag matches the package version, packs the
tarball, and smoke-tests that exact tarball.
Its `stage` job runs in the `npm` environment with `id-token: write`, checks out and
installs nothing, and stages that tarball with `npm stage publish` and provenance.
A staged version is not public until an owner approves it.
The explicit `v0.1.0` branch is the only manual bootstrap exception: for that tag the
workflow verifies the owner-published package and skips the `stage` job.
No long-lived npm token is stored in GitHub.

For a later release during the alpha phase:

1. Update the version and the dated changelog entry in a pull request.
2. Confirm that the merged commit’s CI run is green, including the Dependency audit job,
   and verify it in a clean checkout with `pnpm verify`.
3. Create the exact matching `v*` tag on that commit (`git tag v<version> <merged-sha>`)
   and push it.
4. Watch the Publish workflow.
   The `stage` job checks and logs the verified tarball’s SHA-512 digest, and npm logs
   the staged version and its stage ID.
5. With npm 11.15 or later, find the staged release with `npm stage list fsqlite` and
   fetch its tarball with `npm stage download <stage-id>`. Use `shasum -a 512 <tarball>`
   to compare its bytes against the digest in the stage log.
   To check the build itself, independently pack the tagged source in a trusted
   environment that matches CI and compare the tarballs.
   Run `npm stage approve <stage-id>` after review.
   npm prompts for 2FA. Use `npm stage reject <stage-id>` to discard a staged release.
6. Verify the npm version, `npm view fsqlite dist-tags` (see [Dist-Tags](#dist-tags)),
   provenance (`npm view fsqlite@<version> dist.attestations`), and a fresh consumer
   install.

Stable releases use the same process with the appropriate npm dist-tag after the
package’s compatibility policy is established.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
