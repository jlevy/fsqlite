"""
Print the round-2 tables (S1-r2, S2-r2 against round-1 S1, S2) as Markdown, from
results/fsqlite/<scale>/*.json. Standard library only.

Usage: python3 summary_r2.py
"""

from __future__ import annotations

import json
import statistics
from pathlib import Path

RESULTS = Path(__file__).resolve().parent.parent / "results" / "fsqlite"
PAIRS = [("S1", "S1-r2"), ("S2", "S2-r2")]


def load(scale: str, name: str) -> dict | None:
    path = RESULTS / scale / f"{name}.json"
    return json.loads(path.read_text()) if path.exists() else None


def med(values: list[float]) -> float:
    return statistics.median(values) if values else float("nan")


def w1_rows() -> list[str]:
    rows = [
        "| Scale | Parse s (incl. check) | Schema check CPU s | DirectStore s | SnapshotStore s | Plain SQLite s | Snapshot MiB |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r1, r2 in PAIRS:
        for s in (r1, r2):
            w, c = load(s, "w1"), load(s, "w1-plain-sqlite")
            if not w:
                continue
            v = (w["parse"].get("report") or {}).get("validation") or {}
            rows.append(
                f"| {s} | {w['parse']['seconds']:.1f} | {v.get('cpu_seconds_summed_over_workers', 'not run')} | "
                f"{w['direct']['ingest_through_durable_seconds']:.1f} | "
                f"{w['snapshot']['ingest_through_durable_seconds']:.1f} | "
                f"{c['indexes_first']['phases']['ingest_through_durable_ms'] / 1000:.1f} | "
                f"{w['direct']['snapshot_bytes'] / 2**20:,.0f} |"
                if c
                else f"| {s} | n/a |"
            )
    return rows


def w3_rows() -> list[str]:
    rows = [
        "| Category | " + " | ".join(f"{s} median p50 (max p50) ms" for pair in PAIRS for s in pair) + " |",
        "| --- | " + " | ".join("---" for pair in PAIRS for _ in pair) + " |",
    ]
    docs = {s: load(s, "w3") for pair in PAIRS for s in pair}
    for cat in ("table", "record", "search", "path", "facet", "neighborhood"):
        cells = []
        for pair in PAIRS:
            for s in pair:
                d = docs[s]
                p50 = [q["timings"]["p50_ms"] for q in (d or {}).get("queries", []) if q["category"] == cat]
                cells.append(f"{med(p50):.3g} ({max(p50):.3g})" if p50 else "n/a")
        rows.append(f"| {cat} | " + " | ".join(cells) + " |")
    fts = {s: load(s, "w3-fts") for _, s in PAIRS}
    cells = []
    for _, s in PAIRS:
        p50 = [q["timings"]["p50_ms"] for q in (fts[s] or {}).get("queries", []) if q["category"] == "search"]
        cells.append(f"{med(p50):.3g} ({max(p50):.3g})" if p50 else "n/a")
    rows.append("| search via FTS5 sidecar (r2) | n/a | " + cells[0] + " | n/a | " + cells[1] + " |")
    return rows


def hub_rows() -> list[str]:
    rows = [
        "| Query | S1-r2 p50 ms | S2-r2 p50 ms | Growth | Non-hub median p50, S1-r2 / S2-r2 | Plan of the slowest statement at S2-r2 |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    a, b = load("S1-r2", "w3"), load("S2-r2", "w3")
    if not a or not b:
        return rows
    qa = {q["name"]: q for q in a["queries"]}
    for q in b["queries"]:
        if not q.get("hub"):
            continue
        x = qa.get(q["name"])
        cat = q["category"]
        non = lambda d: med([y["timings"]["p50_ms"] for y in d["queries"] if y["category"] == cat and not y.get("hub")])
        plan = max(q.get("plans", []), key=lambda p: len(p["plan"]), default={"plan": []})["plan"]
        rows.append(
            f"| {q['name']} | {x['timings']['p50_ms']:.3g} | {q['timings']['p50_ms']:.3g} | "
            f"{q['timings']['p50_ms'] / x['timings']['p50_ms']:.1f}x | {non(a):.3g} / {non(b):.3g} | "
            f"{'; '.join(plan[:4])} |"
        )
    return rows


def w2_rows() -> list[str]:
    rows = [
        "| Scale | Batch | Ops | One writer, SnapshotStore ms (capture + reconcile) | One writer, DirectStore ms | 4 writers visible ms | 4-writer state vs oracle |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for _, s in PAIRS:
        one, four = load(s, "w2-v2"), load(s, "w2")
        if not one:
            continue
        fours = {b["batch"]: b for b in (four or {}).get("batches", [])}
        for name, v in one["results"].items():
            snap, direct = v["arms"]["SnapshotStore"], v["arms"]["DirectStore"]
            f = fours.get(name)
            check = (f or {}).get("w3_check_against_reference") or {}
            rows.append(
                f"| {s} | {name} | {v['parse'].get('ops')} | {snap['visible_ms']:.0f} "
                f"({snap['capture_ms']:.0f} + {snap['reconcile_ms']:.0f}) | {direct['visible_ms']:.0f} | "
                f"{f['visible_after_ms'] if f else 'n/a'} | {check.get('result', 'n/a')} |"
            )
    return rows


def main() -> None:
    for title, table in (("W1", w1_rows()), ("W3 v2", w3_rows()), ("Hubs", hub_rows()), ("W2 v2", w2_rows())):
        print(f"### {title}\n")
        print("\n".join(table))
        print()


if __name__ == "__main__":
    main()
