---
type: is
id: is-01m7m6hefs8q0s7pgfssfpksyk
title: "PR #9 A10: check-doc-claims.mjs exclusions are wider than needed and untested"
kind: bug
status: closed
priority: 3
version: 2
labels: []
dependencies: []
parent_id: is-01m7m6hdd644jqw5x1wwj4axxn
created_at: 2026-11-17T07:28:59.897Z
updated_at: 2026-11-17T08:15:24.160Z
closed_at: 2026-11-17T08:15:24.160Z
close_reason: "Fixed in 60361a4: editorial exclusion is .json under docs/research/spikes/*/harness/expected/ and */results/ (same globs as .prettierignore, checked by a test); test-count skip is docs/research/spikes/*/fsqlite-v2/ only; check-doc-claims.test.mjs shows a Markdown file under results/ is still checked."
resolution: null
duplicate_of: null
---
Low. Review A https://github.com/jlevy/fsqlite/pull/9#pullrequestreview-5934446288. packages/fsqlite/scripts/check-doc-claims.mjs:16-21, 158, 191-198; .prettierignore:6-8.
