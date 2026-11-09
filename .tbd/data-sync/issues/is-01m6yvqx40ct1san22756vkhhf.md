---
type: is
id: is-01m6yvqx40ct1san22756vkhhf
title: Prevent a stale sweep from deleting a gc tombstone whose restore failed
kind: task
status: open
priority: 3
version: 1
labels: []
dependencies: []
parent_id: is-01m6yd8g37a4pkt9xb3pw7x8tf
created_at: 2026-11-09T00:36:14.080Z
updated_at: 2026-11-09T00:36:14.080Z
---
From the PR #5 CLI/API pass: when gc's two-phase delete restores a tombstone and the restore fails, the tombstone is reported loudly but a later stale-transient sweep can still delete it. Make the sweep recognize an unrestored tombstone of a still-referenced or leased version.
