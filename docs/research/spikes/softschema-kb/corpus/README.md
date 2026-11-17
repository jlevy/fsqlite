# Corpus: Synthetic Softschema KBs From S0

A deterministic, seeded generator that scales the real GitHub Universe KB (S0) up to
S1, S2 and S3, plus the W2 delta batches and W4 schema-evolution variants.
Corpora are large, so they live outside the repository, under `$KB_CORPORA/<scale>/`.

## How a Synthetic KB Is Made

A scale is R replicas of S0: 9 for S1, 46 for S2 and 185 for S3 (`idmap.SCALES`).

- **IDs and paths.** Replica 0 keeps every S0 ID and path.
  Replica r appends `-r<r>` to each ID and file stem: `person:pamela-fox-r23`,
  `people/pamela-fox-r23.md`.
  Every ID still matches its schema pattern.
- **Records.** Each record is its S0 file with only its typed IDs, relative Markdown
  links and (for facets) unprefixed `id:` rewritten.
  Field order, formatting, bodies and sizes stay byte-identical to S0, so the kind mix
  and the per-kind field and size distributions are S0's exactly.
- **Cross-links.** For a seeded 20% of pairs between person, organization and session
  records, replica r links to the partner's copy in replica r + k (k from a hash).
  Both payloads and the edge agree, and every copy keeps its S0 degree, so the degree
  distribution is preserved while the graph is connected rather than R disjoint copies.
  Hubs, taxonomy terms and kinds whose edges are derived through a third record
  (profiles, accounts, repositories) never cross replicas.
- **Graph export.** `nodes.jsonl` and `edges.jsonl` are streamed per replica;
  `stats.json` counts are S0's times R; `coverage.json` and `_schemas/` are copied.

Generation streams one replica per worker process, so memory stays at the size of the
S0 templates (about 200 MB per worker).

## Commands

Run with paraverse's synced environment (see `../falkordb/README.md`):

```bash
python generate.py --scale S1 --out $KB_CORPORA/S1          # also S0 (identity copy), S2, S3
python validate.py --kb $KB_CORPORA/S1/kb --sample 40 --out $KB_CORPORA/S1/validation.json
python delta.py --scale S1 --corpus $KB_CORPORA/S1          # deltas/p01, p05, p20
python evolve.py --corpus $KB_CORPORA/S1                    # evolve/<case>/kb
python overlay.py --base $KB_CORPORA/S1/kb --delta $KB_CORPORA/S1/deltas/p05 --out DIR
```

`validate.py` checks graph consistency, that every sampled typed reference resolves,
that each sampled payload equals its S0 template with IDs mapped, and softschema
validation of the sample, the way paraverse's `validation.py` does.

## Scales Generated

Measured on the spike VM (4 vCPUs), with 4 workers:

| Scale | Replicas | Nodes | Edges | Record files | Size on disk | Generation |
| --- | --- | --- | --- | --- | --- | --- |
| S0 | 1 | 5,407 | 25,313 | 4,975 | 39 MB | 1 s, byte-identical to the source |
| S1 | 9 | 48,663 | 227,817 | 44,775 | 327 MB | 2.3 s |
| S2 | 46 | 248,722 | 1,164,398 | 228,850 | 1.7 GB | 7.5 s |
| S3 | 185 | 1,000,295 | 4,682,905 | 920,375 | 6.6 GB | 37 s |

All four validated with no problems (`<scale>/validation.json`).

## Delta Batches and Evolution Variants

`delta.py` writes `deltas/pNN/` for 1%, 5% and 20% of the nodes, 80% new and 20%
updated. New records are copies of non-hub S0 templates under a fresh replica number,
wired like the template's copy in a random existing replica, so they link to existing
entities. Updated records change one value (repository stars, else a bio, abstract,
description, headline or tagline) and are re-serialized with PyYAML.

`evolve.py` writes four complete KB variants, hard-linked to the base except for the
files that change. Edited schemas are re-hashed with softschema's own compiler helpers.

| Case | Change |
| --- | --- |
| `new_kind` | A new `award` kind: schema, one record per 50 people, `awarded_to` and `presented_at` edges |
| `add_field` | Optional `recording_url` in the session schema and in 30% of sessions |
| `rename_relation` | `presents` becomes `speaks_at` in the graph export |
| `string_to_object` | Repository `primary_language: X` becomes `{name: X, source: github-linguist}` |

## Extending for the Second Round

Each planned change has one place to go, so S1 to S3 can be regenerated in a new
directory without touching the current corpora:

- **Growing hubs (C8).** Add a `SHARED` set to `idmap.py` whose `own_id` ignores the
  replica, and have `generate.py` emit those templates in replica 0 only.
  `validate.py` can then report max and p99 degree per scale.
- **Perturbed values and text (C9).** Add a per-replica rewrite of selected literal
  segments in `templates.render`, seeded by `(seed, replica, path)`.
- **Edge-changing updates, deletes, merges and origins (C19, C21).** Extend
  `delta.make_delta` with delete and merge sections in its manifest, and write
  `edges.jsonl` rows tagged with an `origin` record path.
- **Trickle batches, conflicts, invalid records (C18, C20, C22).** Add a `--counts`
  option beside `--pcts` in `delta.py` (it sizes batches in one place, `total`), and an
  `--invalid` flag that writes one record breaking its schema.

## Caveats

- Names and titles repeat across replicas, so search selectivity grows linearly with
  scale rather than following a real vocabulary.
- Replicas share S0's event structure: each has its own four events, days and taxonomy.
- New delta records and updated records are not byte-faithful to the S0 build's YAML
  style (literal blocks and emoji survive; some quoting differs).
- Some derived edges in a cross-linked pair (an expert_in edge derived through a
  profile) follow the replica rule rather than a real derivation; both backends load
  the same export, so comparisons are unaffected.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
