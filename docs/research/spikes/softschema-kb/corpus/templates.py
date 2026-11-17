"""
S0 templates: every record of the real KB, pre-split into literal text and ID tokens.

A synthetic record is its S0 template with each token rewritten for the target replica
(see `idmap.py`), so formatting, field order and sizes stay byte-identical to S0 apart
from the IDs and links. Tokens are:

- typed IDs that are S0 node IDs, anywhere in the file (frontmatter or body);
- relative Markdown links to other records, such as `](../organizations/avanade.md)`;
- a facet's unprefixed payload `id:` (facets are the only kind that uses one).

Each token carries the replica shift of its (record owner, target) pair, so rendering a
replica is a join with no regex or hashing.
"""

from __future__ import annotations

import json
import posixpath
import re
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from idmap import TYPED_ID_TOKEN, pair_shift, replica_suffix

HUB_OR_NESTED = frozenset({"event", "day", "facet", "term"})
PARENT_ENVELOPE = {"day": "event", "term": "facet"}

_MD_LINK = re.compile(r"\]\(([^)<>\s]+?\.(?:md|yaml))\)")
_FACET_ID = re.compile(r"^  id: (\S+)$", re.MULTILINE)
_ID_TRAILING = "._/@+-"

# A token is (base, tail, shift, sign): the rendered text is base + suffix(replica) + tail,
# where replica = (r + sign * shift) % R, or r itself when shift is 0. sign 0 marks the
# record's own ID, which new delta records renumber. sign 2 (round 2 only) marks a
# reference to a shared entity, which always renders as its replica-0 ID.
SHARED_SIGN = 2
Token = tuple[str, str, int, int]
Segment = str | Token


@dataclass
class Template:
    path: str
    owner: str
    owner_kind: str
    node_ids: list[str]
    segments: list[Segment]
    size: int
    refs: frozenset[str] = frozenset()


@dataclass
class S0:
    root: Path
    nodes: list[dict[str, Any]]
    edges: list[dict[str, Any]]
    search: list[dict[str, Any]]
    templates: dict[str, Template]
    kind: dict[str, str]
    owner_of_path: dict[str, str]
    replicas: int


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def load_s0(root: Path, replicas: int, seed: int, shared: frozenset[str] = frozenset()) -> S0:
    nodes = _read_jsonl(root / "_graph" / "nodes.jsonl")
    edges = _read_jsonl(root / "_graph" / "edges.jsonl")
    search = _read_jsonl(root / "_search" / "documents.jsonl")
    kind = {n["id"]: n["kind"] for n in nodes}
    by_path: dict[str, list[str]] = defaultdict(list)
    for n in nodes:
        by_path[n["path"]].append(n["id"])
    owner_of_path = {}
    for path, ids in by_path.items():
        owners = [i for i in ids if kind[i] not in ("day", "term")]
        if len(owners) != 1:
            raise ValueError(f"{path}: expected one owning node, found {owners}")
        owner_of_path[path] = owners[0]

    templates = {}
    for path, ids in by_path.items():
        owner = owner_of_path[path]
        text = (root / path).read_bytes().decode("utf-8")
        segments = _tokenize(text, path, owner, kind, owner_of_path, replicas, seed, shared)
        templates[path] = Template(
            path=path,
            owner=owner,
            owner_kind=kind[owner],
            node_ids=ids,
            segments=segments,
            size=len(text.encode()),
            refs=frozenset(s[0] for s in segments if isinstance(s, tuple) and not s[1] and s[0] in kind),
        )
    return S0(root, nodes, edges, search, templates, kind, owner_of_path, replicas)


def _shift_token(
    owner: str, target: str, replicas: int, seed: int, shared: frozenset[str] = frozenset()
) -> tuple[int, int]:
    if target == owner:
        return 0, 0
    if target in shared:
        return 0, SHARED_SIGN
    k = pair_shift(owner, target, replicas, seed)
    return k, (1 if owner < target else -1)


def _tokenize(
    text: str,
    path: str,
    owner: str,
    kind: dict[str, str],
    owner_of_path: dict[str, str],
    replicas: int,
    seed: int,
    shared: frozenset[str] = frozenset(),
) -> list[Segment]:
    spans: list[tuple[int, int, Token]] = []
    for m in TYPED_ID_TOKEN.finditer(text):
        candidate = m.group()
        while candidate and candidate not in kind and candidate[-1] in _ID_TRAILING:
            candidate = candidate[:-1]
        if candidate in kind:
            k, sign = _shift_token(owner, candidate, replicas, seed, shared)
            spans.append((m.start(), m.start() + len(candidate), (candidate, "", k, sign)))
    record_dir = posixpath.dirname(path)
    for m in _MD_LINK.finditer(text):
        target = m.group(1)
        resolved = posixpath.normpath(posixpath.join(record_dir, target))
        target_owner = owner_of_path.get(resolved)
        if target_owner is None:
            continue
        stem, ext = posixpath.splitext(target)
        k, sign = _shift_token(owner, target_owner, replicas, seed, shared)
        spans.append((m.start(1), m.end(1), (stem, ext, k, sign)))
    if kind[owner] == "facet":
        unprefixed = owner.split(":", 1)[1]
        for m in _FACET_ID.finditer(text):
            if m.group(1) == unprefixed:
                spans.append((m.start(1), m.end(1), (unprefixed, "", 0, 0)))
                break
    spans.sort()
    segments: list[Segment] = []
    pos = 0
    for start, end, token in spans:
        if start < pos:
            raise ValueError(f"{path}: overlapping tokens at {start}")
        if start > pos:
            segments.append(text[pos:start])
        segments.append(token)
        pos = end
    if pos < len(text):
        segments.append(text[pos:])
    return segments


def render(segments: list[Segment], r: int, replicas: int, own_replica: int | None = None) -> str:
    """
    The record text for replica r. `own_replica` renumbers the record's own ID (for new
    delta records, which are copies of replica r's record under a fresh replica number).
    """
    own = r if own_replica is None else own_replica
    out = []
    for seg in segments:
        if isinstance(seg, str):
            out.append(seg)
            continue
        base, tail, k, sign = seg
        if sign == SHARED_SIGN:
            rr = 0
        elif sign == 0:
            rr = own
        elif k:
            rr = (r + sign * k) % replicas
        else:
            rr = r
        out.append(base + replica_suffix(rr) + tail)
    return "".join(out)


def ref_replica_for(
    owner: str, target: str, r: int, replicas: int, seed: int, shared: frozenset[str] = frozenset()
) -> int:
    k, sign = _shift_token(owner, target, replicas, seed, shared)
    if sign == SHARED_SIGN:
        return 0
    return (r + sign * k) % replicas if k else r
