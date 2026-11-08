---
type: is
id: is-01m6yd94ch9f0bbczzanqt447n
title: Upstream tbd fixes found during the 0.10.0 upgrade and review
kind: task
status: open
priority: 2
version: 2
labels: []
dependencies: []
parent_id: is-01m6yd8g37a4pkt9xb3pw7x8tf
child_order_hints:
  - is-01kyz4xwksd370tfcr5m5rqn5b
created_at: 2026-11-08T20:23:29.937Z
updated_at: 2026-11-08T20:32:18.541Z
---
Open PRs against jlevy/tbd for fixes identified on fsqlite PR #4: (1) setup replaces customized Claude hook commands and appends duplicate Codex hooks instead of recognizing project-maintained wiring; (2) port closing-hook hardening (git-free fixed-location root, shell-aware push detection, explicit failures) [fsq-dbth]; (3) npx fallback should pass npm_config_before (14-day cool-off) and npm_config_ignore_scripts=true (Review B1); (4) derive the repo root from the script's fixed location and fail closed (B3); (5) ensure-gh-cli.sh should not advise creating tags over the direct API channel (B2); (6) ensure-gh-cli.sh should back up an existing ~/.local/bin/gh before replacing it (B4); (7) skill and prime text recommend unpinned get-tbd@latest (B7); (8) the managed AGENTS.md block is not flowmark-stable, so formatting it makes doctor report drift.
