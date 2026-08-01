# Contributing to fsqlite

Contributions are welcome.
Correctness changes should start by identifying the durable invariant at stake and
adding a regression test that fails without the change.

## Development Setup

Install Node `>=22.18.0 <23 || >=24.0.0`, pnpm 11.14.0, and `uv` (used to run the pinned
Markdown formatter), then run:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm verify
```

Common focused commands:

```bash
pnpm test
pnpm test:golden
pnpm typecheck
pnpm lint
pnpm format
pnpm build
pnpm test:package
```

The test suite runs TypeScript directly with Node’s native type stripping.
The package build exists to produce and verify the npm artifact, not for the inner
development loop.

## Expectations

- Keep the package dependency-free at runtime.
- Preserve distinct not-a-store, invalid, unsupported, in-flight, and corrupt states.
- Never make normal open perform a format or caller-schema migration.
- Make destructive maintenance fail closed and test its failure path.
- Use named constants for timing, retry, retention, and durability policy.
- Update the format specification when an on-disk requirement changes.
- Run `pnpm verify` before submitting a pull request.

Formatting is enforced by Prettier, flowmark, ESLint, and lefthook.
CI verifies the declared Node floor on Linux plus the current Node LTS on Linux and
macOS.

Release maintainers should follow [the release runbook](docs/releasing.md).
The first npm publication is a documented bootstrap case; later releases use trusted
publishing.

## Reporting Bugs

Open a [GitHub issue](https://github.com/jlevy/fsqlite/issues) with the Node version,
filesystem type, relevant mount options, a minimal reproduction, and the output of
`fsqlite doctor` and `fsqlite fsinspect` when applicable.
Avoid attaching database contents that contain private data.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
