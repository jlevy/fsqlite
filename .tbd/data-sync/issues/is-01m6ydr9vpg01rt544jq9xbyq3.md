---
type: is
id: is-01m6ydr9vpg01rt544jq9xbyq3
title: Core robustness fixes from the 2026-11 correctness review
kind: task
status: closed
priority: 2
version: 2
labels: []
dependencies: []
parent_id: is-01m6yd8g37a4pkt9xb3pw7x8tf
created_at: 2026-11-08T20:31:47.062Z
updated_at: 2026-11-09T02:06:35.133Z
closed_at: 2026-11-09T02:06:35.133Z
close_reason: "Implemented by the comprehensive update merged in PR #5 and verified with pnpm verify and GitHub CI."
resolution: null
duplicate_of: null
---
From fable-core.md findings C6, C7, C10, C11 (same as T12 in opus-ts.md), C12, C15, C16, C17, C18, C19, C20, and C21. C9 is rebutted because libuv fsync uses F_FULLFSYNC on Apple. C22 is documented rather than fixed.
