---
type: is
id: is-01m6yzk28668n853npbnxf4whh
title: "PR #5 B5 (Low): a seal into the store root writes a temp that matches the transient grammar, so a concurrent `repair` deletes it"
kind: task
status: open
priority: 3
version: 1
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
created_at: 2026-11-09T01:43:29.797Z
updated_at: 2026-11-09T01:43:29.797Z
---
Review B at f40a530. https://github.com/jlevy/fsqlite/pull/5#pullrequestreview-PRR_kwDOS5UOe88AAAABWvBZRg

`packages/fsqlite/src/snapshotStore.ts:1660-1668`, `:1716-1722`, `:1880-1896`, `:1942-1944`; `docs/fsql-format-spec.md:135-141`, `:745-746`.
`isStoreOwnedPath` allows any root entry other than the marker, pointer and lock, so `seal(<store>/backup.sqlite)` is accepted and stages `<store>/.backup.sqlite.<hex>.tmp`, which spec §2 defines as a transient. While the seal runs, `validate()` reports `in-flight-capture`, gc sweeps it once it is older than `transientStaleMs` (its mtime stops moving during the integrity check of a large export), and `repair` deletes every transient regardless of age, so the seal fails at `fsyncPath` with ENOENT. Traced, not scripted.
