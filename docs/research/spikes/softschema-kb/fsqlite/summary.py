"""
Print the fsqlite arm's headline numbers per scale as Markdown tables, from
results/fsqlite/<scale>/*.json. Standard library only.

Usage: python3 summary.py [S0 S1 S2 ...]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

RESULTS = Path(__file__).resolve().parent.parent / "results" / "fsqlite"


def load(scale: str, name: str) -> dict | None:
    path = RESULTS / scale / f"{name}.json"
    return json.loads(path.read_text()) if path.exists() else None


def mib(n: float | None) -> str:
    return "n/a" if n is None else f"{n / 2**20:,.0f}"


def ms(n: float | None, digits: int = 1) -> str:
    return "n/a" if n is None else f"{n:,.{digits}f}"


def w1_table(scales: list[str]) -> list[str]:
    rows = [
        "| Scale | Parse s (4 jobs) | DirectStore ingest to durable s | SnapshotStore ingest to durable s | Plain SQLite ingest to durable s | Peak RSS MiB (parse / import) | Snapshot MiB | FTS sidecar s / MiB |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for s in scales:
        w1, ctl = load(s, "w1"), load(s, "w1-plain-sqlite")
        if not w1:
            continue
        d, sn = w1["direct"], w1.get("snapshot", {})
        plain = ctl["indexes_first"]["phases"]["ingest_through_durable_ms"] / 1000 if ctl else None
        fts = d.get("fts_sidecar", {})
        rows.append(
            f"| {s} | {w1['parse']['seconds']:.1f} | {d['ingest_through_durable_seconds']:.1f} | "
            f"{sn.get('ingest_through_durable_seconds', float('nan')):.1f} | {ms(plain)} | "
            f"{w1['parse']['max_rss_mib']:.0f} / {d['max_rss_mib']:.0f} | {mib(d['snapshot_bytes'])} | "
            f"{fts.get('build_ms', 0) / 1000:.1f} / {mib(fts.get('bytes'))} |"
        )
    return rows


def w3_table(scales: list[str]) -> list[str]:
    docs = {s: load(s, "w3") for s in scales}
    variants = {s: (load(s, "w3-fts"), load(s, "w3-path-cte"), load(s, "w3-plain-sqlite")) for s in scales}
    names = [q["name"] for q in next(d for d in docs.values() if d)["queries"]]
    rows = [
        "| Query | " + " | ".join(f"{s} p50 (p95)" for s in scales if docs[s]) + " |",
        "| --- | " + " | ".join("---" for s in scales if docs[s]) + " |",
    ]
    for name in names:
        cells = []
        for s in scales:
            if not docs[s]:
                continue
            q = next(x for x in docs[s]["queries"] if x["name"] == name)
            cells.append(f"{q['timings']['p50_ms']:.3g} ({q['timings']['p95_ms']:.3g})")
        rows.append(f"| {name} | " + " | ".join(cells) + " |")
    for label, index in (("search via FTS5 sidecar", 0), ("path via recursive CTE", 1)):
        for prefix in ("search.", "path."):
            if (index == 0) != (prefix == "search."):
                continue
            for name in [n for n in names if n.startswith(prefix)]:
                cells = []
                for s in scales:
                    if not docs[s]:
                        continue
                    v = variants[s][index]
                    q = next((x for x in (v or {}).get("queries", []) if x["name"] == name), None)
                    if q is None:
                        cells.append("n/a")
                    elif q["timings"].get("timed_out"):
                        cells.append(f"timeout ({q['timings']['timeout_ms']} ms)")
                    else:
                        cells.append(f"{q['timings']['p50_ms']:.3g} ({q['timings']['p95_ms']:.3g})")
                rows.append(f"| {name} ({label}) | " + " | ".join(cells) + " |")
    return rows


def w2_table(scales: list[str]) -> list[str]:
    rows = [
        "| Scale | Batch | Arm | Visible after ms | Capture p50 ms | Reconcile ms | Sidecar rebuild ms | Reader p95 ms during | Reader errors |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for s in scales:
        for name in ("w2", "w2-direct"):
            doc = load(s, name)
            for b in (doc or {}).get("batches", []):
                rec = b.get("reconcile") or {}
                rows.append(
                    f"| {s} | {b['batch']} ({b['delta']['changes']} records) | {b['arm']} | "
                    f"{b['visible_after_ms']} | {ms(b['capture_ms']['p50_ms'])} | {ms(rec.get('ms'))} | "
                    f"{ms(b['fts_sidecar_rebuild']['build_ms'], 0)} | "
                    f"{ms(b['reader']['during_writes']['p95_ms'])} | {b['reader']['errors']} |"
                )
    return rows


def trickle_table(scales: list[str]) -> list[str]:
    rows = [
        "| Scale | 1 record ms (Snapshot / Direct) | 10 records ms | 100 records ms | Sustained records/s | Visibility p50 / p95 ms |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for s in scales:
        t = load(s, "w2-trickle")
        if not t:
            continue
        b = t["batches"]
        cell = lambda n: f"{b[f'SnapshotStore.{n}']['visible_ms_median']:.0f} / {b[f'DirectStore.{n}']['visible_ms_median']:.0f}"
        v = t["sustained"]
        rows.append(
            f"| {s} | {cell(1)} | {cell(10)} | {cell(100)} | {v['capture_records_per_s']} | "
            f"{v['visibility_delay_ms']['p50']:.0f} / {v['visibility_delay_ms']['p95']:.0f} |"
        )
    return rows


def main() -> None:
    scales = sys.argv[1:] or ["S0", "S1", "S2"]
    for title, table in (
        ("W1", w1_table(scales)),
        ("W3 warm ms", w3_table(scales)),
        ("W2", w2_table(scales)),
        ("W2 trickle", trickle_table(scales)),
    ):
        print(f"### {title}\n")
        print("\n".join(table))
        print()


if __name__ == "__main__":
    main()
