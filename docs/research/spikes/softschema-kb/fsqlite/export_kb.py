"""
W5 export: write a published fsqlite snapshot back to the KB layout, then compare.

The snapshot is read with Python's standard `sqlite3` module and no fsqlite code, which
also shows that fsqlite artifacts are plain SQLite files. Records are rebuilt from the
`doc` row (frontmatter keys in order, Markdown body) plus the owning entity's payload,
and written with the same YAML style as the universe2026-md pipeline.

Usage:
  export_kb.py <snapshot.sqlite | store-dir> <out_dir> [--jobs N] [--compare <src_kb>]

Prints one JSON report on stdout: export timings and, with --compare, the fidelity check
(parsed equality of every record and graph line, and byte-level differences).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Any

import yaml

_FRONTMATTER = re.compile(r"\A---\n(.*?)\n---[ \t]*(?:\n|\Z)", re.DOTALL)
_TIMESTAMP_TAG = "tag:yaml.org,2002:timestamp"
_BaseLoader: type[yaml.SafeLoader] = getattr(yaml, "CSafeLoader", yaml.SafeLoader)


class PortableLoader(_BaseLoader):
    """Keep date- and timestamp-shaped scalars as strings, as softschema does."""


PortableLoader.yaml_implicit_resolvers = {
    first: [(tag, rx) for tag, rx in resolvers if tag != _TIMESTAMP_TAG]
    for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}


class KbDumper(yaml.SafeDumper):
    """The universe2026-md pipeline's artifact style: no aliases, literal multi-line text."""

    def ignore_aliases(self, data: Any) -> bool:
        return True


_NUMERIC_LOOKING = re.compile(r"^[-+]?[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?$")


def _str_representer(dumper: yaml.SafeDumper, value: str) -> yaml.ScalarNode:
    style = "|" if "\n" in value else "'" if _NUMERIC_LOOKING.match(value) else None
    return dumper.represent_scalar("tag:yaml.org,2002:str", value, style=style)


KbDumper.add_representer(str, _str_representer)


def to_yaml(data: Any) -> str:
    return yaml.dump(data, Dumper=KbDumper, sort_keys=False, allow_unicode=True, width=100)


def to_schema_yaml(data: Any) -> str:
    """The compiled schemas use the same style without line wrapping."""
    return yaml.dump(data, Dumper=KbDumper, sort_keys=False, allow_unicode=True, width=float("inf"))


def snapshot_path(arg: str) -> Path:
    """A snapshot file, or the file a store directory's `current` pointer names."""
    path = Path(arg)
    if path.is_dir():
        version = int((path / "current").read_text().strip())
        return path / "snapshots" / f"{version:012d}.fsqlite.sqlite"
    return path


def connect(path: Path) -> sqlite3.Connection:
    # Published snapshots never change, so `immutable=1` skips locking entirely.
    return sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True)


def render_docs(db_path: str, paths: list[str]) -> list[tuple[str, str]]:
    db = connect(Path(db_path))
    out = []
    for path in paths:
        fmt, envelope, owner, head, body, payload = db.execute(
            """
            SELECT d.format, d.envelope, d.owner, d.head, d.body, e.payload
            FROM doc d LEFT JOIN entity e ON e.id = d.owner
            WHERE d.path = ?
            """,
            (path,),
        ).fetchone()
        data = json.loads(head)
        if owner is not None:
            data[envelope] = json.loads(payload)
        text = to_yaml(data)
        out.append((path, f"---\n{text}---\n{body or ''}" if fmt == "md" else text))
    db.close()
    return out


def export(src: Path, out: Path, jobs: int) -> dict[str, Any]:
    started = time.monotonic()
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    db = connect(src)
    written = 0

    def write(rel: str, text: str) -> None:
        nonlocal written
        target = out / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(text.encode("utf-8"))
        written += 1

    for rel, text in db.execute("SELECT path, text FROM kb_file ORDER BY path"):
        write(rel, text)
    for (rel,) in db.execute("SELECT DISTINCT path FROM kb_line ORDER BY path").fetchall():
        target = out / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(target, "w", encoding="utf-8", newline="") as f:
            for (text,) in db.execute("SELECT text FROM kb_line WHERE path = ? ORDER BY n", (rel,)):
                f.write(text)
        written += 1
    for rel, schema in db.execute("SELECT file, schema FROM kind_schema ORDER BY file"):
        write(rel, to_schema_yaml(json.loads(schema)))

    graph = out / "_graph"
    graph.mkdir(exist_ok=True)
    with open(graph / "nodes.jsonl", "w", encoding="utf-8", newline="") as f:
        for id_, kind, name, path in db.execute(
            "SELECT id, kind, name, path FROM entity ORDER BY id"
        ):
            row = {"id": id_, "kind": kind, "name": name, "path": path}
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    with open(graph / "edges.jsonl", "w", encoding="utf-8", newline="") as f:
        for source, relation, target, props in db.execute(
            "SELECT source, relation, target, props FROM edge ORDER BY source, relation, target, ord"
        ):
            row = {"source": source, "relation": relation, "target": target}
            if props is not None:
                row.update(json.loads(props))
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    written += 2
    graph_seconds = time.monotonic() - started

    paths = [r[0] for r in db.execute("SELECT path FROM doc ORDER BY path")]
    db.close()
    chunk = max(1, len(paths) // (jobs * 8) + 1)
    chunks = [paths[i : i + chunk] for i in range(0, len(paths), chunk)]
    if jobs > 1 and len(chunks) > 1:
        with ProcessPoolExecutor(max_workers=jobs) as pool:
            for rendered in pool.map(render_docs, [str(src)] * len(chunks), chunks):
                for rel, text in rendered:
                    write(rel, text)
    else:
        for c in chunks:
            for rel, text in render_docs(str(src), c):
                write(rel, text)
    return {
        "snapshot": str(src),
        "files_written": written,
        "graph_and_files_seconds": round(graph_seconds, 3),
        "seconds": round(time.monotonic() - started, 3),
        "jobs": jobs,
    }


def parse_doc(text: str, rel: str) -> Any:
    """The parsed form a record is compared by: its YAML data plus any Markdown body."""
    if rel.endswith(".jsonl"):
        return [json.loads(line) for line in text.split("\n") if line.strip()]
    if rel.endswith(".json"):
        return json.loads(text)
    if rel.endswith(".md"):
        match = _FRONTMATTER.match(text)
        if not match:
            return text
        return {"front": yaml.load(match.group(1), Loader=PortableLoader), "body": text[match.end() :]}
    if rel.endswith((".yaml", ".yml")):
        return yaml.load(text, Loader=PortableLoader)
    return text


def list_files(root: Path) -> set[str]:
    return {
        os.path.relpath(os.path.join(d, n), root).replace(os.sep, "/")
        for d, _, names in os.walk(root)
        for n in names
    }


def compare_chunk(src: str, out: str, rels: list[str]) -> list[dict[str, Any]]:
    results = []
    for rel in rels:
        a = (Path(src) / rel).read_bytes()
        b = (Path(out) / rel).read_bytes()
        if a == b:
            results.append({"path": rel, "bytes_equal": True, "parsed_equal": True})
            continue
        ta, tb = a.decode("utf-8"), b.decode("utf-8")
        parsed_equal = parse_doc(ta, rel) == parse_doc(tb, rel)
        la, lb = ta.split("\n"), tb.split("\n")
        changed = sum(1 for x, y in zip(la, lb) if x != y) + abs(len(la) - len(lb))
        results.append(
            {
                "path": rel,
                "bytes_equal": False,
                "parsed_equal": parsed_equal,
                "byte_delta": len(b) - len(a),
                "lines_changed": changed,
            }
        )
    return results


def compare(src: Path, out: Path, jobs: int) -> dict[str, Any]:
    started = time.monotonic()
    a, b = list_files(src), list_files(out)
    common = sorted(a & b)
    chunk = max(1, len(common) // (jobs * 8) + 1)
    chunks = [common[i : i + chunk] for i in range(0, len(common), chunk)]
    rows: list[dict[str, Any]] = []
    with ProcessPoolExecutor(max_workers=jobs) as pool:
        for part in pool.map(compare_chunk, [str(src)] * len(chunks), [str(out)] * len(chunks), chunks):
            rows.extend(part)
    differing = [r for r in rows if not r["bytes_equal"]]
    by_area: dict[str, dict[str, int]] = {}
    for r in rows:
        area = r["path"].split("/", 1)[0] if "/" in r["path"] else "(root)"
        stats = by_area.setdefault(area, {"files": 0, "bytes_equal": 0, "parsed_equal": 0})
        stats["files"] += 1
        stats["bytes_equal"] += r["bytes_equal"]
        stats["parsed_equal"] += r["parsed_equal"]
    return {
        "source_files": len(a),
        "exported_files": len(b),
        "missing": sorted(a - b)[:20],
        "missing_count": len(a - b),
        "extra": sorted(b - a)[:20],
        "extra_count": len(b - a),
        "compared": len(rows),
        "bytes_equal": sum(r["bytes_equal"] for r in rows),
        "parsed_equal": sum(r["parsed_equal"] for r in rows),
        "parsed_different": [r["path"] for r in rows if not r["parsed_equal"]][:20],
        "byte_differences": sorted(differing, key=lambda r: r["path"])[:20],
        "byte_different_count": len(differing),
        "by_area": by_area,
        "seconds": round(time.monotonic() - started, 3),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("snapshot")
    ap.add_argument("out")
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 1)
    ap.add_argument("--compare")
    args = ap.parse_args()
    report: dict[str, Any] = {"export": export(snapshot_path(args.snapshot), Path(args.out), args.jobs)}
    if args.compare:
        report["compare"] = compare(Path(args.compare), Path(args.out), args.jobs)
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
