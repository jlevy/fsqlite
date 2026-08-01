# fsqlite Documentation

For installation and API usage, start with the
[package README](../packages/fsqlite/README.md).
The documents here define the store format, explain the design, preserve its technical
basis, and track validation and future work.

## Documentation Map

| Need | Document | Role |
| --- | --- | --- |
| Recognize, read, or implement an fsqlite store | [FSQL Format Specification](fsql-format-spec.md) | Normative `f1.0` directory, metadata, snapshot, envelope, publication, and upgrade rules |
| Evaluate the architecture and its constraints | [fsqlite Design and Constraints](fsqlite-design.md) | System constraints, rationale, strategy choice, trust boundary, operating envelope, and tradeoffs |
| Assess schema evolution, scale, and local-agent workload fit | [Schema Evolution and Workload Fit](research/research-2026-08-01-schema-evolution-and-workload-fit.md) | Current design-review dispositions, measurements, severity, and adoption boundaries |
| Review the evidence and alternatives | [Portable Concurrent SQLite Research](research/README.md) | Technical research on SQLite sessions, coordination, filesystems, bindings, prior art, and validation gaps |
| Reproduce source-level SQLite and Node claims | [Upstream Source Confirmations](upstream-source-confirmations.md) | Pinned public sources and file-level evidence |
| Verify the SQLite file identifier | [Application ID](application-id.md) | Selection and registry status of the fixed `FSQL` application ID |
| Test a release or evaluate its guarantees | [QA Runbook](qa-runbook.md) | Automated and manual tests mapped to claims and known gaps |
| See current limitations and planned capabilities | [Roadmap](roadmap.md) | User-facing work after the first alpha |
| Publish a release | [Release Runbook](releasing.md) | Bootstrap publication, trusted publishing, verification, and recovery procedures |
| Review dependency policy | [Supply-Chain Security](../SUPPLY-CHAIN-SECURITY.md) | Install, lockfile, lifecycle-script, and release controls |

The format specification is the only normative protocol authority.
The design owns the stable `C1` through `C12` system-constraint registry and explains
how the implementation fits it.
The package README is a consumer guide.
The QA runbook is an evidence index.
The dated research and source confirmations support claims but do not define current
behavior.
The roadmap and project plans track work rather than define shipped guarantees.

## Project Records

These standalone plans preserve decisions, acceptance criteria, and sequencing.
They are maintainer records, not additional design authorities.

- [0.1.0 release plan](project/specs/active/plan-2026-07-31-fsqlite-alpha-release.md)
- [Post-alpha format and portability plan](project/specs/future/plan-2026-07-31-fsqlite-post-alpha-roadmap.md)

## Publication Boundary

This repository contains the reusable technical material needed to understand,
implement, validate, and evolve fsqlite as a standalone project.
It excludes consumer-specific schemas, deployment details, operational data, private
links and paths, and internal planning that does not define fsqlite itself.

Preliminary surveys and comparisons are retained only when they contribute technical
evidence or rationale.
Their reusable findings are consolidated in the
[research report](research/research-2026-06-06-portable-concurrent-sqlite.md), with
public primary sources and current terminology.
Superseded layouts and application assumptions are not part of the public design.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
