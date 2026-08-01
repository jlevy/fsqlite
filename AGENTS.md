# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this
project.

<!-- BEGIN TBD INTEGRATION format=f06 surface=agents-md -->
## tbd

This repository uses **tbd** for git-native issue tracking (beads), spec-driven
planning, and on-demand engineering guidelines.
As the agent, you operate tbd on the user’s behalf: translate their requests into tbd
actions rather than telling them to run commands.

- Run `tbd prime` to load current project state and the full tbd workflow.
- Run `tbd skill` for the complete reusable tbd skill instructions.
- Run `tbd shortcut --list` and `tbd guidelines --list` for on-demand resources.
- Track all work as beads: `tbd create`, `tbd ready`, `tbd close`, and `tbd sync`.

<!-- END TBD INTEGRATION -->

## Build and Test

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm verify                 # complete release gate
pnpm test                   # node:test correctness suite
pnpm test:golden            # CLI console/exit-code goldens
pnpm typecheck
pnpm lint
pnpm format
pnpm build
pnpm test:package           # pack, install, import, and run the CLI
```

## Architecture Overview

The repository is a pnpm workspace.
`packages/fsqlite` is the zero-runtime-dependency Node reference implementation and
published package.
Repo-root `docs/` owns the language-independent `f1.0` format, design,
research, QA, and roadmap material.

An fsqlite store is a caller-provided directory identified by `fsqlite.json`.
`SnapshotStore` captures transaction envelopes and reconciles them into immutable SQLite
snapshots; `DirectStore` synchronously copy-mutates-publishes the same format.
The atomic `current` pointer is the commit point.

## Conventions and Patterns

- Runtime code uses only Node built-ins; do not add runtime dependencies casually.
- Normal open never upgrades the directory format or the caller’s schema.
- Destructive maintenance fails closed and must have failure-path regression coverage.
- Every SQLite table managed through changesets has a non-null primary key.
- `PRAGMA application_id` belongs to fsqlite; `user_version` belongs to the caller.
- Use `apply_patch` for edits and preserve unrelated worktree changes.
- Run `pnpm verify` before closing implementation beads.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
