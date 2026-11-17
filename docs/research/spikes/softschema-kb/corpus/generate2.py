"""
Round-2 synthetic KBs: like `generate.py`, plus growing hubs, perturbed values and text,
and an explicit origin record on every edge.

    python generate2.py --scale S1 --out $KB_CORPORA/S1-r2 [--workers 4]

Changes from round 1 (round-1 output is unchanged; `generate.py` still writes it):

- **Shared entities (C8).** Every software record, the 25 organizations with the highest
  S0 degree, and the topic taxonomy (the four `facet:topic*` facets and their 127 terms)
  exist once, under their S0 IDs and paths, in replica 0. Every replica's references to
  them resolve to that one copy, so their degrees grow with the scale.
- **Origins (C21).** Each edge row carries `origin`, the KB path of the record it is
  derived from: the source's record if that record names the target, else the
  target's record if it names the source, else the source's record. An edge whose
  origin record is shared is written once; every other edge once per replica.
- **Perturbation (C9), replicas 1 and up, seeded by (seed, path, replica):**
  - every session's slot times shift by a multiple of 5 minutes within one hour (never
    across a date), and the `start` of its `scheduled_on` and `held_in` edges with them;
  - every repository's `stars` is scaled by a factor in [0.5, 2.0];
  - 30% of sessions, people, organizations and repositories have a quarter of the words
    of their title, abstract, bio or description replaced by S0 vocabulary words. A
    changed session title also changes the frontmatter `title`, the node's `name` and
    its search document. These records are re-serialized with PyYAML.
- **Manifest.** Adds the shared set, the node, edge, record-file and byte counts, and the
  max and 99th percentile degree per kind.
"""

from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import os
import random
import re
import shutil
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from idmap import DEFAULT_SEED, SCALES, own_id, own_path  # noqa: E402
from templates import S0, load_s0, ref_replica_for, render  # noqa: E402
from yamlio import write_doc  # noqa: E402

DEFAULT_S0 = HERE.parents[4] / "attic" / "paraverse" / "vendor" / "universe2026-md" / "kb"
ROOT_FILES = ("README.md", "faq.yaml", "media.yaml")
ROUND = "r2"
SHARED_TOP_ORGS = 25
SHARED_FACET_PREFIX = "facet:topic"
TEXT_SHARE = 0.3
WORD_SHARE = 0.25
TEXT_FIELDS = {
    "session": ("title", "abstract"),
    "person": ("bio",),
    "organization": ("description",),
    "repository": ("description",),
}
SLOT_TIME = re.compile(
    r"^(\s+(?:- )?(?:start|end): '?)(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})('?)$", re.MULTILINE
)
STARS = re.compile(r"^(  stars: )(\d+)$", re.MULTILINE)
WORD = re.compile(r"[A-Za-z]{4,}")
SHIFTED_RELATIONS = ("scheduled_on", "held_in")


def dumps(row: dict[str, Any]) -> str:
    return json.dumps(row, ensure_ascii=False)


## Shared set, origins, vocabulary


def shared_entities(s0: S0) -> frozenset[str]:
    degree: Counter[str] = Counter()
    for e in s0.edges:
        degree[e["source"]] += 1
        degree[e["target"]] += 1
    orgs = sorted((i for i, k in s0.kind.items() if k == "organization"), key=lambda i: (-degree[i], i))
    shared = {i for i, k in s0.kind.items() if k == "software"} | set(orgs[:SHARED_TOP_ORGS])
    facet_paths = {s0.templates_by_owner[i].path for i, k in s0.kind.items() if k == "facet" and i.startswith(SHARED_FACET_PREFIX)}
    shared |= {n["id"] for n in s0.nodes if n["path"] in facet_paths}
    return frozenset(shared)


def edge_origins(s0: S0, shared: frozenset[str]) -> list[str]:
    """
    The origin record path of each S0 edge (see the module docstring). When both records
    name each other and only the source is shared, the target's record is the origin, so
    the edge is written once per replica that holds the reference.
    """
    node_path = {n["id"]: n["path"] for n in s0.nodes}
    out = []
    for e in s0.edges:
        s, t = e["source"], e["target"]
        ps, pt = node_path[s], node_path[t]
        s_has, t_has = t in s0.templates[ps].refs, s in s0.templates[pt].refs
        if s_has and t_has and s in shared and t not in shared:
            out.append(pt)
        elif s_has:
            out.append(ps)
        elif t_has:
            out.append(pt)
        else:
            out.append(ps)
    return out


def vocabulary(s0: S0) -> list[str]:
    """
    Lower-case ASCII words of 4 to 12 letters that occur at least 3 times in the S0 values
    of the perturbed fields (titles, abstracts, bios, descriptions).
    """
    from yamlio import _FRONTMATTER, _PortableScalarLoader
    import yaml

    counts: Counter[str] = Counter()
    for path, tpl in s0.templates.items():
        fields = TEXT_FIELDS.get(tpl.owner_kind)
        if not fields:
            continue
        text = (s0.root / path).read_bytes().decode("utf-8")
        match = _FRONTMATTER.match(text)
        data = yaml.load(match.group(1) if match else text, Loader=_PortableScalarLoader)
        payload = data.get(data.get("softschema", {}).get("envelope"), {})
        for field in fields:
            if isinstance(payload.get(field), str):
                counts.update(w.lower() for w in WORD.findall(payload[field]) if len(w) <= 12)
    return sorted(w for w, c in counts.items() if c >= 3)


## Perturbation


def _rng(seed: int, *parts: Any) -> random.Random:
    return random.Random(":".join(str(p) for p in (seed, ROUND, *parts)))


def slot_offset(text: str, path: str, r: int, seed: int) -> timedelta:
    minutes = 5 * _rng(seed, "start", path, r).randint(-12, 12)
    delta = timedelta(minutes=minutes)
    for m in SLOT_TIME.finditer(text):
        ts = datetime.fromisoformat(m.group(2))
        if (ts + delta).date() != ts.date():
            return timedelta(0)
    return delta


def shift_ts(value: str, delta: timedelta) -> str:
    return (datetime.fromisoformat(value) + delta).isoformat()


def perturb_words(text: str, rng: random.Random, vocab: list[str]) -> str:
    def sub(m: re.Match[str]) -> str:
        word = m.group()
        if rng.random() >= WORD_SHARE:
            return word
        new = rng.choice(vocab)
        if word.isupper():
            return new.upper()
        return new.capitalize() if word[0].isupper() else new

    return WORD.sub(sub, text)


def perturb(text: str, tpl: Any, r: int, seed: int, vocab: list[str]) -> tuple[str, str | None, timedelta]:
    """Replica r's perturbed record text, its new display title if any, and its slot shift."""
    delta = timedelta(0)
    if tpl.owner_kind == "session":
        delta = slot_offset(text, tpl.path, r, seed)
        if delta:
            text = SLOT_TIME.sub(lambda m: m.group(1) + shift_ts(m.group(2), delta) + m.group(3), text)
    elif tpl.owner_kind == "repository":
        factor = _rng(seed, "stars", tpl.path, r).uniform(0.5, 2.0)
        text = STARS.sub(lambda m: m.group(1) + str(max(0, round(int(m.group(2)) * factor))), text, count=1)
    new_title = None
    fields = TEXT_FIELDS.get(tpl.owner_kind)
    rng = _rng(seed, "text", tpl.path, r)
    if fields and rng.random() < TEXT_SHARE:
        from yamlio import _FRONTMATTER, _PortableScalarLoader
        import yaml

        match = _FRONTMATTER.match(text)
        data = yaml.load(match.group(1) if match else text, Loader=_PortableScalarLoader)
        payload = data[data["softschema"]["envelope"]]
        for field in fields:
            if isinstance(payload.get(field), str):
                payload[field] = perturb_words(payload[field], rng, vocab)
        if "title" in fields and isinstance(payload.get("title"), str):
            new_title = payload["title"]
            if "title" in data:
                data["title"] = new_title
        text = write_doc(data, text[match.end() :] if match else "", match is not None).decode()
    return text, new_title, delta


## Rendering


_S0: S0 | None = None
_CTX: dict[str, Any] = {}


def _init(s0: S0, ctx: dict[str, Any]) -> None:
    global _S0, _CTX
    _S0, _CTX = s0, ctx


def render_replica(r: int) -> dict[str, Any]:
    s0, ctx = _S0, _CTX
    assert s0 is not None
    out, seed, shared, vocab = ctx["out"], ctx["seed"], ctx["shared"], ctx["vocab"]
    replicas = s0.replicas
    kb = out / "kb"
    parts = kb / "_graph" / ".parts"
    made: set[Path] = set()
    nbytes = files = 0
    names: dict[str, str] = {}
    shifts: dict[str, timedelta] = {}

    def ref(o: str, x: str) -> str:
        return x if x in shared else own_id(x, ref_replica_for(o, x, r, replicas, seed, shared))

    for path, tpl in s0.templates.items():
        if tpl.owner in shared and r > 0:
            continue
        text = render(tpl.segments, r, replicas)
        if r > 0:
            text, title, delta = perturb(text, tpl, r, seed, vocab)
            if title is not None:
                names[tpl.owner] = title
            if delta:
                shifts[tpl.owner] = delta
        dest = kb / own_path(path, r if tpl.owner not in shared else 0)
        if dest.parent not in made:
            dest.parent.mkdir(parents=True, exist_ok=True)
            made.add(dest.parent)
        data = text.encode()
        dest.write_bytes(data)
        nbytes += len(data)
        files += 1

    with (parts / f"nodes.{r:05d}.jsonl").open("w", encoding="utf-8") as fh:
        for n in s0.nodes:
            if n["id"] in shared:
                if r == 0:
                    fh.write(dumps(n) + "\n")
                continue
            row = {**n, "id": own_id(n["id"], r), "path": own_path(n["path"], r)}
            if n["id"] in names:
                row["name"] = names[n["id"]]
            fh.write(dumps(row) + "\n")
    with (parts / f"edges.{r:05d}.jsonl").open("w", encoding="utf-8") as fh:
        for e, origin in zip(s0.edges, ctx["origins"], strict=True):
            o = s0.owner_of_path[origin]
            if o in shared and r > 0:
                continue
            row = {"source": ref(o, e["source"]), "relation": e["relation"], "target": ref(o, e["target"])}
            for key, value in e.items():
                if key not in ("source", "relation", "target"):
                    row[key] = value
            delta = shifts.get(e["source"])
            if delta and e["relation"] in SHIFTED_RELATIONS and isinstance(row.get("start"), str):
                row["start"] = shift_ts(row["start"], delta)
            row["origin"] = origin if o in shared else own_path(origin, r)
            fh.write(dumps(row) + "\n")
    with (parts / f"search.{r:05d}.jsonl").open("w", encoding="utf-8") as fh:
        for d in s0.search:
            if d["id"] in s0.kind:
                if d["id"] in shared:
                    if r == 0:
                        fh.write(dumps(d) + "\n")
                    continue
                row = {**d, "id": own_id(d["id"], r), "path": own_path(d["path"], r)}
                if d["id"] in names:
                    row["title"] = names[d["id"]]
            elif r == 0:
                row = d
            else:
                continue
            fh.write(dumps(row) + "\n")
    return {"replica": r, "record_bytes": nbytes, "records": files, "retitled": len(names)}


def _concat(parts: list[Path], dest: Path) -> None:
    with dest.open("wb") as fh:
        for part in parts:
            with part.open("rb") as src:
                shutil.copyfileobj(src, fh, 1 << 20)
            part.unlink()


def degree_stats(kb: Path) -> tuple[dict[str, Any], Counter[str], Counter[str]]:
    kind: dict[str, str] = {}
    node_counts: Counter[str] = Counter()
    with (kb / "_graph" / "nodes.jsonl").open(encoding="utf-8") as fh:
        for line in fh:
            row = json.loads(line)
            kind[row["id"]] = row["kind"]
            node_counts[row["kind"]] += 1
    degree: Counter[str] = Counter()
    edge_counts: Counter[str] = Counter()
    with (kb / "_graph" / "edges.jsonl").open(encoding="utf-8") as fh:
        for line in fh:
            row = json.loads(line)
            degree[row["source"]] += 1
            degree[row["target"]] += 1
            edge_counts[row["relation"]] += 1
    by_kind: dict[str, list[tuple[int, str]]] = defaultdict(list)
    for nid, k in kind.items():
        by_kind[k].append((degree[nid], nid))
    stats: dict[str, Any] = {}
    for k, xs in sorted(by_kind.items()):
        xs.sort()
        top = xs[-1]
        stats[k] = {"max": top[0], "max_node": top[1], "p99": xs[min(len(xs) - 1, int(0.99 * len(xs)))][0]}
    every = sorted(degree[n] for n in kind)
    stats["_all"] = {"max": every[-1], "p99": every[min(len(every) - 1, int(0.99 * len(every)))]}
    return stats, node_counts, edge_counts


def generate(scale: str, out: Path, s0_root: Path, seed: int, workers: int) -> dict[str, Any]:
    replicas = SCALES[scale]
    started = time.monotonic()
    s0 = load_s0(s0_root, replicas, seed)
    s0.templates_by_owner = {t.owner: t for t in s0.templates.values()}  # type: ignore[attr-defined]
    shared = shared_entities(s0)
    s0 = load_s0(s0_root, replicas, seed, shared)
    s0.templates_by_owner = {t.owner: t for t in s0.templates.values()}  # type: ignore[attr-defined]
    ctx = {"out": out, "seed": seed, "shared": shared, "vocab": vocabulary(s0), "origins": edge_origins(s0, shared)}
    kb = out / "kb"
    if kb.exists():
        shutil.rmtree(kb)
    (kb / "_graph" / ".parts").mkdir(parents=True)
    (kb / "_search").mkdir()
    shutil.copytree(s0_root / "_schemas", kb / "_schemas")
    shutil.copy2(s0_root / "_graph" / "coverage.json", kb / "_graph" / "coverage.json")
    for name in ROOT_FILES:
        if (s0_root / name).is_file():
            shutil.copy2(s0_root / name, kb / name)
    with mp.get_context("fork").Pool(workers, initializer=_init, initargs=(s0, ctx)) as pool:
        reports = list(pool.imap_unordered(render_replica, range(replicas)))
    parts = kb / "_graph" / ".parts"
    _concat(sorted(parts.glob("nodes.*.jsonl")), kb / "_graph" / "nodes.jsonl")
    _concat(sorted(parts.glob("edges.*.jsonl")), kb / "_graph" / "edges.jsonl")
    _concat(sorted(parts.glob("search.*.jsonl")), kb / "_search" / "documents.jsonl")
    parts.rmdir()
    degrees, node_counts, edge_counts = degree_stats(kb)
    stats = {
        "nodes": dict(sorted(node_counts.items())),
        "edges": dict(sorted(edge_counts.items())),
        "node_total": sum(node_counts.values()),
        "edge_total": sum(edge_counts.values()),
    }
    (kb / "_graph" / "stats.json").write_text(json.dumps(stats, indent=2) + "\n")
    files = [p for p in kb.rglob("*") if p.is_file()]
    record_files = sum(r["records"] for r in reports) + sum(1 for n in ("faq.yaml", "media.yaml") if (kb / n).is_file())
    manifest = {
        "scale": f"{scale}-{ROUND}",
        "round": 2,
        "seed": seed,
        "seed_namespace": ROUND,
        "replicas": replicas,
        "source": str(s0_root),
        "nodes": stats["node_total"],
        "edges": stats["edge_total"],
        "record_files": record_files,
        "record_bytes": sum(r["record_bytes"] for r in reports),
        "files": len(files),
        "bytes": sum(p.stat().st_size for p in files),
        "shared": {
            "count": len(shared),
            "rule": f"all software; top {SHARED_TOP_ORGS} organizations by S0 degree; facets {SHARED_FACET_PREFIX}* and their terms",
            "by_kind": dict(sorted(Counter(s0.kind[i] for i in shared).items())),
        },
        "perturbation": {
            "session_slot_shift": "5-minute steps within +-60 minutes, never across a date",
            "repository_stars_factor": [0.5, 2.0],
            "text_share": TEXT_SHARE,
            "word_share": WORD_SHARE,
            "retitled_sessions": sum(r["retitled"] for r in reports),
            "vocabulary_words": len(ctx["vocab"]),
        },
        "degree": degrees,
        "workers": workers,
        "seconds": round(time.monotonic() - started, 2),
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--scale", required=True, choices=sorted(SCALES))
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--s0", type=Path, default=DEFAULT_S0)
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--workers", type=int, default=min(4, os.cpu_count() or 1))
    args = ap.parse_args()
    m = generate(args.scale, args.out, args.s0, args.seed, args.workers)
    print(json.dumps({k: m[k] for k in ("scale", "nodes", "edges", "record_files", "record_bytes", "bytes", "seconds")}))
    print(json.dumps({k: m["degree"][k] for k in ("_all", "software", "organization", "term", "person")}))


if __name__ == "__main__":
    main()
