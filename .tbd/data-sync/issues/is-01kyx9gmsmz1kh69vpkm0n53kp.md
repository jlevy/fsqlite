---
type: is
id: is-01kyx9gmsmz1kh69vpkm0n53kp
title: Rewrite the package README as an npm landing page
kind: task
status: open
priority: 1
version: 2
spec_path: docs/project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md
labels:
  - phase3
dependencies:
  - type: blocks
    target: is-01kyx9gpj0yvtab58tgxy5ezk1
parent_id: is-01kyx97rm9wx146e3awnjr9can
created_at: 2026-07-31T23:52:52.787Z
updated_at: 2026-07-31T23:53:10.775Z
---
Currently unfit: NO install instructions anywhere in 176 lines, no badges, no license section, Node floor buried at line 170, no API reference, no comparison table, and the Develop section is 26% of the doc. Limitations are real but scattered across seven places. Relative docs/ links resolve to nothing on npmjs.com because files excludes them - use absolute URLs. Target ~120-140 lines: pitch, badges, install, quickstart, condensed comparison table (the research doc has a good one at :995-1004), contract summary, consolidated Limitations/Status, CLI table, links out. Do not restate the design doc - link it.
