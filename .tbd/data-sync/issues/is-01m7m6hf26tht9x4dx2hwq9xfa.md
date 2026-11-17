---
type: is
id: is-01m7m6hf26tht9x4dx2hwq9xfa
title: "PR #9 A14: the harness cannot run from a clean checkout and no README says what it needs"
kind: bug
status: closed
priority: 3
version: 2
labels: []
dependencies: []
parent_id: is-01m7m6hdd644jqw5x1wwj4axxn
created_at: 2026-11-17T07:29:00.485Z
updated_at: 2026-11-17T08:15:24.614Z
closed_at: 2026-11-17T08:15:24.613Z
close_reason: "Fixed in b8dde0c: corpus/prereq.py makes the oracle, corpus tools, and FalkorDB arm exit with checkout steps when attic/paraverse is missing; harness/README.md Prerequisites and falkordb/README.md document paraverse at bb9a567 with universe2026-md at a823679 via tbd shortcut checkout-third-party-repo; common.ts checks the S0 KB."
resolution: null
duplicate_of: null
---
Low. Review A https://github.com/jlevy/fsqlite/pull/9#pullrequestreview-5934446288. harness/oracle.py:31-41, corpus/yamlio.py:19-22, corpus/generate2.py:52, falkordb/README.md:28-37. Fix: document attic/paraverse at bb9a567 with universe2026-md at a823679, and fail with a clear message when missing.
