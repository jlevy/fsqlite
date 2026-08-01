# Supply-chain security

fsqlite has no runtime dependencies and allows no dependency lifecycle scripts.
Development dependencies are locked with pnpm and ordinarily must have been published
for at least 14 days before they can enter the lockfile.

## Time-limited security exception

`brace-expansion@5.0.8` is pinned as a transitive override even though it had not yet
cleared the 14-day cool-off on 2026-07-31. It is the first release patched against
[GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg), a
high-severity denial-of-service vulnerability reported by `pnpm audit`. The exception is
restricted to this exact version and does not relax the repository-wide age gate.

Review this exception after 2026-08-06. Once the patched release has aged normally,
remove it from `minimumReleaseAgeExclude`; keep the override only if the upstream
dependency graph still resolves an affected version.
