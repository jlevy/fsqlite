# Releasing fsqlite

Releases are built from a clean checkout and verified before publication.
Each release commit receives an exact matching version tag; for example, package version
`0.1.0` uses tag `v0.1.0`. The first-publish sequence below creates its tag only after
registry verification.

## First Publish

The unscoped npm name is `fsqlite`, to be published from the `jlevy` owner account.
Before the first publish, confirm that the name remains unclaimed.
npm requires an owner-authenticated first publish before trusted publishing can be
configured for a new package.
Confirm that this project will use the unscoped name, authenticate the owner account
with npm, and then:

1. Check out the reviewed commit that will become the release.
2. Run `pnpm install --frozen-lockfile --ignore-scripts` and `pnpm verify` in a clean
   checkout.
3. From `packages/fsqlite`, run `npm publish --access public --tag alpha` using the
   authenticated owner account.
4. Confirm that the registry package contains only the intended standalone project, that
   `0.1.0` has the `alpha` dist-tag, and that a fresh consumer install succeeds.
5. Create and push the matching `v0.1.0` tag only after the initial package is known to
   be correct. The tag workflow recognizes this one bootstrap version and verifies its
   registry version, `alpha` dist-tag, library import, and CLI instead of attempting to
   publish the immutable version twice.

Do not create the release tag until npm identity, package name, and the reviewed commit
are final. A tag is an immutable release assertion, not a staging mechanism.

## Trusted Publishing

After the package exists, configure GitHub and npm once:

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

1. Update the version and changelog in a pull request.
2. Verify the merged commit in a clean checkout.
3. Create the exact matching `v*` tag on that commit and push it.
4. Watch the Publish workflow; the `stage` job logs the staged version and its stage ID.
5. With npm 11.15 or later, review the staged release with `npm stage list fsqlite` and,
   if needed, `npm stage download <stage-id>`. Then run `npm stage approve <stage-id>`,
   which prompts for 2FA, or `npm stage reject <stage-id>` to discard it.
6. Verify the npm version, dist-tag, provenance
   (`npm view fsqlite@<version> dist.attestations`), and a fresh consumer install.

Stable releases use the same process with the appropriate npm dist-tag after the
package’s compatibility policy is established.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
