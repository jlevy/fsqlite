# Corpus: Synthetic Softschema KBs From S0

A deterministic, seeded generator that scales the real GitHub Universe KB (S0) up to S1,
S2 and S3, plus the W2 delta batches and W4 schema-evolution variants.
Corpora are large, so they live outside the repository, under `$KB_CORPORA/<scale>/`.

## How a Synthetic KB Is Made

A scale is R replicas of S0: 9 for S1, 46 for S2 and 185 for S3 (`idmap.SCALES`).

- **IDs and paths.** Replica 0 keeps every S0 ID and path.
  Replica r appends `-r<r>` to each ID and file stem: `person:pamela-fox-r23`,
  `people/pamela-fox-r23.md`. Every ID still matches its schema pattern.
- **Records.** Each record is its S0 file with only its typed IDs, relative Markdown
  links and (for facets) unprefixed `id:` rewritten.
  Field order, formatting, bodies and sizes stay byte-identical to S0, so the kind mix
  and the per-kind field and size distributions are S0’s exactly.
- **Cross-links.** For a seeded 20% of pairs between person, organization and session
  records, replica r links to the partner’s copy in replica r + k (k from a hash).
  Both payloads and the edge agree, and every copy keeps its S0 degree, so the degree
  distribution is preserved while the graph is connected rather than R disjoint copies.
  Hubs, taxonomy terms and kinds whose edges are derived through a third record
  (profiles, accounts, repositories) never cross replicas.
- **Graph export.** `nodes.jsonl` and `edges.jsonl` are streamed per replica;
  `stats.json` counts are S0’s times R; `coverage.json` and `_schemas/` are copied.

Generation streams one replica per worker process, so memory stays at the size of the S0
templates (about 200 MB per worker).

## Commands

Run with paraverse’s synced environment (see `../falkordb/README.md`):

```bash
python generate.py --scale S1 --out $KB_CORPORA/S1          # also S0 (identity copy), S2, S3
python validate.py --kb $KB_CORPORA/S1/kb --sample 40 --out $KB_CORPORA/S1/validation.json
python delta.py --scale S1 --corpus $KB_CORPORA/S1          # deltas/p01, p05, p20
python evolve.py --corpus $KB_CORPORA/S1                    # evolve/<case>/kb
python overlay.py --base $KB_CORPORA/S1/kb --delta $KB_CORPORA/S1/deltas/p05 --out DIR
```

`validate.py` checks graph consistency, that every sampled typed reference resolves,
that each sampled payload equals its S0 template with IDs mapped, and softschema
validation of the sample, the way paraverse’s `validation.py` does.

## Scales Generated

Measured on the spike VM (4 vCPUs), with 4 workers:

| Scale | Replicas | Nodes | Edges | Record files | Size on disk | Generation |
| --- | --- | --- | --- | --- | --- | --- |
| S0 | 1 | 5,407 | 25,313 | 4,975 | 39 MB | 1 s, byte-identical to the source |
| S1 | 9 | 48,663 | 227,817 | 44,775 | 327 MB | 2.3 s |
| S2 | 46 | 248,722 | 1,164,398 | 228,850 | 1.7 GB | 7.5 s |
| S3 | 185 | 1,000,295 | 4,682,905 | 920,375 | 6.6 GB | 37 s (deleted after round 1) |

All four validated with no problems (`<scale>/validation.json`).

## Delta Batches and Evolution Variants

`delta.py` writes `deltas/pNN/` for 1%, 5% and 20% of the nodes, 80% new and 20%
updated. New records are copies of non-hub S0 templates under a fresh replica number,
wired like the template’s copy in a random existing replica, so they link to existing
entities. Updated records change one value (repository stars, else a bio, abstract,
description, headline or tagline) and are re-serialized with PyYAML.

`evolve.py` writes four complete KB variants, hard-linked to the base except for the
files that change. Edited schemas are re-hashed with softschema’s own compiler helpers.

| Case | Change |
| --- | --- |
| `new_kind` | A new `award` kind: schema, one record per 50 people, `awarded_to` and `presented_at` edges |
| `add_field` | Optional `recording_url` in the session schema and in 30% of sessions |
| `rename_relation` | `presents` becomes `speaks_at` in the graph export |
| `string_to_object` | Repository `primary_language: X` becomes `{name: X, source: github-linguist}` |

## Round 2: Growing Hubs, Perturbation and Batch Format v2

`generate2.py` writes `$KB_CORPORA/<scale>-r2/` (seed namespace `r2`); `generate.py`
still writes the round-1 corpora byte for byte.

- **Shared entities (C8).** All 61 software records, the 25 organizations with the
  highest S0 degree and the topic taxonomy (4 `facet:topic*` facets and their 127 terms)
  exist once, under their S0 IDs, and every replica refers to them, so their degrees
  grow with the scale.
- **Perturbation (C9), replicas 1 and up.** Session slot times shift by up to an hour in
  5-minute steps (never across a date), with the `start` of their `scheduled_on` and
  `held_in` edges; repository stars scale by 0.5 to 2.0; and 30% of sessions, people,
  organizations and repositories have a quarter of the words of their title, abstract,
  bio or description replaced from S0’s vocabulary (3,992 words).
  A changed session title also changes its frontmatter title, node name and search
  document.
- **Origins (C21).** Every edge row has `origin`, the path of the record it is derived
  from: the source’s record if it names the target, else the target’s record if it names
  the source, else the source’s record (when both name each other and only the source is
  shared, the target’s). Every edge is incident to a node of its origin.

| Scale | Nodes | Edges | Record files | Record bytes | Max degree (p99) | Max organization | Max term |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S1-r2 | 46,927 | 226,281 | 44,057 | 135 MB | 4,781 (75) | 3,712 | 1,666 |
| S2-r2 | 238,957 | 1,155,758 | 224,802 | 692 MB | 24,428 (58) | 18,882 | 8,511 |

The largest node is `software:github-copilot` at both scales (533 in round 1).
`manifest.json` has the max and p99 degree of every kind.
Both corpora validate (`validation.json`); the round-1 S3 corpus was deleted after round
1, and its manifest is in `../results/falkordb/S3/corpus-manifest.json`.

### Batch Format v2

`delta2.py --scale S1 --corpus $KB_CORPORA/S1-r2` writes `deltas/<batch>/`:

| Batch | Changes |
| --- | --- |
| `p01`, `p05`, `p20` | 1%, 5% and 20% of the nodes (S1-r2: 469, 2,346, 9,385; S2-r2: 2,390, 11,948, 47,791) |
| `t0001`, `t0010`, `t0100` | 1, 10 and 100 records |
| `t0010-invalid` | `t0010`’s mix with one record that breaks its schema, named in its manifest |

Each batch is 80% new records, about 2% deletes and 1% merges, and the rest updates:
half change a value, half drop one `mentions` reference and add one to a shared entity,
so the record’s edges change.
A batch directory holds `manifest.json` (format `softschema-kb-delta/v2`, counts, the
invalid record), `records/` (the full new file of every upserted record) and
`ops.jsonl`, applied in line order:

- `upsert` (`path`, `nodes`, `edges`, `search`): write the record; replace its node
  rows; delete every edge whose `origin` is `path`; add `edges`, the complete edge set
  derived from the record, each tagged with `origin`; replace its search documents.
- `delete` (`path`, `node_ids`): remove the record, its nodes, every edge with that
  origin, and every other edge incident to those nodes.
- `merge` (`absorbed`, `survivor`, `absorbed_path`, `survivor_path`): replace the
  absorbed node by the survivor at every edge endpoint, rewrite origin `absorbed_path`
  to `survivor_path`, then remove the absorbed node and record.
  Payloads are not rewritten, so other records may still name the absorbed ID.

Deletes and merges never touch a record that the same batch upserts or an entity that a
W3 v2 query names. `delta2.py --apply --base KB --batch DIR --out DIR` is the reference
implementation: it materializes the post-batch KB (hard links, records, `_graph`,
stats), which a full rebuild loads and the oracle reads for the after-batch expected
results.

## Caveats

- Round 1 only: names and titles repeat across replicas, so search selectivity grows
  linearly with scale, and no degree grows (round 2 fixes both).
- Replicas share S0’s event structure: each has its own four events and days.
- New delta records and updated records are not byte-faithful to the S0 build’s YAML
  style (literal blocks and emoji survive; some quoting differs).
- Some derived edges in a cross-linked pair (an expert_in edge derived through a
  profile) follow the replica rule rather than a real derivation; both backends load the
  same export, so comparisons are unaffected.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
