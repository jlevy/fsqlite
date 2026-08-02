---
type: is
id: is-01kyzwa247jqcz4wzc2f77tbfe
title: Lead READMEs with SQLite portability and stability
kind: task
status: closed
priority: 2
version: 3
labels: []
dependencies: []
created_at: 2026-08-01T23:59:48.870Z
updated_at: 2026-08-02T00:09:26.513Z
closed_at: 2026-08-02T00:09:26.512Z
close_reason: Both README surfaces and package metadata now lead with SQLite portability, long-term stability, agent-focused packaging, and the official session/changeset basis; local verification and all PR checks passed.
---
Reorder and revise the root and package README introductions so SQLite portability and long-term stability are the first two product properties. Explain that fsqlite uses SQLite itself, including the official session extension and changeset APIs, while adding the filesystem publication protocol needed for cooperative multi-client use.
