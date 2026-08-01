---
type: is
id: is-01kyx98pmmk1k8eran9a8ks43a
title: Scaffold pnpm workspace and supply-chain hardening config
kind: task
status: closed
priority: 1
version: 4
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase1
dependencies:
  - type: blocks
    target: is-01kyx98q02gh0k8bzswyzg0pff
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:48:32.531Z
updated_at: 2026-08-01T01:26:59.228Z
closed_at: 2026-08-01T01:26:59.225Z
close_reason: Added a private pnpm workspace, pinned pnpm 11.14.0, and enforced the 14-day release-age gate with zero allowed lifecycle builds.
---
Private root package.json with workspace scripts; pnpm-workspace.yaml with packages: [packages/*], minimumReleaseAge: 20160, blockExoticSubdeps: true, allowBuilds: []; packageManager pinned to the newest pnpm 11.x clearing the 14-day cool-off; .npmrc; .nvmrc. Note pnpm 11 reads minimumReleaseAge from pnpm-workspace.yaml and its default is only 1 day.
