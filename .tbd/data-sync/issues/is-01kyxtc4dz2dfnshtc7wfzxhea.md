---
type: is
id: is-01kyxtc4dz2dfnshtc7wfzxhea
title: Disable the unused uv cache in CI workflows
kind: chore
status: closed
priority: 3
version: 2
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase1
  - ci-finding
dependencies: []
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-08-01T04:47:30.750Z
updated_at: 2026-08-01T04:47:54.886Z
closed_at: 2026-08-01T04:47:54.885Z
close_reason: Confirmed the pinned setup-uv action supports enable-cache and disabled its auto cache in CI and publish workflows, removing Python-lockfile cache annotations from this JavaScript project.
---
The pinned astral-sh/setup-uv action defaults enable-cache to auto. With no Python dependency or lock file, every verification job emits a permanent cache-invalidation annotation. Set enable-cache: false in CI and publish workflows; flowmark is a tiny pinned tool and does not need a Python dependency cache.
