---
type: is
id: is-01m7m6hge2883wee6c2msat7x0
title: "PR #9 B5: the launcher flags do not pin the registry, and the cache is trust on first use"
kind: bug
status: closed
priority: 3
version: 2
labels: []
dependencies: []
parent_id: is-01m7m6hdd644jqw5x1wwj4axxn
created_at: 2026-11-17T07:29:01.890Z
updated_at: 2026-11-17T08:15:25.711Z
closed_at: 2026-11-17T08:15:25.711Z
close_reason: "Fixed in 02d018a: the fallback pins --registry=https://registry.npmjs.org/ on both the lookup and npx; SUPPLY-CHAIN-SECURITY.md and the launcher comments say command-line flags override an inherited registry, before, or ignore-scripts, that the dedicated cache is trust on first use, and that uvx reads UV_CONFIG_FILE (a stricter exclude-newer there stops the formatter, checked with uv 0.11.32)."
resolution: null
duplicate_of: null
---
Review B https://github.com/jlevy/fsqlite/pull/9#pullrequestreview-5934384031. Low. Launchers and SUPPLY-CHAIN-SECURITY.md:79-82. Fix: --registry, document inherited before and UV_CONFIG_FILE, correct comments.
