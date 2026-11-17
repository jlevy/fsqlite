"""
Print headline Markdown tables from results/falkordb/<scale>/*.json.

    python summarize.py
"""

from __future__ import annotations

import json
from pathlib import Path

RESULTS = Path(__file__).resolve().parent.parent / "results" / "falkordb"
SCALES = ("S0", "S1", "S2", "S3")


def _load(scale: str, name: str) -> dict | None:
    path = RESULTS / scale / name
    return json.loads(path.read_text()) if path.is_file() else None


def gb(n: float | None) -> str:
    return "" if n is None else f"{n / 1e9:.2f}"


def w1_table() -> None:
    print("| Scale | Save rules | Servable s | Durable s | Parse s | Ingest s | Loader peak GB | Server peak GB (with fork) | used_memory GB | RDB MB |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for s in SCALES:
        for name, label in (("w1.json", "default"), ("w1-save-disabled.json", "off, one SAVE")):
            d = _load(s, name)
            if not d:
                continue
            if d.get("aborted"):
                print(f"| {s} | {label} | aborted: {d['abort_reason']} after {d['artifacts_parsed_at_abort']:,} artifacts | | | | {gb(d['memory_at_abort']['loader_peak_rss'])} | | | |")
                continue
            t, m, p = d["timings"], d["memory"], d.get("phases", {})
            print(
                f"| {s} | {label} | {t.get('servable_s', t.get('import_s'))} | {t.get('durable_s', '')} | {p.get('parse_s', '')} | {p.get('ingest_s', '')} "
                f"| {gb(m['loader_peak_rss'])} | {gb(m['server_peak_rss'])} ({gb(m.get('server_peak_rss_with_children', m.get('server_peak_rss_with_bgsave')))}) "
                f"| {gb(m['server_used_memory'])} | {d['size']['rdb_bytes'] / 1e6:.0f} |"
            )


def w3_table() -> None:
    docs = {s: _load(s, "w3.json") for s in SCALES}
    scales = [s for s in SCALES if docs[s]]
    print("| Query | " + " | ".join(f"{s} p50 ms" for s in scales) + " |")
    print("| --- |" + " --- |" * len(scales))
    names = [q["name"] for q in docs[scales[0]]["queries"]] + [e["name"] for e in docs[scales[0]].get("extras", [])]
    for name in names:
        cells = []
        for s in scales:
            entries = {q["name"]: q for q in docs[s]["queries"] + docs[s].get("extras", [])}
            q = entries.get(name)
            if q is None:
                cells.append("")
            elif isinstance(q["result"], dict) and q["result"].get("timeout"):
                cells.append("timeout")
            else:
                cells.append(f"{q['timings']['p50_ms']}")
        print(f"| {name} | " + " | ".join(cells) + " |")


def w2_table() -> None:
    print("| Scale | Batch | Changes | paraverse as built: visible s (durable s) | incremental prototype: visible s (durable s) | Incremental equals rebuild |")
    print("| --- | --- | --- | --- | --- | --- |")
    for s in SCALES:
        d = _load(s, "w2.json")
        if not d:
            continue
        for b in d["batches"]:
            r, i = b["paraverse_as_built"], b["incremental_prototype"]
            ok = i["counts_match_rebuild"] and i["w3_match_rebuild"]
            print(f"| {s} | {b['pct']}% | {b['changes']:,} | {r['total_visible_s']} ({r['durable_s'] + b['kb_materialize']['seconds']:.1f}) | {i['db_visible_s']} ({i['durable_s']}) | {ok} |")


R2 = ("S1-r2", "S2-r2")


def r2_tables() -> None:
    import statistics

    print("| Scale | W1 servable s | durable s | durable s, saves off | Loader peak GB | Server peak GB (with fork) | RDB MB |")
    print("| --- | --- | --- | --- | --- | --- | --- |")
    for s in R2:
        d, n = _load(s, "w1.json"), _load(s, "w1-save-disabled.json")
        if not d:
            continue
        t, m = d["timings"], d["memory"]
        print(f"| {s} | {t['servable_s']} | {t['durable_s']} | {n['timings']['durable_s'] if n else ''} | {gb(m['loader_peak_rss'])} | {gb(m['server_peak_rss'])} ({gb(m['server_peak_rss_with_children'])}) | {d['size']['rdb_bytes'] / 1e6:.0f} |")
    print()
    docs = {s: _load(s, "w3.json") for s in R2}
    scales = [s for s in R2 if docs[s]]
    print("| W3 v2 | " + " | ".join(f"{s} median p50 ms (max)" for s in scales) + " |")
    print("| --- |" + " --- |" * len(scales))
    cats = ("table", "record", "search", "path", "facet", "neighborhood")
    for cat in cats:
        cells = []
        for s in scales:
            xs = [q["timings"]["p50_ms"] for q in docs[s]["queries"] if q["category"] == cat and not q["name"].endswith("hub") and q["timings"]["p50_ms"] is not None]
            cells.append(f"{statistics.median(xs):.2f} ({max(xs):.1f})")
        print(f"| {cat} (20 sets) | " + " | ".join(cells) + " |")
    for name in ("v2.table.deep_largest_kind", "v2.record.hub", "v2.neighborhood.hub", "v2.path.hub", "v2.facet.hub"):
        cells = []
        for s in scales:
            q = next(q for q in docs[s]["queries"] if q["name"] == name)
            cells.append(f"{q['timings']['p50_ms']}")
        print(f"| {name} | " + " | ".join(cells) + " |")
    print()
    print("| Scale | Batch | Changes | paraverse as built visible s (durable) | incremental visible s (durable) | equal to rebuild | equal to oracle |")
    print("| --- | --- | --- | --- | --- | --- | --- |")
    for s in R2:
        d = _load(s, "w2.json")
        if not d or d.get("round") != 2:
            continue
        for b in d["batches"]:
            r, i = b.get("paraverse_as_built"), b["incremental_prototype"]
            rb = f"{r['total_visible_s']} ({r['durable_s'] + r['kb_build_s']:.1f})" if r else ""
            print(f"| {s} | {b['batch']} | {b['changes']:,} | {rb} | {i['visible_s']} ({i['durable_s']}) | {i.get('counts_match_rebuild', '')} {i.get('w3_match_rebuild', '')} | {i.get('w3_matches_oracle', '')} |")


if __name__ == "__main__":
    r2_tables()
    print()
    print("## W1\n")
    w1_table()
    print("\n## W3 (warm p50)\n")
    w3_table()
    print("\n## W2\n")
    w2_table()
