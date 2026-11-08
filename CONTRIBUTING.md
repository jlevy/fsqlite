# Contributing to fsqlite

Contributions are welcome.
Correctness changes should start by identifying the durable invariant at stake and
adding a regression test that fails without the change.

## Development Setup

Install Node `>=22.18.0 <23 || ^24.0.0 || >=26.0.0`, pnpm 11.28.8, and `uv` (used to run
the pinned Markdown formatter), then run:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec lefthook install
pnpm verify
```

`pnpm-workspace.yaml` sets `engineStrict`, so installing the development tools also
enforces their own engines: development needs Node 22.18 or later on the 22 line, 24.11
or later on the 24 line, or 26 and later.
The published package keeps the wider runtime range.
Installing with `--ignore-scripts` skips lefthook’s own installer, so
`pnpm exec lefthook install` is what enables the Git hooks.

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

## Upgrading tbd

The tbd hook scripts are project-maintained adaptations of the files `tbd setup --auto`
generates. `tbd-session.sh` and `tbd-closing-reminder.sh` locate the repository from
their own path rather than through git, the closing hook detects pushes with
`scripts/detect-git-push.mjs`, and both pass failures through instead of hiding them.
The `.claude/` and `.codex/` copies of each script are byte-identical.
Setup overwrites these scripts and rewrites or duplicates their wiring, so after a tbd
upgrade:

1. Run `tbd setup --auto` and save its diff for reference (`git diff > tbd-setup.diff`).
2. Restore the project versions:
   `git restore .claude/settings.json .codex/hooks.json .claude/scripts/tbd-session.sh .claude/hooks/tbd-closing-reminder.sh .codex/tbd-session.sh .codex/tbd-closing-reminder.sh`.
3. Port any upstream launcher changes from the saved diff into the `.claude/` copies,
   keeping the project hardening, then copy them over the `.codex/` copies.
4. Run `pnpm test:project-hooks`, then `tbd doctor`. A “user-owned” warning for Codex
   hooks is expected.

`.claude/agents/tbd-strong-max.md` is a project-owned override that runs the strong-max
tier on Fable at `max`. Setup keeps it because its generated marker was removed, so it
no longer receives upstream body changes; compare it with a freshly generated copy after
each upgrade. `AGENTS.md` is excluded from flowmark because flowmark would rewrap the
tbd-managed block, which `tbd doctor` then reports as stale; the repository dash,
footer, and link checks still cover it.

## Releasing

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
