---
type: is
id: is-01m6yd94mgrqb0q7kx0786g1km
title: Gate npm publication behind a protected environment and pin workflow actions by SHA
kind: task
status: open
priority: 1
version: 2
labels: []
dependencies: []
parent_id: is-01m6yd8g37a4pkt9xb3pw7x8tf
created_at: 2026-11-08T20:23:30.192Z
updated_at: 2026-11-09T02:08:01.753Z
---
From PR #4 Review B2/B8 and the dependency review: v* tags run publish.yml with id-token: write and no environment gate; actions are pinned by floating tag (the @v6 tag already resolved a release inside the cool-off). Split install/verify from the id-token job, add a protected environment, pin actions by full SHA.

## Notes

PR #5 landed the split workflow, named npm environment, and SHA pins. The maintainer environment configuration remains part of the release setup.
