---
type: is
id: is-01kyzze11aj30hc4mc4qkb9qvf
title: Clarify SQLite engine reuse and shared-filesystem benefit
kind: task
status: closed
priority: 2
version: 15
labels: []
dependencies: []
created_at: 2026-08-02T00:54:24.550Z
updated_at: 2026-08-02T03:01:03.421Z
closed_at: 2026-08-02T03:01:03.420Z
close_reason: "Clarified SQLite locking and engine reuse, simplified both README openings, added the concrete store layout, and documented scoped point-in-time exports; PR #3 is updated and green."
---
Revise the root and package READMEs and directly affected design/research docs so they explain that fsqlite is a format and packaging strategy around the same SQLite engine, not a replacement database. Make the shared-filesystem benefit explicit: ordinary SQLite depends on correct POSIX byte-range locking and, for WAL, shared memory; fsqlite coordinates cooperative agents through immutable generations and a smaller filesystem publication protocol. Verify every technical claim against existing research and primary upstream sources, and state any Claude Code cloud example only to the level supported by public evidence.
