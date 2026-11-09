---
type: is
id: is-01m6yzw144z987a07bqb7xttv1
title: "PR #5 E1: preserve transaction identity when the post-capture ledger read fails"
kind: bug
status: open
priority: 1
version: 1
labels:
  - pr-5-review
dependencies: []
parent_id: is-01m6yzjs2jwh0a84r8t5txe16x
created_at: 2026-11-09T01:48:23.555Z
updated_at: 2026-11-09T01:48:23.555Z
---
Astra implementation review at f40a530. A retryable reconcile error or raw read error can escape after capture if disposition cannot be read. Preserve the captured transaction ID and report a non-retryable, uncertain outcome.
