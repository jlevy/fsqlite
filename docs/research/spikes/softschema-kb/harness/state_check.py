"""
Check the stored state after a batch against the reference applier, row by row.

A W3 match after a batch is necessary and not sufficient: the batches never delete or
absorb an entity a query names, and every W3 statement that reads `edge` joins it to
`entity`, so a missing, extra, or dangling edge shows only when it touches a queried
entity or moves an aggregate. This tool compares what each after-batch run recorded about
its stored rows with the rows of the reference state, the `delta2.py --apply` output.

For each reference state it computes, from the applied KB's `_graph/`:

- `nodes`: the count and sha256 of the node rows (`id`, `kind`, `name`, `path`) in id
  order, one canonical JSON array per line;
- `edges`: the count and sha256 of the edge multiset (`source`, `relation`, `target`,
  and the other properties as canonical JSON), sorted;
- `fsqlite_semantic_digest`: the edge digest in the form the fsqlite runs record
  (`semanticDigest` in `fsqlite/w2.ts`), computed from the reference rows with the
  property text each loader writes: Python's `json.dumps` for an edge as loaded, and
  compact JSON for an edge whose origin a merge rewrote.

A run is then **verified** when it recorded an edge digest equal to the reference's and an
entity count equal to the reference's node count; **known different** when it recorded
either and one differs; and **unverified** when it recorded only counts or nothing that
can be compared. A verified run's entity rows are checked against the reference by count
only, and against the one-writer state of the same run by digest.

    python harness/state_check.py --corpora $KB_CORPORA --applied $APPLIED \
        [--out results/state-check.json]

`--applied` holds `delta2.py --apply` outputs named `<scale>-<batch>`; every reference
state that has an after-batch W3 file or a recorded run is required.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
SPIKE = HERE.parent
RESULTS = SPIKE / "results"
EXPECTED = HERE / "expected"
sys.path.insert(0, str(HERE))

from compare import KbGraph, compare_files  # noqa: E402

STATES = ("S1-r2-p05", "S1-r2-p20", "S2-r2-p05")
# After-batch W3 files whose run file does not follow the naming rule in `source_for`.
SOURCES = {
    "fsqlite-v2/spike1/S1-r2/w3-after-p05-4writers.json": "fsqlite-v2/spike1/S1-r2/w2-inbuild-closure.json",
}


def jsonl(path: Path):
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                yield json.loads(line)


def canon(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def short(digest: str) -> str:
    return digest[:16]


def reference(base: Path, batch: Path, applied: Path) -> dict[str, Any]:
    """The reference state's row digests, from the applied KB (and, for the property text
    a loader would write, the base KB and the batch's merges)."""
    ops = list(jsonl(batch / "ops.jsonl"))
    merges = [o for o in ops if o["op"] == "merge"]
    retarget = {o["absorbed"]: o["survivor"] for o in merges}
    deleted = {i for o in ops if o["op"] == "delete" for i in o["node_ids"]}
    dropped_origins = {o["path"] for o in ops if o["op"] in ("upsert", "delete")}
    survivor_paths = {o["survivor_path"] for o in merges}

    def final(x: str) -> str:
        while x in retarget:
            x = retarget[x]
        return x

    # Edges a survivor record already had keep their loaded text; the others that now
    # carry a survivor's origin were rewritten by a merge, which stores compact JSON.
    kept: Counter[tuple[str, str, str, str]] = Counter()
    for e in jsonl(base / "_graph" / "edges.jsonl"):
        if e.get("origin") in survivor_paths and e["origin"] not in dropped_origins:
            s, t = final(e["source"]), final(e["target"])
            if s not in deleted and t not in deleted:
                rest = {k: v for k, v in e.items() if k not in ("source", "relation", "target")}
                kept[(s, e["relation"], t, canon(rest))] += 1

    canonical_rows, loaded_rows = [], []
    for e in jsonl(applied / "_graph" / "edges.jsonl"):
        s, r, t = e["source"], e["relation"], e["target"]
        rest = {k: v for k, v in e.items() if k not in ("source", "relation", "target")}
        canonical_rows.append(canon([s, r, t, rest]))
        if not rest:
            text = None
        elif rest.get("origin") in survivor_paths and kept[(s, r, t, canon(rest))] == 0:
            text = json.dumps(rest, separators=(",", ":"), ensure_ascii=False)
        else:
            if rest.get("origin") in survivor_paths:
                kept[(s, r, t, canon(rest))] -= 1
            text = json.dumps(rest, ensure_ascii=False)
        loaded_rows.append((s, r, t, text))
    canonical_rows.sort()
    loaded_rows.sort(key=lambda row: (row[0], row[1], row[2], row[3] is not None, row[3] or ""))
    edge_hash, semantic = hashlib.sha256(), hashlib.sha256()
    for line in canonical_rows:
        edge_hash.update((line + "\n").encode("utf-8"))
    for row in loaded_rows:
        semantic.update(json.dumps(list(row), separators=(",", ":"), ensure_ascii=False).encode("utf-8"))

    nodes = sorted(
        (canon([n["id"], n["kind"], n.get("name"), n["path"]]) for n in jsonl(applied / "_graph" / "nodes.jsonl")),
    )
    node_hash = hashlib.sha256()
    for line in nodes:
        node_hash.update((line + "\n").encode("utf-8"))
    stats = json.loads((applied / "_graph" / "stats.json").read_text())
    if (stats["node_total"], stats["edge_total"]) != (len(nodes), len(canonical_rows)):
        raise SystemExit(f"{applied}: stats.json does not match its own _graph rows")
    return {
        "nodes": {"count": len(nodes), "sha256": node_hash.hexdigest()},
        "edges": {"count": len(canonical_rows), "sha256": edge_hash.hexdigest()},
        "fsqlite_semantic_digest": {
            "entity_count": len(nodes),
            "edge": f"{len(loaded_rows)}:{short(semantic.hexdigest())}",
        },
    }


def source_for(w3: str) -> str:
    """The result file of the run that wrote an after-batch W3 file."""
    if w3 in SOURCES:
        return SOURCES[w3]
    folder, name = w3.rsplit("/", 1)
    if name == "w3-after-p05.json":
        return f"{folder}/{'w2.json' if w3.startswith('falkordb/') else 'w2-v2.json'}"
    if name == "w3-after-p05-DirectStore.json":
        return f"{folder}/w2-v2-one-writer.json"
    if name == "w3-after-p05-4writers.json":
        return f"{folder}/w2.json"
    match = re.fullmatch(r"w3-after-p05-4writers-(.+)\.json", name)
    if match:
        return f"{folder}/w2-{match.group(1)}.json"
    raise SystemExit(f"{w3}: no rule names the run that wrote it; add it to SOURCES")


def records(run: dict[str, Any], batch: str, arm: str | None = None) -> list[dict[str, Any]]:
    """
    What a run recorded about its stored state after `batch`, one entry per repetition:
    for `arm`, that arm of a one-writer run (`w2v2.ts`); otherwise the concurrent writers
    of a `w2.ts` run, or the FalkorDB incremental prototype.
    """
    out: list[dict[str, Any]] = []
    if arm is not None:
        result = run.get("results", {}).get(batch) or {}
        if result.get("digests", {}).get(arm):
            return [{"what": f"{arm}, one writer in line order", "digest": result["digests"][arm]}]
        for r in result.get("arms", {}).get(arm, {}).get("runs", []):
            if r.get("state"):
                out.append({"what": f"{arm}, one writer in line order", "counts_only": json.loads(r["state"])})
        return out
    if run.get("backend") == "falkordb":
        for b in run.get("batches", []):
            if b.get("batch") == batch:
                inc = b.get("incremental_prototype", {})
                out.append({
                    "what": "FalkorDB incremental prototype",
                    "counts_only": {
                        "per_kind_and_relation_counts_match_rebuild": inc.get("counts_match_rebuild"),
                        "rebuild_counts_match_reference_stats": b.get("paraverse_as_built", {}).get("counts_match_post_batch_stats"),
                    },
                })
        return out
    for b in run.get("batches", []):
        if b.get("batch") == batch and b.get("same_rows_as_one_writer_in_line_order"):
            rows = b["same_rows_as_one_writer_in_line_order"]
            out.append({"what": "concurrent writers", "digest": rows["concurrent"], "line_order": rows["line_order"]})
    return out


def verdict(entry: dict[str, Any], ref: dict[str, Any]) -> tuple[str, str]:
    want = ref["fsqlite_semantic_digest"]
    if "digest" in entry:
        edge, entity = entry["digest"]["edge"], entry["digest"]["entity"]
        count = int(entity.split(":")[0])
        problems = []
        if edge != want["edge"]:
            problems.append(f"edge digest {edge}, reference {want['edge']}")
        if count != want["entity_count"]:
            problems.append(f"{count} entities, reference {want['entity_count']} nodes")
        if problems:
            return "known different", "; ".join(problems)
        return "verified", f"edge multiset equal to the reference ({edge}); {count} entities, as the reference"
    if "counts_only" in entry:
        return "unverified", f"the run recorded counts only: {canon(entry['counts_only'])}"
    return "unverified", "the run recorded nothing about its rows"


def combine(verdicts: list[tuple[str, str]]) -> tuple[str, str]:
    if not verdicts:
        return "unverified", "the run recorded nothing about its rows"
    if len({v for v, _ in verdicts}) == 1:
        return verdicts[0][0], verdicts[0][1] + (f" (all {len(verdicts)} repetitions)" if len(verdicts) > 1 else "")
    return "unverified", "repetitions disagree: " + "; ".join(f"{v}: {b}" for v, b in verdicts)


def build(corpora: Path, applied: Path) -> dict[str, Any]:
    refs = {}
    for state in STATES:
        scale, batch = state.rsplit("-", 1)
        out = applied / state
        if not (out / "_graph").is_dir():
            raise SystemExit(f"{out} is missing: run delta2.py --apply for {state} first")
        refs[state] = {"batch": batch, **reference(corpora / scale / "kb", corpora / scale / "deltas" / batch, out)}

    w3_files = sorted(
        p.relative_to(RESULTS).as_posix()
        for p in RESULTS.rglob("w3-after-*.json")
        if not p.relative_to(RESULTS).as_posix().startswith("quiet/")
    )
    table: list[dict[str, Any]] = []
    line_order_entities: dict[str, set[str]] = {state: set() for state in STATES}
    runs: list[dict[str, Any]] = []
    for path in sorted(RESULTS.rglob("w2*.json")):
        rel = path.relative_to(RESULTS).as_posix()
        if rel.startswith("quiet/") or "-r2/" not in rel:
            continue
        run = json.loads(path.read_text())
        scale = path.parent.name
        for batch in ("p05", "p20"):
            state = f"{scale}-{batch}"
            if state not in refs:
                continue
            for entry in records(run, batch):
                if "line_order" in entry:
                    line_order_entities[state].add(entry["line_order"]["entity"])
                    v, basis = verdict({"digest": entry["line_order"]}, refs[state])
                    runs.append({"run": rel, "batch": batch, "state": "one writer in line order (built by the run)", "verdict": v, "basis": basis})
                v, basis = verdict(entry, refs[state])
                runs.append({"run": rel, "batch": batch, "state": entry["what"], "verdict": v, "basis": basis})
            for arm in ("DirectStore", "Append", "SnapshotStore"):
                for entry in records(run, batch, arm):
                    v, basis = verdict(entry, refs[state])
                    runs.append({"run": rel, "batch": batch, "state": entry["what"], "verdict": v, "basis": basis})

    graphs: dict[str, KbGraph] = {}
    for w3 in w3_files:
        path = RESULTS / w3
        state = f"{path.parent.name}-{re.search(r'after-(p\d+)', w3).group(1)}"
        src = source_for(w3)
        run = json.loads((RESULTS / src).read_text())
        arm = "DirectStore" if w3.endswith("-DirectStore.json") else "SnapshotStore" if src.endswith("w2-v2.json") else None
        entries = records(run, state.rsplit("-", 1)[1], arm)
        v, basis = combine([verdict(e, refs[state]) for e in entries])
        if v == "verified":
            entities = {e["digest"]["entity"] for e in entries if "digest" in e}
            same = entities <= line_order_entities[state] if line_order_entities[state] else None
            basis += "; entity rows equal to the one-writer state" if same else "; entity rows not compared with a one-writer state"
        if state not in graphs:
            graphs.clear()
            graphs[state] = KbGraph(applied / state)
        ok, _, tally = compare_files(EXPECTED / state / "w3.json", path, None, 0, graphs[state])
        table.append({
            "w3_file": w3,
            "state": state,
            "w3_against_oracle": f"{'MATCH' if ok else 'MISMATCH'}: {tally['ok']} ok, {tally['differ'] + tally['missing']} differ",
            "run": src,
            "recorded": [e["what"] for e in entries],
            "verdict": v,
            "basis": basis,
        })

    count = Counter(row["verdict"] for row in table)
    return {
        "description": (
            "Row-level check of every after-batch W3 file's stored state against the delta2.py --apply "
            "reference; written by harness/state_check.py. A W3 match after a batch is necessary and not sufficient."
        ),
        "verdicts": {
            "verified": "the run recorded an edge digest equal to the reference's and an entity count equal to its node count",
            "known different": "the run recorded a digest or count that differs from the reference",
            "unverified": "the run recorded only counts, or nothing about its rows",
        },
        "summary": {k: count.get(k, 0) for k in ("verified", "unverified", "known different")},
        "references": refs,
        "w3_files": table,
        "runs": runs,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--corpora", type=Path, required=True, help="holds <scale>/kb and <scale>/deltas")
    ap.add_argument("--applied", type=Path, required=True, help="holds delta2.py --apply outputs named <scale>-<batch>")
    ap.add_argument("--out", type=Path, default=RESULTS / "state-check.json")
    args = ap.parse_args()
    doc = build(args.corpora, args.applied)
    args.out.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(doc["summary"]))
    for row in doc["w3_files"]:
        print(f"{row['verdict']:16} {row['w3_against_oracle']:28} {row['w3_file']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
