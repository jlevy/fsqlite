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
