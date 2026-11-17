# Softschema KB Spike: the fsqlite Arm

This directory holds the fsqlite half of the storage spike that
[WORKLOAD.md](../WORKLOAD.md) specifies.
It imports a softschema knowledge base (KB) into fsqlite, serves the W3 queries from
`harness/queries.json`, applies incremental batches from concurrent writers, evolves the
schema, and exports the KB back to its original files.
It uses fsqlite only through its public API (`packages/fsqlite/src/index.ts`), runs its
TypeScript on Node with type stripping, and adds no npm dependencies.
Python, with the standard library and PyYAML, does the YAML work on both ends.

The code is temporary research code for the research brief
`docs/research/research-2026-11-17-softschema-kb-storage.md`.
Numbers come from one cloud VM (4 vCPUs, 16 GB RAM, ext4, Node 22.23.4, SQLite 3.53.4),
so they show relative sizing, not portable rates.

## How to Run

```bash
docs/research/spikes/softschema-kb/fsqlite/run.sh S0   # then S1, S2
python3 docs/research/spikes/softschema-kb/fsqlite/summary.py S0 S1 S2
python3 docs/research/spikes/softschema-kb/harness/compare.py \
  docs/research/spikes/softschema-kb/harness/expected/S1/w3.json \
  docs/research/spikes/softschema-kb/results/fsqlite/S1/w3.json
```

`run.sh` writes `results/fsqlite/<scale>/*.json` and keeps working stores under
`$KB_SCRATCH/fsqlite-spike/<scale>/`.
Synthetic corpora, W2 deltas, and W4 variants come from the shared `kb-corpora/` that
`corpus/` generates.
Python steps run as
`uv run --no-project --with pyyaml --exclude-newer 2026-11-03 python ...`.

## Files

| File | Role |
| --- | --- |
| `parse_kb.py` | Python pass: KB, delta batch (`--delta`), or KB diff (`--diff`) to intermediate JSONL |
| `mapping.ts` | Generic mapping (a): DDL from table views, derived fields, the streaming loader |
| `typed.ts` | Typed mapping (b): per-kind tables generated from the compiled schemas |
| `load.ts` | W1 import through DirectStore or SnapshotStore, with per-phase timings |
| `w1.ts` | W1 orchestration: parse and import as separate measured processes, gc, FTS sidecar |
| `control.ts` | Plain SQLite control arm (C15) for W1 and W3, with the same DDL and SQL |
| `queries.ts` | Every W3 query, plus statement tracing for `EXPLAIN QUERY PLAN` |
| `w3.ts` | W3 runner: cold then warm runs, plans, optional per-query timeout |
| `plans.ts` | Plan audit for the table queries (C7): planner choice against `INDEXED BY` |
| `fts.ts` | FTS5 trigram search sidecar, a rebuildable projection outside the store |
| `w2.ts`, `w2_worker.ts` | W2: 4 writer processes and a W3 reader per delta batch, then reconcile |
| `trickle.ts` | W2 trickle (C18): 1, 10, 100 records, and a sustained run |
| `conflict.ts` | W2 conflicting writes (C20) under each conflict policy |
| `w4.ts`, `migrate.ts` | W4 on the shared evolve variants; side-by-side copy for DDL changes |
| `export_kb.py`, `w5.ts` | W5 export with Python `sqlite3`, fidelity check, reload into W3 |
| `w6.ts` | W6 operations: artifacts, standard tools, start-up, memory, crash tests |
| `common.ts`, `fsq.ts`, `measure.py` | Shared helpers, the fsqlite import, wall time and peak RSS |
| `summary.py`, `run.sh` | Headline tables, and the per-scale run order |

## Mapping Design

The arm uses mapping (a), a generic and schema-driven layout, for every workflow.
Mapping (b), typed tables, is built in W4 for comparison.

| Table | Primary key | Holds |
| --- | --- | --- |
| `entity` | `id` | `kind`, export `name`, display `label`, `path`, `payload` (JSON text as parsed), `derived` (JSON) |
| `edge` | `(source, relation, target, ord)` | Edge attributes as JSON; `ord` numbers parallel edges in file order |
| `search_text` | `(id, rank)` | Lowercased display name (rank 0), `payload.title` (1), `payload.bio` (2) |
| `doc` | `path` | Frontmatter keys in order with the owner's payload nulled, Markdown body |
| `kind_schema` | `kind` | Compiled schema JSON and the browser's field descriptions |
| `kb_file`, `kb_line` | `path`, `(path, n)` | Opaque files and the lines of opaque `.jsonl` files |

- **Constant DDL.** A new kind or field needs no DDL, because both live in JSON.
  The DDL depends only on the UI's table views.
  Each view (kind, equality filter, sort) becomes one partial expression index
  `(filter, sort, id) WHERE kind = '<kind>'`.
  The page is an ordered range scan of that index, and its total is an index count.
- **Derived fields.** `derived` holds what paraverse promotes to FalkorDB properties: a
  session's `start_epoch` and a `start_key` that sorts missing values last.
  `label` follows paraverse's `readable_name`.
  Payloads are never rewritten, so export stays exact.
- **No foreign keys, triggers, virtual tables, or `ON CONFLICT` clauses.**
  Every table has a non-null primary key, so both store types accept the schema.
  Foreign keys from `edge` to `entity` were left out on purpose: SnapshotStore checks
  them at each envelope boundary, so an edge to a record another writer adds in the same
  reconcile would quarantine by envelope order.
- **Indexes.** `(kind, label, id)`, a covering `(id, kind)` for joins that only need a
  kind, `path`, the view indexes, and `edge (target, relation, source)` and
  `(relation, target, source)` beside the primary key.
- **Graph queries.** Neighborhoods are one recursive CTE.
  Paths use the application-side bidirectional breadth-first search that both arms
  share, one SQL statement per frontier; the in-engine recursive CTE is reported
  separately with a timeout.

### Search and FTS5

`node:sqlite` in Node 22.23.4 has FTS5 (`ENABLE_FTS5`, and the trigram tokenizer works).
fsqlite rejects a virtual table in a store schema, for DirectStore and SnapshotStore
alike, with
`FsqliteError [incompatible]: table "f" has no primary key; fsqlite requires a NON-NULL primary key`.
The check is `validatePrimaryKeys` in `packages/fsqlite/src/snapshotStore.ts` (lines 298
to 345), which `init()` calls at line 691; DirectStore inherits it through
`DirectStrategyStore` (`directStore.ts`, line 56).
A write callback also cannot create a TEMP virtual table (`refused`: "application
callback changed the SQLite temporary schema"), but a read connection can.

So the arm reports two search figures: the canonical substring scan of `search_text`,
which lives in the store and changes with every envelope, and an FTS5 trigram sidecar
(`fts.ts`), an ordinary SQLite file built from the published head and attached
read-only.
The sidecar must be rebuilt for every published version; W1 and W2 count that rebuild.
A trigram phrase `MATCH` returns the same rows as the substring oracle for these terms.
The first sidecar query used `LIKE ... ESCAPE`, which bypasses the trigram index and was
no faster than the scan; `MATCH` fixed it.

## Results

RESULTS_PLACEHOLDER

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
