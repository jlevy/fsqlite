# FalkorDB Backend: paraverse on FalkorDBLite

This arm measures FalkorDBLite the way
[paraverse](https://github.com/jlevy/paraverse) uses it.
Every graph is loaded by paraverse's own `kb.load_kb` and `loader.load_graph`, from
`attic/paraverse/db/src`, unmodified, and every W3 query is modeled on paraverse's
Cypher. Results go to `../results/falkordb/<scale>/`.

Two arms are reported where they differ:

- **paraverse as built**: a full rebuild into a staging graph, then `RENAME`.
  This is paraverse's only update path.
- **incremental prototype**: a spike-only upsert built from paraverse's mapping
  functions (`labels_for`, `node_properties`, `readable_name`). It is not part of
  paraverse.

## Setup

paraverse pins uv 0.12 and a 14-day cool-off (`db/uv.toml`: `exclude-newer = "14
days"`). This VM had uv 0.11.32, so uv 0.12.24 was installed into the scratchpad with
the same cool-off, without touching the system uv:

```bash
SP=/tmp/claude-0/-home-user/bac81f03-965b-51f3-b055-bed7bf70e318/scratchpad
UV_TOOL_DIR=$SP/uvtool/tools UV_TOOL_BIN_DIR=$SP/uvtool/bin \
  uv tool install 'uv>=0.12,<0.13' --exclude-newer "$(date -u -d '14 days ago' +%Y-%m-%dT%H:%M:%SZ)"
```

The spike runs inside paraverse's own locked environment, synced into the scratchpad.
`--locked` refuses to change `uv.lock`, and `--no-install-project` skips building
paraverse itself, so no build backend or install script runs; paraverse's source is
imported from `db/src` by path:

```bash
cd attic/paraverse/db
UV_CONFIG_FILE=uv.toml UV_PROJECT_ENVIRONMENT=$SP/pv-venv \
  $SP/uvtool/bin/uv sync --locked --no-install-project --no-dev
```

That installs falkordb 1.7.1, falkordblite 0.10.0 (Redis 8.6.2 with the FalkorDB 4.18.3
module, as binary wheels), redis-py 8.1.0, softschema 0.8.1 and PyYAML 6.0.3, all from
paraverse's lock. The spike adds no dependencies, so it needs no lock of its own.

## Commands

```bash
export PYTHONDONTWRITEBYTECODE=1 TMPDIR=$SP/tmp KB_CORPORA=$SP/kb-corpora FALKORDB_DATA=$SP/fdb-data
PY=$SP/pv-venv/bin/python
$PY run.py --scale S1 --steps oracle w1 w1nosave w3 compare   # then: w2 w4 w5 w6
```

| Script | Workflow |
| --- | --- |
| `w1_load.py` | W1: paraverse load into an empty server, per-phase timings, peak RSS of loader and server (with BGSAVE children), engine counters, servable and durable times, RDB size; `--save-mode disabled` for the explicit-SAVE run; `--validate` to time softschema validation; a memory guard |
| `w3_queries.py` | W3: every `harness/queries.json` instance, 1 cold and 50 warm runs, canonical results, the `GRAPH.EXPLAIN` plan of every statement, uncompared extras |
| `w2_update.py` | W2: per delta batch, paraverse as built and the incremental prototype, checked against each other; 4 writers plus a reader |
| `w4_evolve.py` | W4: each evolution variant with unmodified paraverse, as a rebuild with the needed code change, and as an in-place Cypher migration |
| `w5_export.py` | W5: export the graph back to the KB layout, compare with the source, reload the export and rerun W3 |
| `w6_ops.py` | W6: artifacts, standard tools, start-up, memory at rest, three crash tests |
| `fdb.py` | The server wrapper and the W3 queries in Cypher |
| `summarize.py` | Prints the headline tables below from the result files |

## Results

Every W3 result at S0, S1 and S2 equals the oracle's (`compare-oracle.txt`: 24 of 24).

**W1, paraverse as built** (default save rules; durable adds one explicit `SAVE`):

| Scale | Servable | Durable | Parse | Ingest | Loader peak RSS | Server peak RSS (with BGSAVE fork) | RDB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S0 | 3.6 s | 3.7 s | 1.7 s | 0.9 s | 0.23 GB | 0.12 GB | 6 MB |
| S1 | 32 s | 33 s | 15 s | 7.3 s | 1.05 GB | 0.38 GB | 55 MB |
| S2 | 184 s | 188 s | 79 s | 42 s | 5.07 GB | 1.70 GB (2.81 GB) | 282 MB |
| S3 | aborted by the memory guard | | | | over 6 GB before the first artifact | | |

With saves disabled during the load and one `SAVE` at the end, S2's ingest through
durable falls from 88 s to 80 s and the server peak from 2.81 GB to 1.72 GB.
Parse times depend on the page cache, which this shared VM does not drop.
softschema validation, not part of paraverse's default load, takes 44 s at S0 (4,977
artifacts, no problems).
S3 is infeasible on this VM with paraverse's loader: `load_kb` passes 6 GB while it
snapshots 920k files and holds 4.7M edges, before parsing any record; S2's 5.07 GB
projects to about 20 GB.

**W3, warm p50** (selected; all 24 plus extras in `w3.json` and `summarize.py`):

| Query | S0 | S1 | S2 |
| --- | --- | --- | --- |
| table.sessions_by_start.p1 | 1.0 ms | 3.7 ms | 37 ms |
| table.repos_by_stars.p1 | 1.1 ms | 4.7 ms | 75 ms |
| table.people_by_org.p1 | 0.9 ms | 0.8 ms | 1.1 ms |
| record.person | 1.2 ms | 1.0 ms | 1.2 ms |
| search.copilot (substring scan) | 8.4 ms | 76 ms | 438 ms |
| search.copilot (RediSearch, uncompared) | 0.5 ms | 1.7 ms | 6.6 ms |
| path.person_person_4 (BFS) | 12 ms | 11 ms | 12 ms |
| path.unreachable (BFS) | 8.1 ms | 7.8 ms | 8.1 ms |
| path.unreachable (in-engine, uncompared) | 298 ms | 295 ms | 300 ms |
| facet.sessions_per_topic | 1.7 ms | 12 ms | 65 ms |
| neighborhood.session | 2.6 ms | 2.4 ms | 1.9 ms |

Sorted pages and facets scan a label and sort (their plans show no index use, though a
range index exists on the sort property), so they grow with the corpus. Lookups by ID
stay flat, partly because the synthetic corpora do not grow hubs (see
`../corpus/README.md`).

**W2** (time until queries see the change; durable adds a `SAVE`):

| Scale | Batch | paraverse as built | incremental prototype | Equal results |
| --- | --- | --- | --- | --- |
| S1 | 1% (487) | 63 s | 0.36 s | yes |
| S1 | 5% (2,433) | 40 s | 1.65 s | yes |
| S1 | 20% (9,733) | 67 s | 6.6 s | yes |
| S2 | 1% (2,487) | 195 s | 1.9 s | yes |
| S2 | 5% (12,436) | 205 s | 8.3 s | yes |
| S2 | 20% (49,744) | 227 s | 47 s | yes |

paraverse as built includes materializing the post-delta KB (the KB build's job, 3 to
18 s). The incremental prototype matched the rebuild on per-kind and per-relation
counts and on all 24 W3 results for every batch. With 4 concurrent writers (S1, 5%),
the batch applied in 2.6 s with no errors; the reader saw no errors, and its record p95
rose from 1.7 ms to 13.6 ms during the writes. At S2 (5%) the writers took 26 s, again
with no errors, and record p95 rose from 1.7 ms to 18 ms. A full rebuild running beside
the reader barely moved its latencies.

**W4** (S1): a new kind fails unmodified paraverse (`MappingError: no label for kind
award`) and needs a code change plus a 32 s rebuild; an added field and a renamed
relation need only a rebuild (31 to 34 s). In place, each migration took 1.3 to 3.8 s
and matched the rebuild. Changing `primary_language` to an object silently empties the
repository table (1,485 rows to 0), because objects are not FalkorDB properties.

**W5** (S0, S1): every payload, softschema block and edge round-trips, and the reloaded
export gives identical W3 results, but no file is byte-identical (sorted keys, YAML
style), every Markdown body is lost (1,420 at S0), profiles lose their export names,
and `_search`, `coverage.json`, `faq.yaml`, `media.yaml` and two schemas are not in
the graph. Export takes 9 s at S0 and 89 s at S1.

**W6** (S1): two files (a 55 MB RDB and a settings registry). The bundled
`redis-check-rdb` accepts the file, but the system's Redis 7.0.15 cannot open it ("Can't
handle RDB format version 13"), and only a server with the module can read graphs.
Start-up to the first query takes 3.0 s at S1 (W6, median of 3) and 20 s at S2 (W3); at
rest the S1 server holds 0.27 GB (`used_memory`), 0.31 GB RSS. Killing the client mid-load leaves the live graph intact and an orphan
staging graph that the retry does not remove. After a server SIGKILL, redislite will
not restart until its stale `.settings` file is deleted, and a load completed 5 s
before the kill is lost: the restarted server serves the previous load.

## Caveats

- **Socket timeout.** redis-py 8.1.0, which paraverse's lock pins, defaults
  `socket_timeout` to 5 s.
  At S2 paraverse's own load check (`MATCH ()-[e]->() RETURN type(e), count(e)`) runs
  longer, so the unmodified loader fails with "Timeout reading from socket".
  Every run here opens the server as `open_db` does but with `socket_timeout=None`
  (`fdb.open_embedded`); `FDB_PARAVERSE_DEFAULT_TIMEOUT=1` restores the exact client.
- **Query plans.** FalkorDB's planner starts undirected two-hop patterns from a label
  scan unless the anchor node is bound first with `WITH`: 174 ms against 1.7 ms for one
  S1 neighborhood. The spike anchors every multi-hop query; plans are stored per query.
- **Paths.** FalkorDB has no undirected `shortestPath()` and cannot exclude hubs inside
  one. The compared figure is the same application-side bidirectional BFS that the
  fsqlite arm runs, one Cypher neighbor query per frontier. In-engine iterative
  deepening and `algo.SPpaths` are reported as uncompared extras; `algo.SPpaths` cannot
  exclude hubs, so its paths can be shorter.
- **Search.** The compared figure is a substring scan over `display_name`, `title` and
  `bio`. paraverse's own `/api/search` uses the stemmed RediSearch index, which matches
  different nodes, so it is an uncompared extra.
- **Memory.** `load_kb` holds every parsed artifact in the loader process before
  `load_graph` writes, so loader memory grows linearly with the corpus. The embedded
  server is daemonized (its parent is PID 1), so its RSS is sampled by PID, together
  with any BGSAVE child it forks.
- **Durability.** A completed load is servable but lives only in memory until the next
  snapshot. redislite's default rules (`save 900 1 / 300 100 / 60 200 / 15 1000`) fork
  BGSAVEs during and after a load; the save-disabled run measures the same load with one
  explicit `SAVE`.
- **One VM.** Timings come from one 4-vCPU cloud VM with 15 GB of RAM and are useful for
  relative sizing only.

<!-- This document follows common-doc-guidelines.md.
See github.com/jlevy/practical-prose and review guidelines before editing.
-->
