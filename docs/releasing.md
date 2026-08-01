# Releasing fsqlite

Releases are built from a clean checkout, verified before publication, and published
from an exact version tag.
The package version and tag must match; for example, `0.1.0-alpha.1` is published from
`v0.1.0-alpha.1`.

## First Publish

The npm name `fsqlite` is unclaimed as of the alpha release preparation.
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
   `0.1.0-alpha.1` has the `alpha` dist-tag, and that a fresh consumer install succeeds.
5. Create and push the matching `v0.1.0-alpha.1` tag only after the initial package is
   known to be correct.
   The tag workflow recognizes this one bootstrap version and verifies its registry
   version, `alpha` dist-tag, library import, and CLI instead of attempting to publish
   the immutable version twice.

Do not create the release tag until npm identity, package name, and the reviewed commit
are final. A tag is an immutable release assertion, not a staging mechanism.

## Trusted Publishing

After the package exists, configure its npm trusted publisher for:

- GitHub organization or user: `jlevy`
- Repository: `fsqlite`
- Workflow: `publish.yml`
- Environment: none

Later releases use the tag-triggered `.github/workflows/publish.yml` workflow.
It installs from the committed lockfile, runs the complete verification gate, confirms
the tag matches the package version, and publishes with npm’s GitHub Actions OIDC
trusted publishing. The explicit `v0.1.0-alpha.1` branch is the only manual bootstrap
exception. No long-lived npm token is stored in GitHub.

For a later alpha release:

1. Update the version and changelog in a pull request.
2. Verify the merged commit in a clean checkout.
3. Create the exact matching `v*` tag on that commit and push it.
4. Watch the Publish workflow and verify the npm version, dist-tag, provenance, and a
   fresh consumer install.

Stable releases use the same process with the appropriate npm dist-tag after the
package’s compatibility policy is established.
