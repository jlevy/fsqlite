# Draft Sections: Storage for Accumulating Softschema Knowledge Bases

**Status:** working notes from the research agents, kept as inputs to
`docs/research/research-2026-11-17-softschema-kb-storage.md`. Paths written `<scratch>/`
refer to the session’s scratch directory and are not in the repository.

**Date:** 2026-11-17

**Status:** Draft analysis for
`docs/research/research-2026-11-17-softschema-kb-storage.md`. It was written before the
spike benchmarks existed.
It is input for the Findings, Recommendations and Methodology sections of that brief.

## How to Read This Draft

Every statement that carries a `path:line` citation was checked against that source.
Other statements carry one of these labels:

- **Measured:** observed in a scratch probe on the research VM, described in Appendix A.
  The probes are single runs for sizing.
  They are not the spike benchmark.
- **Inferred:** derived from the cited design or from a linear extrapolation of an S0
  measurement. Each needs the benchmark before the brief states it as a finding.
- **Open:** a question that only the benchmark or the maintainer can settle.

The spike code under `docs/research/spikes/softschema-kb/` was being written while this
draft was prepared. Section 6 cites it by file as it stood at about 01:00 on 2026-11-17.

Citation prefixes:

| Prefix | Source | Revision |
| --- | --- | --- |
| `pv/` | `<repo>/attic/paraverse` | commit `bb9a567` (2026-10-24) |
| `pg/` | `pv/db/src/paraverse_graph/` | same |
| `u26/` | `pv/vendor/universe2026-md`, the S0 dataset with its build pipeline | commit `a823679` (2026-10-24) |
| `ss/` | softschema 0.8.1 source distribution from PyPI | sha256 `e368eed6...94e7`, as pinned in `pv/db/uv.lock:954` |
| `fl/` | falkordblite 0.10.0 wheel, package `redislite` | bundles FalkorDB 4.18.3 and Redis 8.6.2 (Measured) |
| none | fsqlite repository paths, such as `docs/fsqlite-design.md` | working tree of 2026-11-17 |
| FalkorDB docs | pages under `https://docs.falkordb.com` | retrieved 2026-11-17 |

The submodule checkout holds the full KB build code under `u26/pipeline/`, so no
separate clone was needed.
`pv/vendor/ptc2026-md` is not checked out, so the composition analysis rests on code and
tests alone.

## Summary of Conclusions

1. **Paraverse’s import is generic because the dataset build does the specific work
   first.** The build derives every edge with per-kind code and writes a graph export.
   The importer copies that export, stores each payload as a JSON document, and renders
   the browser from compiled schemas.
   About a dozen code tables still name kinds, fields and indexes, and a new kind needs
   code changes today (section 1.2).
2. **Paraverse rests on assumptions that the target use case breaks.** Records are a
   regenerated build output, a full rebuild takes seconds, and the corpus fits in memory
   several times (section 1.6).
3. **softschema gives an importer a self-describing record, a compiled JSON Schema and a
   schema hash.** It does not give identity, references, relations, field order, index
   hints, a canonical record serialization, or any link between contract versions.
   Declared annotations for those are the main lever for a generic importer (section
   2.3).
4. **Parsing and validation dominate consolidation, not the database.** Measured at S0:
   0.27 ms per record to parse YAML with libyaml and 9.9 ms to validate with softschema,
   against 0.3 ms per node to load FalkorDB and 0.09 ms to load SQLite.
   A parse and validation cache keyed by content hash keeps a full rebuild affordable at
   1M documents (sections 3.1 and 3.6).
5. **Files in git work as the system of record to about 100k documents.** Above that,
   file count and single-file exports fail first.
   JSONL is the right interchange and cache format.
   Neither database should be the system of record for data that people review (section
   4.2).
6. **FalkorDB fits traversal-heavy serving of a corpus that fits in memory.** Its
   persistence is a version-coupled memory image, its atomic unit is one query, and
   FalkorDBLite is documented as a development tool.
   Inferred: 9 to 19 GB of memory per million documents before the staging copy
   (sections 3.1 and 5.1).
7. **fsqlite fits immutable published generations and compact multi-writer stores.**
   Every write copies the whole file, the schema is fixed per store, and a store cannot
   hold an FTS5 index. At 100k documents and above it is a batch publication format, not
   a per-document write store (sections 5.1 and 5.2).
8. **A rebuildable projection makes fsqlite’s fixed schema free.** It also makes a plain
   SQLite file an equivalent serving artifact.
   The benchmark needs a plain SQLite control to show what the fsqlite protocol adds and
   what it costs (section 5.2).
9. **The S0 probes show no graph-query advantage for FalkorDB.** Indexed joins and an
   application-side bidirectional search were faster.
   This needs the benchmark, with the same algorithm on both backends and a corpus whose
   hubs grow (sections 5.3 and 6.3).
10. **WORKLOAD.md needs corrections.** The S0 row miscounts files and bytes.
    The query semantics live in the harness and not in the specification.
    The synthetic corpus keeps hub degree constant and repeats every value.
    W1 mixes parser cost into the comparison.
    W2 has no single-record updates, no edge-changing updates, no deletes and no
    conflicts (section 6).

## 1. How Paraverse Does It

### 1.1 The Data Flow From Sources to Browser

```text
public sources: RainFocus, githubuniverse.com, GitHub, registries, websites, Bright Data
  -> u26 collection commands: save raw snapshots and raw/manifest.json
  -> universe-kb build (offline, deterministic): raw/ + curation/ + synthesis/
       writes a .kb-* staging tree, then renames it to kb/
         kb/<kind dirs>/  softschema records: 1,420 Markdown files, 3,557 YAML files
         kb/_schemas/     18 compiled JSON Schemas, one per contract
         kb/_graph/       nodes.jsonl, edges.jsonl, stats.json, coverage.json
         kb/_search/      documents.jsonl
  -> git commit in the dataset repository; paraverse pins it as a submodule
  -> paraverse-graph load: read _graph, the artifacts and _schemas;
       build a staging graph; check it; RENAME it over the live graph
  -> FalkorDB graph in a FalkorDBLite redis-server process, persisted as one RDB file
  -> Starlette read-only JSON API with server-sent events
  -> static browser, CLI and Swift client
```

The stages, with their evidence:

1. **Collection.** Each fetching command saves source snapshots under `raw/` and records
   URL, retrieval time and SHA-256 in `raw/manifest.json`
   (`u26/docs/project/architecture/arch-2026-10-24-conference-kb.md:105-109`). Fetches
   are incremental and skip what the snapshot already holds
   (`u26/pipeline/README.md:84-91`).
2. **KB build.** The build is offline and deterministic.
   It validates each payload against its Pydantic model, writes into a fresh directory,
   and swaps it into place only when every artifact was written
   (`u26/pipeline/src/universe_kb/build.py:5-7`, `936-970`). The swap is two renames
   under a lock file: the old tree moves aside, then the staging tree takes its name
   (`u26/pipeline/src/universe_kb/publication.py:14-43`).
3. **Records.** Each entity is one artifact.
   The writer emits a `softschema:` block with `contract`, `schema`, `envelope` and
   `status`, then the payload under the envelope key
   (`u26/pipeline/src/universe_kb/artifacts.py:102-112`). Markdown records also get a
   top-level `title` key and a generated body (`artifacts.py:108-110`). Null values and
   empty collections are pruned before writing (`artifacts.py:77-88`). The KB is a build
   output: the pipeline guide says it is generated and must not be edited by hand
   (`u26/pipeline/README.md:35`).
4. **Derived exports.** The build copies the compiled schemas into `kb/_schemas/`
   (`build.py:955-958`), derives nodes and edges from the validated models and fails if
   any edge points at a missing entity
   (`u26/pipeline/src/universe_kb/graph.py:180-197`), writes `stats.json` and
   `coverage.json` (`graph.py:200-214`), and writes one search document per entity
   (`u26/pipeline/src/universe_kb/search.py:83-128`).
5. **Import.** `load_kb` reads the three graph files, then every artifact a node points
   at (`pg/kb.py:201-264`). The graph export is the authority for which nodes and edges
   exist, the artifact payload is the only source of property values, and Markdown
   bodies are never read (`pg/kb.py:5-8`). `load_graph` writes a uniquely named staging
   graph in batches of 500 rows per Cypher `UNWIND` (`pg/loader.py:46`, `134`,
   `157-175`), creates indexes (`loader.py:177`, `273-280`), compares node counts per
   kind and edge counts per relation with `stats.json`, checks for duplicate IDs
   (`loader.py:189-193`), writes one `Schema` node per kind (`loader.py:195-197`,
   `283-298`), creates a unique constraint on `Entity.id` (`loader.py:200`, `316-346`),
   writes a `GraphMeta` node (`loader.py:203-222`), rechecks that the KB files did not
   change (`loader.py:226`), and replaces the live graph with a Redis `RENAME`
   (`loader.py:227`).
6. **Notification.** After the rename the loader publishes `graph.loaded` on a Redis
   channel (`loader.py:231-244`). A subscriber thread in the server invalidates cached
   schemas and forwards the event to browsers as a server-sent event
   (`pg/browser.py:927-968`, `813-846`).
7. **Serving.** Every HTTP data route is a read-only query with a 4 second timeout
   (`pg/browser.py:61-63`, `276-294`). Named catalog queries are the only Cypher the API
   runs (`pg/queries.py:1-8`).

Two exports that the build writes are not consumed by the importer.
`_search/` appears in `pg/` only as a directory that validation skips
(`pg/validation.py:26`), and the loader builds its own `search_text` property instead
(`pg/mapping.py:318-339`). `coverage.json` is not read at all.

### 1.2 How the Import Stays Generic

The import is generic in three ways.

- **The export decides structure.** One node per line of `nodes.jsonl` and one
  relationship per line of `edges.jsonl` (`pg/kb.py:218-232`). The relation name becomes
  the relationship type in upper case after an identifier check
  (`pg/mapping.py:102-104`, `342-345`), and every edge attribute becomes a relationship
  property (`pg/mapping.py:156-173`). A relation that the KB build adds therefore loads
  with no code change
  (`pv/docs/project/architecture/arch-2026-10-24-graph-database.md:142-143`).
- **The payload decides properties.** Every top-level scalar and list of scalars is
  copied as a property (`pg/mapping.py:134-139`, `176-189`). Strings that match the
  typed-ID pattern are dropped from properties because the export already carries them
  as relationships (`pg/mapping.py:63-66`, `180-187`). The whole payload is also stored
  as a JSON string in `doc`, because FalkorDB properties cannot hold maps
  (`pg/mapping.py:152`,
  `pv/docs/project/architecture/arch-2026-10-24-graph-database.md:366`).
- **The compiled schema decides presentation.** `load_kind_schemas` reads every
  `*.schema.yaml` and flattens it into a field list with name, title, description, JSON
  type, list flag, required flag, enum, nested definition and reference target kinds
  (`pg/schemas.py:56-80`, `155-204`). Reference targets are recovered from the `pattern`
  that the dataset models attach to typed-ID fields (`pg/schemas.py:53`, `241-251`;
  `u26/pipeline/src/universe_kb/models.py:32-58`). The loader stores the field list, the
  nested definitions and the raw schema in a `Schema` node per kind
  (`pg/loader.py:283-298`). The browser reads fields from those nodes
  (`pg/browser.py:348-371`), builds relationship columns from statistics stored in
  `GraphMeta` (`pg/loader.py:301-313`, `pg/browser.py:404-431`), types its sort and
  filter expressions from the field descriptions (`pg/browser.py:1004-1024`,
  `1068-1089`), and renders any record from the field list plus the parsed `doc`
  (`pg/browser.py:668-695`).

The result is real: a new optional scalar field appears in tables and record views
without a code change, and so does a new relation.

Kind-specific code still exists in the following places.

| Where | What is specific | Evidence |
| --- | --- | --- |
| Kind to label table | Fixed list of 18 kinds. An unknown kind raises `MappingError`. | `pg/mapping.py:31-50`, `82-84` |
| Schema loading | Only kinds present in the label table get a schema description. | `pg/schemas.py:74` |
| Typed-ID prefixes | Closed prefix lists in three places: the reference regex, the prefix to kind map, and the front end. The regex omits `page`, which the other two include. | `pg/mapping.py:63-66`, `pg/schemas.py:26-45`, `pg/web/js/values.js:8-9` |
| Nested kinds | Days live inside events and terms inside facets. | `pg/kb.py:31`, `pg/schemas.py:48-51`, `pg/kb.py:127-142` |
| Derived labels | `Account`, `Sponsor`, and one label per participation role. An unknown role raises. | `pg/mapping.py:53-61`, `87-97` |
| Promoted nested fields | `_session_fields`, `_event_fields`, `_organization_fields`, `_person_fields`, `_profile_fields`. | `pg/mapping.py:215-284` |
| Search text | Fixed list of twelve field names plus aliases. | `pg/mapping.py:286-299`, `318-339` |
| Indexes | `RANGE_INDEXES` and `FULLTEXT_INDEXES` name specific labels and properties. | `pg/loader.py:53-65` |
| Browser tables | Sidebar groups, default columns, computed column types, card fields, image fields, and a sort special case for session times. | `pg/browser.py:72-158`, `1021-1022` |
| Query catalog | Fifteen named Cypher queries written against specific labels and relations. | `pg/queries.py:120-300` |
| Review and overview | Data-quality checks and coverage tables written per kind. | `pg/review.py:34-372`, `pg/overview.py:70-150` |
| Composition | The person merge rule reads GitHub and social account edges. | `pg/composition.py:52-59`, `151-182` |
| Upstream edge derivation | The dataset build derives every edge with one `match` arm per model class. One arm names the 2026 event literally. | `u26/pipeline/src/universe_kb/graph.py:42-158`, `107` |
| Upstream path layout | One path template per ID prefix. | `u26/pipeline/src/universe_kb/artifacts.py:24-52` |

Three consequences follow.

- Adding a kind needs code today.
  The loader raises on an unknown kind, the schema reader ignores its schema, and its
  typed IDs are not recognized as references.
  The browser architecture document says a new kind appears with no front-end change
  (`pv/docs/project/architecture/arch-2026-10-24-kb-browser.md:35-38`). That holds for
  the JavaScript rendering path only if the prefix list is also extended.
- Adding a field does not add a promoted property, an index or a relationship.
  The integration guide states this directly (`pv/docs/app-integration.md:22-25`).
- The generic part of the import depends on the dataset build doing the kind-specific
  graph derivation first.
  Paraverse moved that logic upstream.
  It did not remove it.

### 1.3 Dataset Composition and Selection

- **One dataset, one graph.** A dataset is a KB directory.
  Commands resolve it from `--kb`, `--dataset`, an environment variable, or the default
  (`pg/datasets.py:53-71`). Each dataset loads into its own named graph, so several
  share one FalkorDB database (`pg/datasets.py:99-106`).
- **Composition is an in-memory merge keyed by typed ID.** `compose_kbs` loads each
  source KB completely, merges their schemas, and groups nodes by ID
  (`pg/composition.py:26-44`). It rejects one ID used by two kinds
  (`composition.py:50-51`). It rejects a person ID present in two sources unless both
  sources link that person to a shared verified account (`composition.py:52-59`,
  `151-182`). Names alone never merge people (`pv/db/README.md:132-133`).
- **Merge rules.** Mappings merge key by key.
  Lists merge as a union in source order, with typed entities matched by ID. Scalars
  that disagree keep the first non-null value in dataset-name order, and every variant
  is recorded under `_composition.conflicts` (`composition.py:185-231`). Each merged
  record keeps its source datasets, paths and contracts under `_composition.sources`
  (`composition.py:63-74`). Identical edges are deduplicated and tagged with a
  `_datasets` attribute (`composition.py:84-95`).
- **Schemas merge by union.** Properties and enum values are united, only requirements
  shared by every source stay required, and incompatible constraints become `anyOf`
  alternatives (`pg/schemas.py:83-152`).
- **Selection materializes another graph.** The server composes the selected sources and
  loads the result into a separate graph named `<graph>__browser_<port>_<random>`
  (`pg/cli.py:339-348`). A selection change is a full rebuild of that graph under a
  build lock, and a failed build keeps the previous view (`pg/selection.py:92-149`). The
  selection is shared by every client of the server (`pv/db/README.md:114-117`).

Composition is materialized because FalkorDB cannot query across graphs
(`pv/docs/project/architecture/arch-2026-10-24-graph-database.md:313-314`). Each
combined view therefore costs a full parse of every source in Python plus one more graph
in server memory (Inferred from `composition.py:35` and `selection.py:110-121`).

### 1.4 Watch and Reload

- **Direct graph with `--watch`.** A thread watches the KB’s parent directory and the
  `_graph` directory. It identifies a build by the inode, modification time and size of
  `stats.json`, debounces for 2 seconds, polls every 5 seconds, and backs off to at most
  one minute after a failed load (`pg/cli.py:419-497`). A reload is a full `load_kb`
  plus a full `load_graph`, and a failed reload deletes its staging graph
  (`pg/cli.py:409-416`).
- **Selected views.** A thread polls the `stats.json` signature of every selected source
  every 5 seconds and rebuilds the combined graph when one changes (`pg/cli.py:392-406`,
  `pg/selection.py:158-182`). Transient failures retry after 30 seconds, doubling to
  five minutes. Content failures wait for a new build (`pg/selection.py:122-142`).
- **Missed events.** Routes that use cached schemas compare a stamp read from
  `GraphMeta` and invalidate when it changed, so a lost pub/sub message does not leave a
  stale catalog (`pg/browser.py:329-346`).
- **What the watcher does not do.** It does not pull git, run the dataset build, or
  repeat softschema validation.
  Editing a record without publishing a new `stats.json` triggers nothing
  (`pv/docs/app-integration.md:71-76`).
- **Consistency during a build.** The loader takes a metadata snapshot of every file
  under the KB root before reading and compares it after reading and again before the
  swap (`pg/kb.py:210`, `263`, `267-291`; `pg/loader.py:226`). The check cannot tell a
  paused partial in-place build from a complete one, so producers must publish
  atomically (`pg/kb.py:269-272`).
- **Readers.** Separate API requests do not share a pinned view.
  A client that needs a consistent multi-request screen must compare the load identity
  before and after and retry (`pv/docs/app-integration.md:110-112`).

### 1.5 How Paraverse Validates

| Layer | What it checks | When | Evidence |
| --- | --- | --- | --- |
| Producer models | Closed Pydantic models at every level, status `enforced`, each payload validated before writing | Every KB build | `u26/pipeline/src/universe_kb/models.py:102-103`, `artifacts.py:21`, `build.py:5-7` |
| Producer graph | Every edge endpoint exists, or the build fails | Every KB build | `graph.py:192-197` |
| Producer validate command | Each artifact through its own `softschema:` block, structural and semantic layers | On demand and in `make check` | `u26/pipeline/src/universe_kb/schemas.py:57-83`, `u26/pipeline/README.md:154-162` |
| Loader, always | Export files exist, JSONL lines parse and carry required keys, every referenced artifact exists, one envelope per artifact, envelope equals node kind, a contract is named, every node resolves to a payload | Every load | `pg/kb.py:205-208`, `330-355`, `241-249`, `294-313`, `127-142` |
| Loader, opt-in | softschema structural validation of every artifact against the schema it names, at the status it declares. Nothing loads if one artifact fails. | `load --validate` | `pg/validation.py:91-120`, `pg/cli.py:199-229` |
| Staging graph | Node counts per kind and edge counts per relation equal `stats.json`, no duplicate IDs, unique constraint operational | Every load, before the swap | `pg/loader.py:189-193`, `316-381` |
| Review checks | Data-quality heuristics as Cypher. They report and do not gate. | In the browser | `pg/review.py:1-6`, `375-393` |

Four limits matter for the brief.

- Full validation is opt-in because it is slow.
  The source says about 40 seconds for the full KB against about 2 seconds for a load
  (`pv/db/README.md:236`, `pg/validation.py:8-9`). Measured: 9.9 ms per artifact, about
  49 seconds for S0.
- The default load parses records with PyYAML and a timestamp override
  (`pg/kb.py:36-50`, `158`). Only the opt-in path uses softschema’s portable reader
  (`pg/validation.py:95-99`). A default load can therefore accept YAML that softschema
  rejects, such as anchors or duplicate keys (`ss/docs/softschema-spec.md:138-140`). The
  reverse also occurs: the loader requires the `softschema:` value to be a mapping
  (`pg/kb.py:172-174`), while softschema also accepts a compact string form
  (`ss/packages/python/src/softschema/models.py:116-121`).
- The database enforces only the unique ID. `Schema` nodes do not make FalkorDB enforce
  contracts (`pv/docs/app-integration.md:32-34`).
- The load digest covers `nodes.jsonl` and `edges.jsonl` only.
  A payload-only change keeps the same digest (`pg/kb.py:212-216`,
  `pv/docs/app-integration.md:114-116`).

### 1.6 Assumptions

| Assumption | Evidence | What it implies for the target use case |
| --- | --- | --- |
| The KB is a pure function of saved inputs. Records are generated and never hand-edited. | `u26/pipeline/README.md:35`, `136-139`; `pv/docs/project/architecture/arch-2026-10-24-kb-browser.md:53-54` | In the target use case crawlers and agents write records directly. There is no upstream from which to regenerate them, so normalization, backlinks and edges need another home. |
| A full rebuild is cheap. | “Loading the whole KB takes a couple of seconds, so incremental `MERGE` loads are not needed” (`pv/docs/project/architecture/arch-2026-10-24-graph-database.md:182-183`); `pg/loader.py:1-10` | Measured at S0: 1.8 s to read and 1.7 s to load. Both grow with corpus size, not with change size. |
| The corpus fits in memory several times. | All artifacts are parsed into one dictionary (`pg/kb.py:235-249`). All node property rows, including `doc`, are built before the first write (`pg/loader.py:252-261`). Staging and live graphs coexist until the rename (`loader.py:227`). | Inferred: the Python loader and the doubled graph are the first memory failures at S2 and S3. |
| Size is not a design constraint. | `pv/docs/project/architecture/arch-2026-10-24-graph-database.md:91-93` | The browser asks for 2,000 rows so every kind fits on one page (`pg/browser.py:54-56`). The overview reads every `doc` in one query (`pg/overview.py:59-61`). Two review checks compare all pairs of people (`pg/review.py:63-66`, `298`). |
| The producer publishes atomically, and `stats.json` marks a complete build. | `pg/cli.py:419-428`, `pg/kb.py:269-272` | Many concurrent writers committing single records do not produce a build marker. |
| Referential integrity is global and guaranteed upstream. | `graph.py:192-197`; `pv/docs/project/architecture/arch-2026-10-24-graph-database.md:287-288` | With concurrent accumulation, a reference to an entity that another agent has not written yet is normal. |
| One schema per kind, one contract version at a time. | Schema file name maps to kind (`pg/schemas.py:62-63`). One global `VERSION` names every contract (`u26/pipeline/src/universe_kb/models.py:29`, `922`). | Accumulated records will carry mixed contract versions for long periods. |
| The graph is a disposable projection. | “FalkorDB holds a rebuildable projection” (`pv/docs/app-integration.md:3-5`); direct writes “would be replaced on reload” (`app-integration.md:125-127`) | Durability of the database does not matter in paraverse. FalkorDBLite runs with periodic RDB snapshots and no append-only file (`fl/redislite/configuration.py:18`, `40`). |
| One writer, local readers. | The loader is the only writer. The server binds to loopback and has no authentication (`pv/docs/app-integration.md:129-132`). | Concurrent writers and hosted serving are outside the design. |

Measured S0 baseline for these assumptions (Appendix A): 5,407 nodes and 25,313 edges
from 4,975 artifacts.
Payloads total 12.8 MB as JSON. The load issued 150 Redis commands.
Redis `used_memory` grew from 2.8 MB to 45.8 MB and resident memory from 24 MB to 120
MB. The RDB file is 6.2 MB.

## 2. softschema Itself

softschema 0.8.1 is the maintainer’s own package: author Joshua Levy, MIT license,
repository `github.com/jlevy/softschema` (`ss/PKG-INFO:3-9`). It ships a Python and a
TypeScript implementation that share a CLI, a compiled-schema format and a schema hash
(`ss/README.md:372-386`). Paraverse and the dataset pipeline both pin it exactly
(`pv/db/pyproject.toml:37`, `u26/pipeline/pyproject.toml:10`).

### 2.1 What It Provides

- **A file convention.** An artifact is Markdown with YAML frontmatter, or pure YAML
  (`ss/docs/softschema-spec.md:68-75`). A `softschema:` metadata block may carry four
  keys: `contract` names the payload contract, `schema` points at the compiled schema,
  `envelope` names the top-level key that holds the payload, and `status` states how
  strictly to validate (`softschema-spec.md:238-251`). Unknown keys in the block are an
  error (`ss/packages/python/src/softschema/models.py:64`).
- **Two independent choices.** The profile is `frontmatter-md` or `pure-yaml`. The
  status is `soft`, `permissive` or `enforced` (`ss/README.md:87-92`,
  `models.py:35-47`).
- **A strict reading rule.** The YAML payload is the only authoritative source of
  structured values. The Markdown body is for readers and is never parsed as data
  (`softschema-spec.md:605-613`). Other top-level frontmatter keys, such as `title`, are
  allowed and not interpreted (`softschema-spec.md:265-270`).
- **A portable value domain.** YAML decodes to JSON-compatible values.
  Integers must be within the IEEE-754 safe range.
  Duplicate keys, anchors, aliases, merge keys, explicit tags and non-finite numbers are
  rejected. Date-shaped scalars stay strings (`softschema-spec.md:134-146`,
  `ss/packages/python/src/softschema/_portable.py:24-60`).
- **A schema compiler.** `compile_model` turns a Pydantic model into JSON Schema Draft
  2020-12, canonicalizes it, adds `x-softschema.contract` and a `schema_sha256` over the
  canonical JSON, and writes YAML with sorted keys
  (`ss/packages/python/src/softschema/compile.py:37-91`, `94-109`, `166-178`). A check
  mode reports drift between a model and its committed schema (`compile.py:57-83`).
- **A two-layer validator.** Structural validation uses the compiled schema.
  Semantic validation uses a Pydantic or Zod model when a host supplies one.
  The layers report separately (`softschema-spec.md:709-715`). Error records carry a
  stable `kind`, `code` and `path` (`softschema-spec.md:818-835`). Compiled validators
  are cached by schema text (`ss/packages/python/src/softschema/validate.py:160-181`).
- **Status semantics.** `soft` and `permissive` do not change validation behavior.
  `enforced` makes the bound schema authoritative and rejects undeclared properties at
  supported object locations (`softschema-spec.md:332-352`).
- **A narrow repair mode.** Repair may quote a plain scalar that breaks parsing and may
  retype a scalar as a string where the contract declares a string.
  Everything else is reported and left alone.
  An artifact that needs no repair must stay byte-identical
  (`softschema-spec.md:791-811`).
- **Reader helpers.** `validate_artifact` returns a result with the payload values.
  `load_artifact` raises unless the artifact is valid (`validate.py:502-556`,
  `984-1019`). `SchemaView` iterates the fields of a compiled schema
  (`ss/packages/python/src/softschema/schema_view.py:43-96`). `SoftField` attaches
  optional per-field metadata such as `group`, `order`, `tier` and `owner` under
  `x-softschema` (`ss/packages/python/src/softschema/soft_field.py:46-58`, `69-119`).

### 2.2 How Schemas Evolve

- **The contract ID has a version slot.** The grammar is `[namespace:]Name[/version]`
  and is enforced at metadata parse time (`softschema-spec.md:306-317`,
  `models.py:19-21`). `paraverse.conference:Person/v2` is such an ID.
- **The version is part of an opaque name.** The guide says to bump it when a change
  breaks existing consumers, that additive optional fields usually need no bump, and to
  version the contract when old and new consumers must coexist
  (`ss/docs/softschema-guide.md:264-268`, `382`). softschema defines no relation between
  `Person/v1` and `Person/v2` and no migration step.
  A repair loop, alias resolution and a patch protocol are explicitly out of scope
  (`softschema-spec.md:926-940`).
- **Status is the gradual path.** A record family can move from `soft` to `permissive`
  to `enforced` without changing its profile or its Markdown body
  (`ss/docs/softschema-guide.md:48-65`, `326-387`).
- **Each artifact binds itself.** A self-describing artifact names its own contract and
  schema pointer. A host registry or an explicit flag outranks the document
  (`softschema-spec.md:660-672`). A document that declares a different contract than the
  one the host bound fails in the default metadata mode (`validate.py:783-797`).
- **Schema identity is content based.** `schema_sha256` identifies the structural
  contract. Semantic constraints that do not compile to JSON Schema are outside it
  (`softschema-spec.md:698-707`).

How the S0 dataset uses this:

- Every contract is `paraverse.conference:<Name>/v2`, every artifact is `enforced`, and
  every model is closed, so an undeclared field fails
  (`u26/pipeline/README.md:173-177`).
- One module constant holds the version for all contracts
  (`u26/pipeline/src/universe_kb/models.py:28-29`, `915-922`). A bump renames all 18
  contracts at once.
- Compiled schema files are named by kind, without a version (`models.py:925-947`). The
  layout therefore holds one schema per kind.
  Two versions of one kind cannot coexist in `_schemas/` without a naming change
  (Inferred).

### 2.3 What It Gives an Importer, and What It Does Not

An importer gets:

- per record: the contract ID, the envelope key, the status and the schema pointer;
- per contract: field names, JSON types, required flags, enums, titles, descriptions,
  nested `$defs`, patterns, and `additionalProperties: false` where the model is closed;
- a content hash per schema, usable as a cache key and as a schema-epoch identity;
- a navigation API and optional per-field metadata, if the producer adopts them;
- deterministic structured validation results, usable for quarantine decisions.

An importer does not get:

- **Entity identity.** The `id` field and typed IDs are a dataset convention
  (`u26/pipeline/src/universe_kb/models.py:32-58`).
- **Reference semantics.** A reference is a string with a regular expression.
  Paraverse recovers reference targets by parsing that expression (`pg/schemas.py:53`,
  `241-251`).
- **Relations.** Edge names, directions and attributes live in dataset code
  (`graph.py:42-158`).
- **Field order.** The compiler sorts keys, so declaration order is lost
  (`compile.py:171`; `ss/packages/python/src/softschema/canonicalize.py:26-28`).
  Paraverse falls back to an alphabetical order (`pg/schemas.py:168-176`).
- **Index, sort and default-column hints.** Paraverse keeps them in code
  (`pg/loader.py:53-65`, `pg/browser.py:84-111`).
- **A canonical artifact serialization.** The compiled schema has a canonical form.
  Artifacts do not. The dataset fixes its own dumper settings
  (`u26/pipeline/src/universe_kb/artifacts.py:55-74`).
- **Cross-record rules.** Uniqueness, referential integrity, provenance and deletion are
  outside the format.

Neither paraverse nor the dataset uses `SchemaView` or `SoftField`: a search of both
source trees finds only one `x-softschema` read, for the contract ID
(`pg/schemas.py:161`).

Inferred design consequence: the kind-specific tables in section 1.2 exist because the
compiled schema does not say which fields are references, which references are edges,
what the edges are called, or which fields deserve an index.
Compiled schemas preserve unknown extension keys (`canonicalize.py:21-22`). A production
importer could therefore read a small set of declared annotations, for example reference
target kinds, relation name and direction, field order, and index hints, and drop most
of those tables. This is the main lever for a generic importer on any backend.

## 3. A Workflow Model for the Target Use Case

The target use case differs from paraverse in one respect that drives the rest.
In paraverse the records are a build output, regenerated as a whole from saved source
snapshots, curation files and synthesized text (section 1.6). In the target use case
many crawlers and agents write softschema records directly, over months, and those
records are the system of record.
The steps that paraverse runs once inside one deterministic build become continuous
steps over a shared, growing corpus.

### 3.1 Unit Costs at S0 and Their Linear Extrapolation

S0 has 4,977 record files, 5,407 nodes and 25,313 edges: 1.09 nodes per file and 4.68
edges per node.
The S0 column is Measured (Appendix A). The other columns are Inferred by
linear scaling in the number of record files.
They size the problem and are not predictions of benchmark results.

| Quantity | S0 measured | 1k docs | 100k docs | 1M docs |
| --- | --- | --- | --- | --- |
| Record files, apparent bytes | 15.7 MB | 3 MB | 315 MB | 3.2 GB |
| `_graph/edges.jsonl` | 2.94 MB | 0.6 MB | 59 MB | 591 MB |
| `_graph/nodes.jsonl` | 0.72 MB | 0.1 MB | 14 MB | 145 MB |
| `_search/documents.jsonl` | 5.29 MB | 1.1 MB | 106 MB | 1.06 GB |
| Stat every file once | 0.09 s | 0.02 s | 1.8 s | 18 s |
| Parse YAML with libyaml | 1.34 s (0.27 ms per file) | 0.3 s | 27 s | 4.5 min |
| Parse YAML with pure Python | 2.4 ms per file | 2.4 s | 4 min | 40 min |
| Parse the same data as JSON | 0.10 s (0.02 ms per file) | 0.02 s | 2 s | 20 s |
| softschema validation | 9.9 ms per file | 10 s | 16.5 min | 2.8 h |
| FalkorDB load after parsing | 1.66 s | 0.3 s | 33 s | 5.5 min |
| FalkorDB `used_memory` growth | 43 MB | 9 MB | 0.9 GB | 8.6 GB |
| FalkorDB resident memory growth | 96 MB | 19 MB | 1.9 GB | 19 GB |
| FalkorDB RDB file | 6.2 MB | 1.2 MB | 124 MB | 1.2 GB |
| SQLite file, generic schema | 22.4 to 27.0 MiB | 5 MiB | 450 to 540 MiB | 4.4 to 5.3 GiB |
| Plain SQLite load after parsing | 0.46 s | 0.1 s | 9 s | 92 s |
| Copy, fsync and `quick_check` of one SQLite file | 67 to 92 ms | 15 ms | 1.3 to 1.8 s | 13 to 18 s |
| Substring scan over all search text | 11.4 ms FalkorDB, 3.7 to 5.5 ms SQLite | 1 to 2 ms | 0.07 to 0.23 s | 0.7 to 2.3 s |

All times are single core on a 4 vCPU cloud VM. The WORKLOAD scales count nodes, so S1,
S2 and S3 correspond to about 45,000, 230,000 and 920,000 record files.

Three observations already follow.

- Validation and YAML parsing dominate a full rebuild.
  Database ingest is the smallest term for both backends.
- JSON parses 14 times faster than YAML with libyaml and about 120 times faster than
  YAML in pure Python.
  Any stage that reads the whole corpus should read a JSON form or a cached parse.
- At 1M documents the SQLite file is about 5 GiB and the FalkorDB graph needs between 3
  GB (the engine’s own `GRAPH.MEMORY` accounting scaled up) and 19 GB (resident growth
  scaled up) of memory.
  Paraverse’s staging-and-swap load doubles the graph share while both graphs exist.

### 3.2 Lifecycle Summary by Scale

| Stage | 1k documents | 100k documents | 1M documents and more |
| --- | --- | --- | --- |
| Accumulation | One repository, one file per entity, direct commits. | Directories must be sharded. Derived aggregate files start to conflict between agents. | File count strains git and hosting limits. Records need packing or a separate accumulation store. |
| Normalization and identity | A global pass in memory. | A global pass still fits, but agents need an index to find existing entities. | Resolution must be incremental and index backed. Merges rewrite many references. |
| Validation | Validate everything each run: 10 s. | Uncached validation is 16 minutes. Cache by content hash and parallelize. | Uncached validation is hours. Per-record quarantine replaces all-or-nothing gates. |
| Consolidation | Full rebuild in about a second. | Full rebuild is tens of seconds plus validation. Still the simplest correct choice. | Full rebuild is many minutes. Incremental parsing with a full publish, or true incremental import, becomes necessary. |
| Serving | Any store works. | Indexes and server-side pagination are required. | Every unindexed scan costs seconds. Hub nodes and total counts need limits or precomputation. |
| Schema evolution | Rewrite all records and rebuild. | Rebuild the projection. Rewriting all records is a large but workable diff. | Mixed contract versions coexist for long periods. The projection must rebuild or migrate without rewriting records. |
| Export | Rewrite the tree. | Rewrite changed files only. | Export must be incremental and byte stable, or git history becomes unusable. |

### 3.3 Accumulation

What happens: many concurrent producers create and update records.
Updates may conflict.
Each fact should carry its source and evidence.

Three accumulation patterns are realistic.

1. **One file per entity, edited in place.** This is the paraverse layout.
   It gives readable history per entity.
   Two producers that touch one entity conflict in git.
2. **Append-only observations.** Each producer writes a new record per source and
   retrieval, and a later step folds observations into entity records.
   Producers never conflict.
   The corpus grows faster and needs the folding step.
3. **Batch shards.** Each producer run writes one JSONL or database shard.
   This is the cheapest to write and the least reviewable.

Properties the storage layer and formats need:

- **Atomic single-record writes.** The dataset writer uses an atomic temp-and-rename
  write per artifact (`u26/pipeline/src/universe_kb/artifacts.py:113`).
- **Deterministic IDs and paths.** The dataset derives the path from the typed ID
  (`artifacts.py:43-52`). Strong-key IDs such as `gh:<login>`, `repo:<owner>/<name>` and
  `pkg:<ecosystem>/<name>` are functions of the source key
  (`u26/pipeline/src/universe_kb/ids.py:111-120`), so independent producers agree on
  them without coordination.
- **Self-description.** Every record names its contract and status, so records written
  under different contract versions can sit side by side (section 2.2).
- **Provenance in the payload.** The dataset models carry `sources[]` with system, URL,
  record ID, retrieval time and snapshot path
  (`u26/pipeline/src/universe_kb/models.py:112-121`), and per-claim evidence and basis
  (`models.py:139-170`). Its design rule is that disagreement keeps both statements
  (`u26/docs/project/architecture/arch-2026-10-24-conference-kb.md:158-160`).
- **No shared derived state in records.** Backlink lists and counts are derived by the
  build so the two sides cannot disagree (`arch-2026-10-24-conference-kb.md:150-153`).
  If producers wrote them directly, every new session would rewrite a person, a room and
  a term file, and concurrent producers would conflict constantly (Inferred).
- **A gradual contract.** softschema lets a new kind start as `soft` or `permissive` and
  tighten later (section 2.2). A closed `enforced` contract rejects a producer’s new
  field until the model changes (`u26/pipeline/README.md:173-177`).

Bottlenecks as scale grows:

- **File count in git.** S0 already has 577 files in each of two directories and a
  median file size of 1.4 KB (Measured).
  Scaled 200 times, `people/` and `profiles/` each hold about 115,000 files.
  Flat directories of that size are slow to list and hosting interfaces truncate them.
  A million-file working tree makes every status, checkout and clone proportional to the
  file count (Inferred from how git works; not measured here).
- **Aggregate files.** S0 has several files that many records feed: `media.yaml` (433
  KB, one entry per image in the KB), each facet file (up to 35 nodes per file), the
  generated `README.md` index, and the single-file exports under `_graph/` and
  `_search/` (Measured).
  Every one is a merge-conflict point for concurrent producers and a full-file rewrite
  for any change.
- **Export size.** `edges.jsonl` reaches 100 MB at about 170,000 record files and
  `documents.jsonl` at about 95,000 (Inferred from the S0 sizes).
  GitHub documents a 100 MB limit per file (not re-verified for this draft).
  Committed single-file exports stop working between S1 and S2.
- **Commit throughput.** Many agents pushing to one branch serialize on the remote.
  Batching by producer run and merging through a queue is the usual answer (Inferred).

### 3.4 Normalization and Identity Resolution

What paraverse’s dataset does today:

- Normalizers turn names and URLs into ID parts
  (`u26/pipeline/src/universe_kb/ids.py:28-47`).
- People merge across sources when any account key matches.
  A name match alone merges only when the new record claims a speaking role
  (`u26/pipeline/src/universe_kb/people.py:6-11`).
- Curation files fix what no rule can decide: renames, rejected links, aliases
  (`u26/pipeline/README.md:286-288`).
- A person ID is the slug of the display name, with `-2`, `-3` suffixes when taken
  (`arch-2026-10-24-conference-kb.md:213`).
- Across datasets, paraverse merges a person only on a shared verified account
  (`pg/composition.py:52-59`).

All of this is a global, order-dependent pass over the whole corpus inside one build.
With concurrent producers the properties needed are:

- **Collision-free IDs for strong-key entities** (accounts, repositories, packages,
  websites), which the dataset already has.
- **A resolution step for weak-key entities** (people, organizations).
  Two agents can mint the same slug for different people, or different slugs for one
  person. Suffix assignment depends on arrival order, so it is not safe without a shared
  index.
- **A lookup index by alternate key.** An agent must ask “which entity owns this account
  or this domain” before it writes.
  At 100k documents and above that is a database lookup.
  The consolidated store is the natural index, so its freshness bounds the duplicate
  rate (Inferred).
- **Merges as data.** A merge or rename changes an ID that other records reference.
  It either rewrites every referring file or is recorded as a redirect that
  consolidation applies.
  Redirect records keep producers append-only and keep git diffs small (Inferred).

Bottleneck: every global pass is proportional to the corpus, and a merge touches many
files and many edges.
Incremental resolution needs the index and the redirect records.

### 3.5 Validation

Validation has four levels: one record against its contract, references across records,
policy rules such as the data policy, and data-quality heuristics.

Properties needed:

- **Per-record validation that is cacheable.** The result depends on the record bytes,
  the schema hash and the status.
  softschema provides the schema hash
  (`ss/packages/python/src/softschema/compile.py:53-54`). Paraverse’s native export
  already reuses a recorded validation when the dataset commit and graph digest are
  unchanged (`pv/backend/export_kb_native.py:357-365`).
- **Per-record quarantine.** Paraverse’s validated load is all or nothing: it loads
  nothing if any artifact fails (`pv/db/README.md:239`). With a million records from
  many producers one bad record would block every update.
  The consolidator needs to skip and report invalid records and keep their last valid
  version (Inferred).
- **A reference policy.** The dataset build fails on any dangling edge
  (`u26/pipeline/src/universe_kb/graph.py:192-197`). Under concurrent accumulation a
  reference to a not-yet-written entity is normal.
  The store must hold unresolved references and report them.
- **The same parser everywhere.** softschema’s portable YAML rules differ from a stock
  YAML parser (`ss/docs/softschema-spec.md:134-146`). Producers, the consolidator and
  the exporter should share one reader, or validation results will not transfer.

Bottleneck: 9.9 ms per artifact, Measured.
softschema parses with ruamel.yaml (`ss/packages/python/src/softschema/_portable.py:12`)
and caches compiled validators (`validate.py:160-181`), so the remaining cost is
per-document parsing and schema evaluation.
Uncached validation is 16 minutes at 100k documents and almost three hours at 1M on one
core. It parallelizes per file and caches per content hash.

### 3.6 Consolidation: Full Rebuild Against Incremental Import

| Property | Full rebuild | Incremental import |
| --- | --- | --- |
| Correctness | The database is a function of the files. Drift is impossible. | The database depends on the history of applied changes. Drift is possible and must be detected. |
| Cost per run | Proportional to the corpus | Proportional to the change, plus any per-publish floor of the store |
| Atomic visibility | One swap | Needs a transaction or a staged copy around each batch |
| Deletes and renames | Implicit | Explicit: remove the node, every edge derived from the record, and every derived value |
| Edge maintenance | Recomputed globally | Needs the origin record of every edge |
| Schema change | Free | Needs a migration or a rebuild |
| Memory | Paraverse holds everything in Python and twice in FalkorDB | Bounded by the batch |
| Failure handling | Keep the old build | Per-batch rollback and replay |

Two facts from the sources constrain incremental import.

- The `_graph` export has no edge identity and no edge origin.
  Edges carry `source`, `relation`, `target` and attributes only (Measured: the keys of
  all 25,313 edges). An edge is often derived from a record other than its source node: a
  session record yields `presents` edges whose source is a person, and a profile record
  yields `expert_in` edges whose source is the person
  (`u26/pipeline/src/universe_kb/graph.py:50-51`, `87-95`). An incremental importer
  cannot replace “the edges of the changed record” without an origin field.
- S0 has parallel edges: 323 `(source, relation, target)` triples occur more than once,
  one of them six times (Measured).
  An edge table cannot use that triple as its key.

A third option sits between the two: **incremental parse, full publish**. Keep a cache
of parsed, validated, normalized rows keyed by file content hash.
On each run read only changed files, then regenerate the whole database from cached rows
and publish it atomically.
JSON parsing of a million cached payloads costs about 20 s and a plain SQLite load about
90 s (Inferred from the table above).
This keeps the correctness of a full rebuild and removes its two dominant costs.
It fits a store whose unit of publication is a whole database file.

Bottlenecks as scale grows: YAML parse and validation first, then loader memory, then
the store’s own load time, then the single-file `_graph` export, which any change
rewrites in full. A store that publishes whole-file versions adds a floor to every
publish: about 1.3 to 1.8 s at 100k documents and 13 to 18 s at 1M on the probe VM
(Inferred), and each retained version costs the full file size on disk.

### 3.7 Serving the UI

The browser needs six query shapes: a sorted, filtered, paginated table per kind; one
record with its neighbors grouped by relation; text search; counts grouped by a related
entity; a bounded neighborhood; and a path between two entities.

Properties needed:

- ordered indexes that serve both the filter and the sort, so a page costs the page;
- a text index, or an accepted cost for scanning;
- neighbor lookups in both directions;
- bounded traversal with an explicit rule for hub nodes;
- a consistent view across the several requests of one screen, which paraverse leaves to
  the client (`pv/docs/app-integration.md:110-112`);
- fast start and low idle memory, if the server is embedded in a desktop app as in
  paraverse (`pv/README.md:147-156`).

Bottlenecks as scale grows:

- **Scans.** Paraverse’s table filter is a substring match over `search_text` on every
  node of the kind (`pg/browser.py:1035`). Measured at S0: 2.1 microseconds per node in
  FalkorDB and about 1 microsecond per row in SQLite.
  At 1M documents a scan over all nodes takes 1 to 2 seconds, and a filter within one
  kind scales with that kind.
- **Sorts.** FalkorDB sorts the whole label for each page.
  The plan for a sorted page of repositories is a label scan, a sort, then skip and
  limit, even though a range index on the sort property exists (Measured with
  `GRAPH.EXPLAIN` on 4.18.3; `pg/loader.py:56`).
- **Whole-corpus reads.** The overview endpoint returns every payload to Python in one
  query (`pg/overview.py:59-61`). Measured at S0: 62 ms for 12.8 MB. At 1M documents
  that is about 2.5 GB through one result set and well past the 4 second timeout
  (Inferred).
- **Hubs.** At S0 one software node has degree 533, and one sampled speaker reaches 800
  distinct nodes within two hops (Measured).
  Neighborhood and path queries are dominated by hub handling, not by graph size.
- **Memory at rest.** An in-memory graph holds the whole corpus resident.
  A file-backed store holds only the pages that queries touch.

### 3.8 Schema Evolution

A schema change can touch six layers: the records, the compiled schemas, the derived
exports, the physical database layout, the indexes, and the UI configuration.

Properties needed:

- **Mixed contract versions.** Because each record names its own contract, old records
  stay valid under the old contract.
  At 1M documents rewriting every record for a version bump is a million-file diff.
  The importer should accept several contract versions of one kind at once.
  The current `_schemas/` naming and paraverse’s one-schema-per-kind reader do not allow
  that (section 2.2).
- **A physical layout that follows the schema, or ignores it.** Either the importer
  derives labels, tables and indexes from the compiled schemas on each rebuild, or it
  stores payloads as documents in a fixed layout and promotes only declared fields.
- **Cheap rebuild of the projection.** If the files stay the system of record, every
  physical change can be a rebuild, and migration machinery in the database is
  unnecessary.

Bottleneck: the cost of schema evolution is the cost of the rebuild path.
That is one more reason to make the rebuild incremental at the parse stage.

### 3.9 Export

Export from the database back to records is needed when anything other than a file edit
changes the data: a curation UI, a merge decision, a bulk repair, or a move to a new
contract version.

Three fidelity levels should be distinguished.

| Level | Definition | What the store must keep |
| --- | --- | --- |
| L1, payload | The parsed envelope payload is equal. | The payload as a document, with number types intact |
| L2, document | The whole parsed document is equal: `softschema` block, other top-level keys such as `title`, the payload, and the body text. | L1 plus the metadata block, extra keys, and the body or the renderer that produces it |
| L3, bytes | The file is byte-identical. | L2 plus key order and the exact serializer settings |

Facts that bear on fidelity:

- Paraverse keeps the payload only.
  `Artifact` holds path, contract, envelope and payload (`pg/kb.py:57-62`), and `doc` is
  written with sorted keys (`pg/mapping.py:152`). A paraverse graph can reach L1. It
  cannot reach L2 or L3 without storing more.
- Markdown bodies are regenerated from the YAML on every build and are never parsed
  (`u26/pipeline/README.md:310-311`). An exporter needs the same renderer and its
  cross-record inputs (`u26/pipeline/src/universe_kb/build.py:944-962`), or it must
  store the body. S0 bodies total 1.8 MB (Measured).
- Byte fidelity depends on the producer’s dumper: declaration key order, width 100,
  block style for multi-line strings, quoting of numeric-looking strings, and pruning of
  nulls and empty collections (`u26/pipeline/src/universe_kb/artifacts.py:61-88`). The
  compiled schema cannot supply key order (section 2.3).
- Two S0 artifacts have no graph node: `faq.yaml` and `media.yaml`. 432 nodes have no
  file of their own: 14 days live inside event files and 418 terms inside facet files
  (Measured). “One record per node” does not hold in either direction.

Bottleneck: export is a full rewrite unless the store tracks which records changed.
Without L3 fidelity, an export after a small change produces a diff in every file.

## 4. Formats

### 4.1 Comparison by Criterion

| Criterion | YAML files | Markdown with YAML frontmatter | JSONL exports | Graph store (FalkorDB) | Embedded relational (SQLite, fsqlite) |
| --- | --- | --- | --- | --- | --- |
| Diffability | Good with a deterministic dumper and one entity per file | Same, but a generated body doubles the diff | Line level only. One changed field shows the whole line. | None. The RDB file is a binary memory image. | None for the file. Logical diffs exist as session changesets. |
| Merge behavior in git | Line-based three-way merge. Works for disjoint keys. Lists of objects conflict. | Same for frontmatter. Generated bodies conflict unless regenerated. | Works only if lines are stable and sorted by key. Large files conflict often. | Not applicable | Not applicable for the file. fsqlite merges row changes by primary key with a declared policy. |
| Human and agent editability | High | Highest for reading. The body must not be edited as data. | Low | Through Cypher only | Through SQL only |
| Parse speed | 0.27 ms per record with libyaml, 2.4 ms in pure Python (Measured) | Same, plus the frontmatter split | 0.02 ms per record (Measured) | No parse. Load from RDB is a full read into memory. | No parse. Pages are read on demand. |
| Schema enforcement | By softschema at read and write boundaries | Same | None by itself | Unique constraint only. Contracts are not enforced (`pv/docs/app-integration.md:32-34`). | Primary keys, `NOT NULL`, `CHECK`, foreign keys, plus softschema at the boundary |
| Partial updates | One file per entity | One file per entity | Rewrite the file, or append and compact | One query is atomic. No multi-query transactions (FalkorDB docs, concurrency page). | Transactional. fsqlite adds a whole-file copy per published version (`docs/fsqlite-design.md:426-427`). |
| Provenance | In the payload, plus git history per file | Same, plus prose | Only what each line carries | Properties and JSON strings. Maps are not allowed as properties. | Columns, JSON, and row-level history if modeled |
| Export fidelity | It is the reference | It is the reference, if the body renderer is available | Lossy unless every line carries the full document | L1 as paraverse stores it (section 3.9) | Text columns are byte exact, so L3 is reachable if the document parts are stored |

### 4.2 Fit by Role

| Format | System of record | Interchange | Serving store |
| --- | --- | --- | --- |
| YAML files | Good to about 100k documents. Reviewable, attributable, mergeable. | Good for small sets. Slow to parse in bulk. | No |
| Markdown with frontmatter | Good for records that people read. Keep the body generated. | Good for people and agents. | No |
| JSONL | Acceptable as packed shards when file count is the limit. Poor for review. | Best for bulk transfer and as a parse cache. | No |
| FalkorDB | No. In memory, version-coupled persistence, no contracts. | No. `DUMP` and RDB are not version-independent formats (FalkorDB docs, upgrades page). | Yes, for traversal-heavy reads that fit in memory |
| SQLite and fsqlite | Possible for machine-written facts at large scale. Loses git review. | Good: one stable file that standard tools open. | Yes |

### 4.3 Notes per Format

**YAML files**

- Pros: readable, diffable, self-describing with a `softschema:` block, one file per
  entity gives per-entity history.
- Cons: the slowest format to parse.
  A million files strain git and file systems.
  There is no transaction across files, so a change that spans files is atomic only as a
  git commit. YAML has value pitfalls that need a portable reader: softschema keeps
  date-shaped scalars as strings and rejects anchors and duplicate keys
  (`ss/docs/softschema-spec.md:134-146`), and the dataset quotes numeric-looking strings
  explicitly (`u26/pipeline/src/universe_kb/artifacts.py:61-67`).

**Markdown with YAML frontmatter**

- Pros: the same structured payload plus prose for readers and agents.
  softschema makes the rule explicit: consumers read the YAML only
  (`ss/docs/softschema-spec.md:605-613`).
- Cons: a generated body duplicates payload content and changes whenever a referenced
  entity’s name changes, so bodies add diff noise across files.
  A hand-written body is valuable context but cannot be regenerated, so the store must
  keep it for export.

**JSONL exports**

- Pros: fast, streamable, and trivially loaded by any tool.
  The dataset documents this use (`u26/pipeline/src/universe_kb/graph.py:4-7`).
- Cons: a derived single file is rewritten in full on any change and outgrows hosting
  limits early (section 3.3). Lines are not self-describing.
  The S0 edge lines carry no identity and no origin (section 3.6).
- Best role: an interchange and cache format between the parse stage and the import
  stage, sharded and addressed by content hash, and not committed to the record
  repository at scale.

**Graph store (FalkorDB)**

- Pros: relationships are first class, Cypher expresses neighborhood and path queries
  directly, full-text search is built in, and the schema is open, so new labels and
  properties need no declaration.
- Cons: data lives in RAM (FalkorDB docs, design page).
  Properties cannot be maps, so nested payloads become JSON strings that the engine
  cannot query (`pv/docs/project/architecture/arch-2026-10-24-graph-database.md:366`).
  Persistence is a Redis RDB snapshot whose graph encoding is guaranteed compatible only
  between patch releases of one minor version (FalkorDB docs, upgrades page).
  The engine is published under SSPLv1 (FalkorDB docs, design page).
  The persisted file is a cache of a running server, not an artifact to hand to someone
  else.

**Embedded relational (SQLite and fsqlite)**

- Pros: one portable file in a format with long-term compatibility, opened by standard
  tools. Constraints and indexes are declared.
  JSON functions query inside payload documents.
  Text is stored byte exact.
  fsqlite adds immutable published versions, an atomic pointer, and cooperative
  multi-writer capture with a per-table merge policy (`README.md:62-96`).
- Cons: relationships are rows, so multi-hop queries are joins or application loops.
  The file is binary to git.
  fsqlite adds three limits of its own: every write copies the whole published file
  (`docs/fsqlite-design.md:426-427`), the caller schema is fixed for the life of a store
  (`docs/fsqlite-design.md:254-259`), and virtual tables, so also FTS5 indexes, cannot
  be part of the schema (`docs/fsql-format-spec.md:226-229`).

## 5. FalkorDB and fsqlite Compared Before the Benchmarks

### 5.1 Design Facts

| Aspect | FalkorDB 4.18.3 through FalkorDBLite 0.10.0 | fsqlite 0.1.0 alpha, format `f1.0` |
| --- | --- | --- |
| Data model | Property graph. Sparse adjacency matrices: one per relationship type, one per label, one global, computed with GraphBLAS (FalkorDB docs, design page). | Relational tables in an ordinary SQLite file. Relationships are rows. |
| Where data lives | In RAM (FalkorDB docs, design page) | In file pages, read on demand. Each published version is a complete SQLite file (`README.md:66-70`). |
| Query language | A subset of openCypher, plus procedures. The bundled engine lists `algo.BFS`, `algo.SPpaths`, `algo.SSpaths` and five others (Measured). | SQL, with JSON functions and recursive queries |
| Persistence | Redis RDB snapshots, optionally an append-only file (FalkorDB docs, durability page). FalkorDBLite defaults: no append-only file, snapshot rules `900 1`, `300 100`, `60 200`, `15 1000`, and a save when the last client shuts down cleanly (`fl/redislite/configuration.py:18`, `40`; `fl/redislite/client.py:112`). | Each publish fsyncs the snapshot file, links it without replacing, fsyncs the directory, then swaps the pointer atomically (`docs/fsql-format-spec.md:677-678`). |
| Atomic unit | One query. No native multi-query transactions. `MULTI`/`EXEC` groups queries and blocks every graph meanwhile (FalkorDB docs, concurrency page). A key `RENAME` swaps a whole graph. | One published version. A reader sees the previous complete database or the next one (`README.md:256-258`). |
| Concurrency | Per graph: readers in parallel, one writer at a time in arrival order (FalkorDB docs, concurrency page). | Readers open immutable files and never wait (`docs/fsqlite-design.md:173`). `SnapshotStore` records each write as a SQLite session changeset on a private copy of the published file, so captures overlap, and reconcile applies the changesets and publishes (`README.md:80-86`, `248-254`). `DirectStore` serializes the whole write (`docs/fsqlite-design.md:92-100`). |
| Conflicts between writers | None detected. The later query wins. A unique constraint rejects a duplicate create (`pv/db/tests/test_graph.py:176-186`). | Same-primary-key conflicts follow a per-table policy: `lww`, `union` or `strict`. Other conflict types quarantine the whole envelope (`docs/fsqlite-design.md:212-223`). |
| Cost of a small write | Proportional to the changed elements and their index entries (Inferred) | At least one copy of the whole published file. `SnapshotStore` pays a second copy in reconcile (`docs/fsqlite-design.md:426-429`). |
| Schema | Open. Labels, types and properties appear on write. | One fixed caller schema per store, identified by a hash of the exact DDL text and a version. Callbacks cannot run DDL. Any DDL change means a replacement store (`docs/fsqlite-design.md:254-259`, `284-288`; `docs/fsql-format-spec.md:327-328`). |
| Schema limits | Properties cannot be maps (`pv/docs/project/architecture/arch-2026-10-24-graph-database.md:366`). | Every table needs a non-null primary key. No virtual tables. `SnapshotStore` also forbids triggers (`docs/fsql-format-spec.md:196-229`). |
| Text search | A built-in full-text index with stemming: `agent`, `agents` and `agentic` return the same 364 nodes (Measured) | None inside the store. Options are a scan, a token table that the importer maintains, or an FTS5 file outside the store that is rebuilt per version (`docs/fsqlite-design.md:301-304`). |
| Artifact | One RDB file plus a running `redis-server` with a 53 MB module (Measured). The graph encoding is guaranteed compatible only across patch releases (FalkorDB docs, upgrades page). | A store directory. Each snapshot opens with any SQLite tool (`README.md:207-231`). The store format is a draft (`README.md:24-27`). |
| Process model | A `redis-server` daemon reparented to init (Measured: parent PID 1; `fl/redislite/configuration.py:25`). Clients of one database file share it through a registry file (`fl/redislite/client.py:442-450`). | No process. Library calls in each client. |
| Start-up | The server loads the whole RDB into memory. The client waits at most 10 seconds (`fl/redislite/client.py:57`, `282-303`). | Open a file. |
| Stated fit | FalkorDBLite is for development, prototyping and CI. Production should use a server deployment (FalkorDB docs, FalkorDBLite page). | A single-digit-MiB store with occasional writes. Tens of MiB need measurement. Hundreds of MiB with frequent small writes are a poor default fit (`packages/fsqlite/README.md:519-523`, `docs/fsqlite-design.md:508-517`). |
| License | The engine is SSPLv1 (FalkorDB docs, design page). The Python wrapper declares BSD (wheel metadata). | MIT (`README.md:413`) |

One implementation detail is verified beyond the documents.
fsqlite’s schema check lists every `sqlite_master` row of type `table` and refuses any
table without a primary key column (`packages/fsqlite/src/snapshotStore.ts:298-320`).
The check runs in the shared `init()` for both strategies (`snapshotStore.ts:691`,
`packages/fsqlite/src/directStore.ts:56-65`). An FTS5 virtual table appears in
`sqlite_master` as a table with no primary key column (Measured).
So neither `SnapshotStore` nor `DirectStore` accepts a schema that contains an FTS5
index.

### 5.2 Three Structural Observations

**The full rebuild and the replacement store are the same operation.** Paraverse treats
the database as a rebuildable projection and swaps a complete new graph into place.
fsqlite requires a replacement store for any schema change
(`packages/fsqlite/README.md:248-264`). If the files stay the system of record, a schema
change is one more rebuild, and fsqlite’s fixed schema costs nothing extra.
The other side of this observation is that the rebuild role uses none of the features
that separate fsqlite from a plain SQLite file.
The design says a fixed dataset needs no writer coordination and can be shared directly
as a read-only SQLite file (`docs/fsqlite-design.md:55-56`). A plain SQLite file built
at a temporary path and renamed gives the same atomic swap that paraverse gets from
Redis `RENAME`.

**fsqlite’s distinguishing feature matches accumulation, but only for compact stores.**
`SnapshotStore` exists for many independent agents that update one compact knowledge
base (`docs/research/README.md:5-9`). That is the accumulation stage of section 3.3. The
S0 corpus is already 22 to 27 MiB as a SQLite file (Measured), which is in the band that
the design says needs workload-specific measurement (`docs/fsqlite-design.md:510-511`).
A 100k-document corpus is about 0.5 GiB (Inferred).
Per-document writes against the whole corpus are therefore outside the documented
envelope at every WORKLOAD scale above S0.

**FalkorDB’s atomic unit is the query.** A batch of many records is atomic only if it
fits in one query. Redis limits a string to 512 MB and a query to 1 GB by default
(FalkorDB docs, bulk insert specification).
Paraverse gets atomic visibility by rebuilding into a staging graph and renaming it.
An incremental FalkorDB design must either accept that readers see half-applied batches,
or copy the graph, apply the batch to the copy, and rename, which doubles memory
(Inferred).

### 5.3 Where Each Should Win or Lose

Every entry is Inferred from the designs and the S0 probes unless marked otherwise.

| Workflow | FalkorDB or FalkorDBLite | fsqlite | Expected outcome |
| --- | --- | --- | --- |
| W1, full rebuild | Measured at S0: 1.66 s after parsing, 150 commands. Memory grows with the corpus and doubles during the swap. Default snapshot rules can start background saves during long loads. The unique-constraint wait is capped at 30 s (`pg/loader.py:316`). | Measured at S0: 0.46 s for a plain SQLite load of the same rows. fsqlite adds one `quick_check` and one fsync of the whole file per publish (`docs/fsql-format-spec.md:644-650`). Indexes must exist before the bulk insert, because callbacks cannot run DDL. | fsqlite wins memory clearly and ingest time by a small factor. Both are hidden behind parsing and validation unless those are cached. |
| W2, incremental batches | Cost follows the batch. No copy floor. Not atomic across queries. Durable only at the next snapshot. Replacing the edges of a changed record needs an origin property and a way to find edges by it. | Each published batch pays one or two whole-file copies plus `quick_check` and fsync, whatever its size: about 1.3 to 1.8 s at 100k documents and 13 to 18 s at 1M on the probe VM. The batch is atomic and durable when the call returns. | FalkorDB wins time to visibility for small batches, by a margin that grows with corpus size. At the WORKLOAD’s batch sizes the margin shrinks because row work dominates: 1% of 1M documents is about 3 s of FalkorDB ingest at the S0 rate. fsqlite wins atomic visibility, durability and reader isolation. |
| W2, concurrent writers | Writers queue per graph. No conflict detection. Readers of the same graph share the thread pool. | `SnapshotStore`: four writers each copy the published file, then reconcile copies it again. `DirectStore`: writers queue behind one lock with a 30 s default wait (`packages/fsqlite/README.md:344-346`). Readers never wait. | FalkorDB wins throughput at S1 and above. fsqlite wins reader latency and reports conflicts that FalkorDB silently overwrites. |
| W3.1, sorted table page | A label scan and a sort per page (Measured plan). Indexes serve filters, not order. | An index range scan when the planner uses the index. Measured: 0.013 ms with the expression index forced, 2.1 ms when the planner chose a scan and sort. | fsqlite wins at scale if index use is confirmed. |
| W3.2, record with neighbors | Index lookup, then adjacency. Paraverse issues four queries per record view (`pg/browser.py:671-692`). | Primary-key lookup plus two index range scans on the edge table | Close. The simplest FalkorDB queries took about 0.6 ms in the probe, which is mostly the round trip to the server (Measured). |
| W3.3, search | Native full-text index: fast, stemmed, token based. Substring match: a scan at 2.1 microseconds per node (Measured). | No in-store text index. Substring match: a scan at about 1 microsecond per row (Measured). An FTS5 file outside the store answered a token query in 0.2 ms at S0 (Measured), and a trigram tokenizer can serve substring queries. | Depends on the rule. With a substring oracle FalkorDB must scan and fsqlite may use a sidecar index. With token search FalkorDB’s built-in index needs no extra artifact. |
| W3.4, path | Undirected `shortestPath` is rejected (Measured). All-path enumeration to 4 hops took 1.47 s at S0. `algo.SPpaths` took 266 ms at S0 (Measured). | Bidirectional breadth-first search in application code over the indexed edge table: 0.03 ms for the same pair at S0 (Measured). | Open. The S0 probe favors SQLite, against the usual expectation, but most of the gap is the algorithm and not the engine. Hub handling decides the result at scale. |
| W3.5, facets | Traverse one relationship matrix and aggregate | An index-only scan of `(relation, target)`: 0.17 ms at S0 (Measured) | Close. Parallel-edge semantics must be pinned first. |
| W3.6, two-hop neighborhood | 14 ms for the largest hub and 2 ms for one sampled speaker at S0 (Measured) | 3.5 ms and 0.4 ms for the same nodes at S0 (Measured) | Open. The S0 probe favors SQLite. Matrix traversal may scale better. |
| W4, schema evolution | Nothing to migrate in the engine. Paraverse’s code tables must change for a new kind (section 1.2). | No DDL for a new kind or field if payloads are stored as documents. A new index is a new store, which is a rebuild. | A tie when the database is a projection. FalkorDB wins if the database is the system of record. |
| W5, export | Reads every `doc` through query results. A 1M-document corpus is about 2.5 GB of result data and needs paging. | A sequential scan in path order, streamed | fsqlite wins time. Fidelity depends on what was stored, not on the engine. |
| W6, operations | Memory resident at rest. Start-up loads the RDB. Tools need the module. | No resident process. Start-up is a file open. Standard tools read it. Retained versions multiply disk use. | fsqlite wins, except for disk use and manual recovery after a crashed publisher. |

Three of these deserve a remark.

- **W2 hides both weaknesses.** Batches of 1%, 5% and 20% are large enough that row work
  dominates fsqlite’s copy floor, and they say nothing about a crawler that commits one
  record at a time. They also do not expose FalkorDB’s lack of atomic multi-query batches
  unless a reader checks for half-applied batches.
- **W3.1 can silently measure the wrong plan.** In the probe, SQLite 3.53.1 did not
  choose a partial expression index for an `ORDER BY ... LIMIT` query until the query
  named it with `INDEXED BY`. The index was 160 times faster once used.
  The spike should check every W3 plan with `EXPLAIN QUERY PLAN`.
- **Graph queries are not an automatic FalkorDB win at this graph shape.** The S0 graph
  is small, sparse outside its hubs, and dominated by hubs inside them.
  Indexed joins did well in the probe.
  The path gap is mostly an algorithm gap: the probe compared a bidirectional search
  over SQLite with path enumeration inside FalkorDB. This is the result most in need of
  the benchmark, run with the same algorithm on both.

### 5.4 Questions Only the Benchmarks Can Settle

1. How FalkorDB memory grows with real payload sizes: per node, per edge, per index, and
   the gap between `used_memory` and resident memory.
   Whether S2 and S3 fit on the VM with and without the staging copy.
2. FalkorDB ingest rate at scale with 2 KB documents in each batch, and whether the
   default snapshot rules trigger background saves during the load.
3. Whether the unique-constraint build stays under paraverse’s 30 second wait.
4. RDB load time against size, and the size at which FalkorDBLite’s 10 second start
   timeout trips. Measured at S0: 0.3 s for 6 MB.
5. FalkorDB’s cost for a sorted page of a kind with 200,000 nodes.
6. Path and neighborhood behavior with hubs for both engines, with a timeout.
7. fsqlite publish time at 0.25, 1 and 5 GiB on the VM’s disk: copy, `quick_check`,
   fsync, and the same with a cold page cache.
8. `SnapshotStore` capture and reconcile time with four writers at each scale, and the
   disk high-water mark with retained versions.
9. SQLite bulk-insert rate with all indexes already present, and whether inserting in
   key order closes the gap to creating indexes after the load.
10. Changeset size and apply time for 1%, 5% and 20% batches.
    A changeset carries full row values, and the default envelope limit is 1 GiB
    (`packages/fsqlite/README.md:323`).
11. Whether SQLite’s planner picks the intended indexes without statistics.
    `ANALYZE` inside a write callback would create a statistics table, which the
    callback rules appear to forbid (`docs/fsql-format-spec.md:327-328`). Open.
12. Reader latency during writes: FalkorDB readers while a long write query runs on the
    same graph, and fsqlite readers while writers copy multi-GiB files on the same disk.
13. Export throughput and the fidelity level each stored representation reaches.

### 5.5 Failure Modes at Scale

FalkorDB and FalkorDBLite, as paraverse uses them:

- **Memory exhaustion.** The Python loader holds every parsed payload and every property
  row (`pg/kb.py:235-249`, `pg/loader.py:252-261`). The server holds the staging graph
  and the live graph until the rename.
  A background save forks the server process.
  Inferred: S3 does not fit a 16 GB machine, and S2 is tight.
- **Orphan graphs.** A load that fails keeps its staging graph for inspection.
  Only watch and selection reloads delete theirs (`pg/loader.py:126-132`, `137-141`). A
  killed loader leaves a staging graph in server memory until someone runs
  `GRAPH.DELETE`. At scale each orphan is a full copy of the corpus in RAM.
- **Silent loss of a completed load.** After the S0 load the server reported 140 unsaved
  changes and no save (Measured).
  With the default rules the first automatic save comes up to 300 seconds later.
  A server crash in that window loses the load, and the restarted server serves the
  previous build. The window exists whenever another client, such as the serving process,
  keeps the server running.
  A lone `load` command saves when it exits (`fl/redislite/client.py:97-112`). Paraverse
  can tolerate the loss because the graph is rebuildable.
- **Snapshot storms.** Each write command counts as about one change (Measured: 140
  changes for 150 commands).
  A 1M-document load at 500 rows per command is more than 10,000 commands, so the
  `15 1000` rule can start a background save every 15 seconds during the load
  (Inferred).
- **Start-up timeout.** A multi-GiB RDB may take longer to load than the client’s 10
  second wait (Inferred).
- **Stopped writes.** FalkorDBLite sets `stop-writes-on-bgsave-error yes`
  (`fl/redislite/configuration.py:41`). A failed background save, for example on a full
  disk, makes the server refuse writes.
- **Unbounded reads.** The overview query, the all-pairs review checks, the 2,000-row
  pages and the substring filter all grow with the corpus and meet a 4 second timeout
  (section 3.7).
- **Version-coupled persistence.** An engine upgrade across a minor version may not read
  the old RDB in both directions (FalkorDB docs, upgrades page).
  The current documentation also states a default result-set limit of 10,000 rows, while
  the bundled 4.18.3 reports no limit (Measured).
  An engine upgrade could therefore start truncating whole-corpus queries without an
  error.
- **No atomic incremental batch** above the query size limits (section 5.2).

fsqlite:

- **The copy floor.** Every write copies the published file.
  `W` writers in flight need about `W` copies of it on disk
  (`docs/fsqlite-design.md:484-487`).
- **Retention.** Garbage collection keeps three predecessors by default
  (`packages/fsqlite/README.md:348`). At 1M documents that is about 20 GiB before any
  working copy (Inferred).
  The probe VM had 16 GB of free disk at the time of writing.
- **Whole-file checks.** Each publish runs `quick_check`. `validate()` and a collecting
  `gc()` run a full integrity check, measured by the fsqlite project at 0.46 s warm and
  6.7 s cold for a 505 MiB file (`docs/fsqlite-design.md:461-465`).
- **A crashed publisher blocks all writes.** The publish lock never expires.
  Recovery is an offline procedure: stop every client, remove the lock, run repair
  (`packages/fsqlite/README.md:100-103`). `DirectStore` holds the lock across the copy,
  the callback, the checks and the fsync (`docs/fsqlite-design.md:406-414`), so a killed
  bulk import is likely to leave it.
  An unattended import pipeline needs a supervisor for this case.
- **Ledger and archive growth.** Every applied envelope adds a ledger row that reconcile
  loads into memory, and nothing prunes the applied-envelope archive
  (`docs/fsqlite-design.md:458-459`, `468-470`). One envelope per document would mean a
  million ledger rows and a million archive directories.
  Envelopes must be batches.
- **Envelope size.** A 20% batch at 1M documents is about 0.5 GiB of payload text before
  edges and old row values.
  The default limit is 1 GiB.
- **Foreign keys.** With declared foreign keys, reconcile scans the child tables for
  each envelope (`docs/fsqlite-design.md:456-457`). An edge table with foreign keys to
  the entity table would be scanned once per envelope.
- **No in-store text index, no deferred index build, no schema change in place**
  (section 5.1).
- **Alpha status.** POSIX only, with network file systems unvalidated
  (`README.md:24-27`, `packages/fsqlite/README.md:513-518`). The VM runs Node 22.23.4,
  which lacks the defensive connection option (`docs/fsqlite-design.md:658-664`).

### 5.6 Working Hypothesis for the Recommendations

This is Inferred and exists to be tested by the benchmark.

1. Keep softschema records as the system of record up to roughly 100k documents, in git,
   one entity per file, with sharded directories and no committed single-file exports.
2. Treat the database as a rebuildable projection.
   Make the rebuild cheap by caching parsed and validated rows by content hash, then
   regenerate and publish a complete database each time.
   This keeps full-rebuild correctness at near-incremental cost.
3. Publish the projection as an immutable SQLite file.
   fsqlite’s `DirectStore` gives versioned generations, an atomic pointer, read leases
   and `seal()` for export.
   A plain renamed SQLite file is the control that shows what the protocol costs.
4. Use `SnapshotStore` where its envelope fits: small per-producer inbox stores that
   hold new observations until consolidation drains them.
   Do not use it for per-document writes against the whole corpus.
5. Keep FalkorDB as an optional sidecar for traversal analytics if the benchmark shows a
   clear advantage on path queries at scale.
   Do not make it the store of record or the interchange artifact.
6. Move the kind-specific tables into declared schema annotations, so any importer is
   generic (section 2.3).
7. If the benchmark shows that small, frequent writes to the whole corpus are required,
   use ordinary SQLite on a local disk for that store, as the fsqlite design itself
   recommends for one embedded owner (`docs/fsqlite-design.md:58-69`), or a database
   server.

## 6. Critique of WORKLOAD.md

Line numbers refer to `docs/research/spikes/softschema-kb/WORKLOAD.md` as it stood when
this draft was finished (100 lines).
The spike code was read at about 01:00 on 2026-11-17 and is changing, so it is cited by
file and not by line.
Several problems below are already handled in the spike code.
They still need to be written into the specification, because later backends will be
built from the document and not from the first two implementations.
Each item gives the problem, the evidence and a correction.

### 6.1 Facts to Correct

**C1. The S0 row is wrong about files and bytes (line 35).** It says 5,001 record files
and 39 MB. Measured: `kb/` holds 5,001 files in total.
Of those, 4,977 are record artifacts, 18 are compiled schemas, 4 are graph files, 1 is
the search file and 1 is `README.md`. The record artifacts total 15.7 MB. The whole
directory is 24.8 MB of file content and 39 MB of allocated blocks.
The dataset README also says 4,977 artifacts (`u26/README.md:22-25`). Correction: “5,407
nodes, 25,313 edges, 4,977 record files (15.7 MB), 5,001 files in total (24.8 MB of
content)”. Pin the dataset commit `a823679`.

**C2. Nodes and records are not one to one (lines 27-29).** 4,975 artifacts carry nodes
and 2 carry none (`faq.yaml`, `media.yaml`). 432 nodes are nested: 14 days inside 4
event files and 418 terms inside 34 facet files.
136 nodes have no edge.
323 `(source, relation, target)` triples occur more than once.
Edge rows have no ID and no origin record (all Measured).
Correction: state these shapes under “The KB Shape”, because every backend’s key design
and every export depends on them.

**C3. “Unmodified loaders” cannot hold at scale or under W4 (lines 42-43).** The
paraverse loader accepts only its 18 kinds and 7 participation roles
(`pg/mapping.py:31-61`, `82-94`), holds the whole corpus in memory (`pg/kb.py:235-249`),
and waits at most 30 seconds for the constraint (`pg/loader.py:316`). Correction: allow
loader changes, require each run to state them, and report two FalkorDB arms where they
differ: paraverse as built, and a streaming loader.

### 6.2 Query Semantics Belong in the Specification

The correctness rule fails on any difference between backends (lines 84-86). Lines 57-66
do not define the queries tightly enough for two correct implementations to agree.
The harness already fixes most of this in the conventions block of
`harness/queries.json`: substring search with a rank, code point ordering with an ID
tie-break, a defined session start, hub kinds, paths compared on hop count only, a
defined neighborhood order, facets that count distinct sources, and record views that
list parallel edges.
Correction: make that conventions block normative by citing it from WORKLOAD.md, and
summarize it there. The probes show why each convention is needed:

- **Search.** FalkorDB’s index stems and matches tokens.
  The same graph returns 364 nodes for `agents` from the full-text index and 186 from a
  substring match. SQLite FTS5 with its default tokenizer returns 186 for `agents` and
  173 for `agent`. No setting makes the two native indexes agree.
  Substring counts matched exactly between FalkorDB and SQLite for seven terms (all
  Measured).
- **Multiplicity.** With six parallel edges, FalkorDB returns 1 for `count(m)` when the
  relationship is not referenced and 6 for `count(e)` (Measured; FalkorDB docs, known
  limitations page).
- **Paths.** FalkorDB rejects undirected `shortestPath`. A person and a sponsor are two
  hops apart through the event node, which says nothing useful (Measured).
  Paraverse excludes hub kinds for that reason (`pg/queries.py:24`, `236-244`).
- **Neighborhoods.** One sampled S0 speaker has 800 nodes within two hops and the
  largest hub has 2,832 (Measured).
  A 200-node cap always applies, so the order decides the result.

Four gaps remain after the harness conventions.

**C4. Search is not symmetric between the backends.** The substring oracle forces
FalkorDB into a scan, because its text index cannot answer substring queries.
The fsqlite arm may attach an FTS5 trigram index that lives in a sidecar file outside
the store (`fsqlite/fts.ts`). That is a fair use of each engine, but the numbers mean
different things. Correction: report three search figures per backend where they exist:
the scan, the native or sidecar index, and for FalkorDB its stemmed full-text query as
an uncompared figure.
Count the sidecar’s build time and bytes in W1 and after every W2 publish, because it
must be rebuilt per published version.

**C5. The path query compares algorithms, not engines.** The FalkorDB arm enumerates
paths of each length in turn inside the engine (`falkordb/fdb.py`, `q_path`). The
fsqlite arm runs a bidirectional breadth-first search in application code with one SQL
statement per frontier (`fsqlite/queries.ts`). At S0 the probe measured 0.03 ms for the
bidirectional search over SQLite, 266 ms for `algo.SPpaths`, and 1.47 s to count all
paths up to four hops in FalkorDB. Most of that gap is the algorithm.
Correction: run the same application-side bidirectional search on both backends, and
separately report each engine’s in-engine form: path enumeration or `algo.SPpaths` for
FalkorDB, the recursive query for SQLite.
Set a timeout and record a timeout as a result.
The unreachable case is the one most likely to time out.

**C6. Each query instance is one parameter set run 50 times (lines 57-58).** That
measures a cache more than a query.
Table pages are requested at offsets 0 and 100 only, which never shows the cost of a
deep page. Correction: draw at least 20 parameter sets per query by seed, stratified by
degree and by kind size, and run each a few times after a warm-up pass.
Add a deep page, for example the last page of the largest kind.
Define a cold run as the first query after process start, with the OS page cache dropped
where the VM allows it.

**C7. Check the plans.** In the probe SQLite 3.53.1 did not choose a partial expression
index for an `ORDER BY ... LIMIT` query until the query named it with `INDEXED BY`: 2.1
ms by scan and sort against 0.013 ms through the index.
FalkorDB’s plan for a sorted page is a label scan and a sort, although a range index
exists on the sort property (both Measured).
Correction: store the `EXPLAIN` output of every W3 query in the results, for both
backends, at every scale.

### 6.3 Corpus Realism

**C8. Hubs do not grow with the corpus (lines 40-44).** The generator builds each scale
from replicas of S0 and rewires 20% of the pairs among people, organizations and
sessions across replicas.
Its header says each copy of an entity keeps exactly its S0 degree, and that hub kinds
and derived kinds stay inside their replica (`corpus/idmap.py`). The largest degree is
therefore 533 at every scale, where S0’s largest hub touches 10% of all nodes
(Measured). Record, neighborhood, path and facet queries then do the same work at 1M
nodes as at 5,000. W3 will show flat latencies for both backends and will say nothing
about hub growth, which is the main risk for graph queries (section 3.7). Correction:
share a defined set of entities across all replicas, such as software, the largest
organizations and one taxonomy, so that some degrees grow with the corpus.
Report the maximum and 99th percentile degree per scale.
Add one query of each graph category that targets a growing hub.

**C9. Text and values repeat once per replica.** Records are byte-identical to their S0
templates except for IDs and links (`corpus/generate.py`). The vocabulary is constant,
so text indexes are unrealistically small and regular.
Every sort key has as many ties as there are replicas, so a page is a run of copies of
one record ordered by ID suffix.
Search totals scale exactly with the replica count.
Correction: perturb sort values and a share of the text per replica from the seed, or
state this limit in the brief next to every search and sort result.

**C10. Give each scale in four units.** Lines 36-38 give nodes only.
Record files, edges and bytes drive different costs (section 3.1). Correction: list
nodes, edges, record files and bytes per scale.
The generator’s manifest already has them.

### 6.4 Fairness and Measurement

**C11. W1 must compare like phases (lines 48-50).** Parsing and validation dominate and
do not depend on the backend (section 3.1). The fsqlite arm parses with worker processes
and streams rows (`fsqlite/parse_kb.py`). The FalkorDB arm calls paraverse’s `load_kb`,
one loop in one process that holds the corpus in memory (`falkordb/w1_load.py`,
`pg/kb.py:241-249`). A total W1 time would compare parsers and job counts.
Correction: require these phases in every result: discover and stat, parse, validate,
transform, ingest, index, verify, publish, durable on disk.
Compare backends on ingest through durable.
Report parsing once, with the parser and job count named.
State whether softschema validation is included.
Paraverse’s default load excludes it.

**C12. Define memory for server-based backends (lines 49-50, 80).** FalkorDBLite
daemonizes `redis-server`, and its parent PID is 1 (Measured;
`fl/redislite/configuration.py:25`). A measurement of waited-for children, such as
`fsqlite/measure.py`, cannot see it.
The FalkorDB arm already samples the server PID and any background-save child
(`falkordb/w1_load.py`). Correction: write the rule into the specification.
For a server backend record the client’s peak, the server’s peak including forked
children, and the engine’s own counters.
For a file backend record the process peak and say that file pages live in the OS page
cache. “In-memory size” has no meaning for fsqlite.
“On-disk size” for FalkorDB requires an explicit `SAVE`.

**C13. Define servable and durable.** An fsqlite publish is fsynced before it returns.
A FalkorDB load is in memory until the next snapshot, and with default rules that can be
five minutes later (section 5.5). Correction: record both times for every backend.
Report one FalkorDB run with the default save rules and one with saving disabled during
the load and an explicit `SAVE` at the end, to separate the engine from the wrapper’s
defaults.

**C14. Both backends must store the same content.** The fsqlite arm stores each
document’s top-level keys, its Markdown body and opaque files so that export can rebuild
the KB (`fsqlite/mapping.ts`). Paraverse stores the payload only (section 3.9). Sizes,
memory and W5 results are comparable only at equal stored content.
Correction: define the stored content once, for example payload, document head, body and
node-free artifacts, and report any backend that stores less.

**C15. Add a plain SQLite control now.** The brief defers plain SQLite.
Without it the results cannot separate what SQLite contributes from what the fsqlite
protocol costs (section 5.2). It uses the same schema and queries without the store, so
it is cheap to add for W1 and W3.

**C16. Name the arms.** Report FalkorDB as “paraverse as built”, which has full rebuild
only, and “incremental design” where they differ.
Report fsqlite as `DirectStore` and `SnapshotStore`. Let each backend use its documented
best strategy per workflow, and say which one produced each number.

**C17. Pin the configuration.** Record FalkorDB `THREAD_COUNT`, timeouts and save rules;
SQLite page size, cache size and journal mode; the Node version; fsqlite lock timeouts
and `gc` retention. The current FalkorDB documentation describes a default result-set
limit that the bundled 4.18.3 does not have (section 5.5), so cite measured settings.

### 6.5 Missing Workloads

**C18. Trickle updates (lines 51-56).** Batches of 1%, 5% and 20% are large enough to
hide fsqlite’s copy floor behind row work.
Correction: add batches of 1, 10 and 100 records, and a sustained test in records per
second with a bound on visibility delay.
This is what a live crawler produces.

**C19. Updates never change edges, and nothing is deleted.** The delta generator’s
header says updated records change one value and keep their IDs, edges and names, and
batches hold only new and updated records (`corpus/delta.py`). Replacing the edges of a
changed record and removing a record are the two hard parts of incremental import
(section 3.6). Removal requests are a first-class workflow in paraverse
(`pv/docs/data-policy.md:83-95`). Correction: make a share of updates add and drop
references.
Add about 2% deletes and 1% merges, where a merge retargets every edge of the
absorbed node.

**C20. Conflicting writes.** The brief’s scenario includes conflicting facts, but the
concurrent writers are not said to overlap.
Correction: define two cases.
In the first the writers touch disjoint records and the final state is deterministic.
In the second two writers update the same record with different values.
State the expected outcome per backend.
If a design claims provenance, check that both values and their sources remain
recoverable.

**C21. The batch format needs edge origins.** The loaders take node and edge existence
from `_graph` (`pg/kb.py:5-8`). An edge is often derived from a record that is not its
source node (section 3.6). Correction: for each changed record, the batch carries the
complete edge set derived from that record, tagged with the origin record.
Deleted records are listed explicitly.

**C22. Validation and quarantine.** No workflow includes validation, although it is the
largest cost (section 3.1). Correction: add softschema validation as a reported phase.
Add one invalid record to a batch and record what each pipeline does: reject the batch,
quarantine the record, or load it.

**C23. Schema evolution cases (lines 67-72).** The four cases are useful.
Two realistic ones are missing.
Correction: add a case where two contract versions of one kind coexist, which needs two
schema files for one kind.
Add a case where a field becomes sortable or filterable, which changes the index set and
is the one change that forces a new fsqlite store with a document mapping.
Measure W4 by lines of code and configuration changed as well as by time.
Say for each case whether the records are rewritten or left under their old contract.

**C24. Export scope and fidelity (lines 73-77).** Say which files are exported: records,
node-free artifacts, `_schemas`, `_graph`, `_search`, `README.md`. Report the three
fidelity levels of section 3.9 separately.
Require exported artifacts to pass softschema validation at their declared status.
Markdown bodies should come from the same renderer for every backend, or be stored by
every backend.

**C25. Crash tests (lines 78-80).** “Kill the loader” has several meanings.
Correction: for FalkorDB kill the client mid-load, then separately kill the server
mid-load and again within a minute after a completed load.
Record orphan staging graphs and what the restarted server serves.
For fsqlite kill during capture, during the build and during publication.
Expect the publication case to need the documented manual lock recovery, and record the
time and steps as an operational cost.

**C26. Reload detection and composition.** Neither appears in the workload.
Report the time from a published change on disk to a visible change in the API, split
into detection and apply.
Optionally add a workflow that serves two KBs with overlapping IDs as one view.
SQLite can attach two files in one connection.
FalkorDB cannot query across graphs, and paraverse materializes a third graph (section
1.3).

**C27. Capacity and feasibility.** State the disk and memory budget per scale.
Inferred from the S0 probes: S3 needs about 3 GB of record files, more in allocated
blocks; a 4 to 5 GiB SQLite file per retained version; and 8 to 18 GB of FalkorDB memory
before the staging copy.
The probe VM has 16 GB of RAM and had 16 GB of free disk when this was written.
Set fsqlite `gc` retention explicitly, and treat an out-of-memory or out-of-disk failure
as a result to report.

**C28. Results (lines 88-96).** Add per-phase timings, the number of repetitions and
their spread, every failure and timeout, the query plans, and exact versions: FalkorDB
module, Redis, falkordblite, SQLite, Node and softschema.

## Appendix A. Scratch Probes

Purpose: ground the analysis in the real S0 data.
These are single runs on one VM. They are not the spike benchmark and should not be
quoted as results.

Environment: 4 vCPU, 16 GB RAM, ext4 on a virtual disk, Linux 6.18, Python 3.13.18 with
PyYAML 6.0.3 (libyaml), SQLite 3.53.1 through Python’s `sqlite3`, falkordblite 0.10.0
(FalkorDB 4.18.3, Redis 8.6.2), softschema 0.8.1. Packages were installed from
paraverse’s lock file into a throwaway copy of `pv/db` with `exclude-newer = "14 days"`.
Nothing in the repositories was modified.

Scripts and outputs are under `<scratch>/research-a/`: `tools/falkor_probe.py`,
`tools/falkor_probe2.py`, `tools/sqlite_size_probe_rowid.py`,
`tools/sqlite_query_probe.py`, `tools/parse_probe.py`, and
`throwaway/falkor-probe-run2.json`.

### A.1 S0 Shape

| Measure | Value |
| --- | --- |
| Files under `kb/` | 5,001 |
| Record artifacts | 4,977: 1,420 Markdown, 3,557 YAML |
| Record bytes | 15,696,668 |
| File size, median, 95th percentile, maximum | 1.4 KB, 9.5 KB, 433 KB (`media.yaml`) |
| Markdown body bytes | 1,807,476 |
| Payload as JSON, all nodes | 12,777,466 bytes |
| Nodes, edges | 5,407 and 25,313 |
| Distinct artifact paths among nodes | 4,975 |
| Nested nodes | 14 days, 418 terms |
| Isolated nodes | 136 |
| Degree: median, mean, 95th, 99th percentile, maximum | 3, 9.6, 34, 81, 533 |
| Repeated `(source, relation, target)` triples | 323, at most 6 copies |
| Edge keys | `source`, `relation`, `target`, and up to nine scalar attributes. No ID, no origin. |
| `nodes.jsonl`, `edges.jsonl`, `documents.jsonl` | 720,421, 2,941,579 and 5,285,506 bytes |
| Largest directories | 577 files each in `people/` and `profiles/` |

### A.2 Parsing and Validation

| Step | Result |
| --- | --- |
| List artifacts | 0.13 s |
| Stat every file under `kb/` | 0.09 s |
| Read all record files, warm cache | 0.07 s |
| Parse 13.9 MB of YAML with libyaml | 1.34 s |
| Parse with pure-Python PyYAML, sample of 300 | 2.43 ms per artifact |
| Parse the same documents from JSON | 0.10 s |
| softschema validation, sample of 300 | 9.92 ms per artifact, no failures |
| `paraverse_graph.kb.load_kb`, complete | 1.84 s |

### A.3 FalkorDBLite With the Paraverse Loader

| Measure | Value |
| --- | --- |
| Server start | 0.12 s |
| `load_graph`, staging to rename | 1.66 s |
| Redis commands during the load | 150 |
| Unsaved changes after the load, saves during the load | 140 and 0 |
| `used_memory` before and after | 2.8 MB and 45.8 MB |
| `used_memory_rss` before and after | 24.0 MB and 119.8 MB |
| Server peak resident size (`VmHWM`) | 129 MB |
| `GRAPH.MEMORY USAGE` total | 17 MB: 11 MB node attributes, 1 MB relation matrices, 5 MB indexes |
| Explicit `SAVE`, RDB size | 0.06 s, 6,186,533 bytes |
| Restart and first query | 0.32 s |
| `CONFIG GET save` | `900 1 300 100 60 200 15 1000` |
| `appendonly`, `daemonize` | `no`, `yes`. Server parent PID is 1. |
| `GRAPH.CONFIG`: `RESULTSET_SIZE`, `THREAD_COUNT`, `TIMEOUT_DEFAULT` | -1, 4, 0 |
| `UNWIND range(1, 20000)` rows returned | 20,000 |
| Parallel edge example, 6 copies in the export | `count(m)` returns 1, `count(e)` returns 6 |
| Full-text counts: `agent`, `agents`, `agentic`, `run`, `running`, `pilot` | 364, 364, 364, 167, 167, 7 |
| Substring counts: `agent`, `agents`, `run`, `running`, `pilot` | 371, 186, 203, 58, 343 |
| Substring scan over all nodes | 11.4 ms |
| Return every `doc` | 62 ms |
| Undirected `shortestPath` | Rejected: “does not currently support undirected shortestPath traversals” |
| `algo.SPpaths`, both directions, at most 4 hops | 266 ms. Result: a 2-hop path through the event node. |
| Count all paths to 3 hops, and to 4 hops, between one person and one organization | 34 ms and 1,473 ms |
| Distinct nodes within 2 hops: largest hub, one person | 2,832 in 14 ms, 800 in 2 ms |
| Sorted page of repositories by stars | 0.63 ms. Plan: label scan, sort, skip, limit. |
| Range filter on the same property | Plan: index scan |

### A.4 Plain SQLite With a Generic Schema

The schema was three tables: `entity` (ID, kind, name, path, payload JSON, lowercased
search text), `edge` (source, relation, target, ordinal, attributes) and `doc`, with
three secondary indexes.
It is similar to the spike’s schema and is not the spike.

| Measure | Value |
| --- | --- |
| File size without bodies, with bodies, with bodies and an FTS5 index | 22.4, 24.6 and 27.0 MiB |
| Space: entity table, edge table with its two indexes | 16.2 MiB, 5.3 MiB |
| Load of all rows after parsing | 0.46 s |
| Copy the file, fsync the copy, `quick_check` | 8.9 ms, 47 to 72 ms, 11 ms |
| Substring scan with `instr` | 3.7 to 5.5 ms. Counts equal FalkorDB’s for all seven terms. |
| FTS5 counts, default tokenizer: `agent`, `agents`, `agentic`, `run`, `running`, `pilot` | 173, 186, 120, 84, 58, 3 |
| FTS5 top 20 by rank | 0.2 ms |
| Sorted page by a JSON expression: planner’s choice, forced expression index | 2.1 ms (scan and sort), 0.013 ms |
| Page 21 by name through an ordinary index | 0.03 ms |
| Distinct nodes within 2 hops: largest hub, one person | 2,831 in 3.5 ms, 799 in 0.4 ms (start node excluded) |
| Hop distance by bidirectional search in Python | 0.03 ms, distance 2 |
| Sessions per topic, top 20 | 0.17 ms |
| The same tables declared `WITHOUT ROWID` | 29.2 MiB: wide rows spill to overflow pages |

An FTS5 virtual table and its shadow tables were also inspected with the queries that
fsqlite’s schema check runs.
The virtual table reports no primary key column.

## Appendix B. Sources Read

- Paraverse: `README.md`, `AGENTS.md`, everything under `docs/`, `db/README.md`, every
  module under `db/src/paraverse_graph/`, the tests under `db/tests/`,
  `curation/README.md` and its CLI, and `backend/export_kb_native.py`. `work/` holds
  data for the native app’s conference catalog and does not bear on the KB import.
- Dataset: `README.md`, `kb/` (records, `_schemas`, `_graph`, `_search`),
  `pipeline/README.md`, and the pipeline modules `build.py`, `artifacts.py`, `graph.py`,
  `search.py`, `schemas.py`, `publication.py`, `models.py`, `ids.py`, `people.py`, plus
  the conference KB architecture document.
- softschema 0.8.1: `README.md`, `docs/softschema-spec.md`, `docs/softschema-guide.md`,
  and the Python modules `models.py`, `registry.py`, `compile.py`, `canonicalize.py`,
  `validate.py`, `schema_view.py`, `soft_field.py`, `_portable.py`.
- fsqlite: `README.md`, `packages/fsqlite/README.md`, `docs/fsqlite-design.md`,
  `docs/fsql-format-spec.md`, `docs/roadmap.md`, the workload-fit research document, and
  the schema checks in `packages/fsqlite/src/snapshotStore.ts` and `directStore.ts`.
- FalkorDBLite 0.10.0: `redislite/configuration.py`, `client.py`, `falkordb_client.py`.
- The spike directory as of about 01:00 on 2026-11-17: `WORKLOAD.md`, the file headers
  of `corpus/generate.py`, `corpus/idmap.py`, `corpus/delta.py`, `corpus/evolve.py`,
  `harness/oracle.py`, `harness/queries.json`, `falkordb/fdb.py`, `falkordb/w1_load.py`,
  and `fsqlite/parse_kb.py`, `mapping.ts`, `queries.ts`, `fts.ts`, `typed.ts`, `w1.ts`,
  `w2.ts`, `measure.py`.
- FalkorDB documentation, retrieved 2026-11-17: design, concurrency, durability,
  upgrades and compatibility, known limitations, configuration, bulk insert
  specification, `GRAPH.MEMORY`, `GRAPH.COPY`, algorithms, and the FalkorDBLite pages.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
