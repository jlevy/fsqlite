---
type: is
id: is-01kyxzdv6tp0xvrskfgey732yr
title: "PR #1 review I5: derive npm dist-tag from package version"
kind: bug
status: closed
priority: 1
version: 6
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels: []
dependencies: []
parent_id: is-01kyxzayw4jqyc0tty925kttr0
created_at: 2026-08-01T06:15:49.721Z
updated_at: 2026-08-01T06:39:59.712Z
closed_at: 2026-08-01T06:39:59.711Z
close_reason: "Fixed with explicit project policy: ordinary 0.x versions publish under alpha, stable major versions >=1 publish under latest, and the workflow passes the derived tag explicitly. The v0.1.0 owner-authenticated bootstrap remains intentionally one-time."
---
PR #1 engineering review I5. Files: .github/workflows/publish.yml; packages/fsqlite/package.json. Publish prereleases under alpha and stable versions under latest, without permanent bootstrap branches.

## Notes

Review I5 is fixed with the project\u2019s locked release policy, not the review\u2019s suggested prerelease-suffix policy. This project uses ordinary 0.x versions without prerelease suffixes; all 0.x releases remain under alpha, while stable major versions >=1 publish under latest. publishConfig.tag remains alpha as a safe manual default; the trusted tag workflow always passes the derived tag explicitly. The v0.1.0 bootstrap branch remains until the owner-authenticated first publish is verified because npm trusted publishing cannot bootstrap an unclaimed package.
