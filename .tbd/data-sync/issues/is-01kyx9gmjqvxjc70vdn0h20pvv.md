---
type: is
id: is-01kyx9gmjqvxjc70vdn0h20pvv
title: Settle the four public API rough edges before they become promises
kind: feature
status: open
priority: 1
version: 3
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase3
dependencies:
  - type: blocks
    target: is-01kyx9gpj0yvtab58tgxy5ezk1
  - type: blocks
    target: is-01kyxna2edqk58qfnw8fyefp62
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:52:52.566Z
updated_at: 2026-08-01T03:19:00.297Z
---
(1) 'constants' is a raw node:sqlite re-export, leaking the binding into the public API of a package that argues its format is binding-agnostic - export a curated typed enum or drop it. (2) backupTo(db, destPath) takes a DatabaseSync the public API gives no clean way to obtain, since read() only lends one inside a callback that closes it. (3) sqliteFacts/isSqliteFile/integrityReport are public in practice (the CLI uses them) but unexported - export or move under cli/. (4) _snapshotVersions() and _publishPointer() are underscore-named to signal privacy but are public and called cross-module (cli/index.ts:112,182; directStore.ts:113), so they land in the published .d.mts as implicitly promised API, alongside eleven readonly path fields.
