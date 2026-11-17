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


if __name__ == "__main__":
    print("## W1\n")
    w1_table()
    print("\n## W3 (warm p50)\n")
    w3_table()
    print("\n## W2\n")
    w2_table()
