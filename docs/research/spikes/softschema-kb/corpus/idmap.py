"""
Deterministic ID mapping for synthetic softschema KB corpora.

A synthetic corpus at scale S is R replicas of the S0 KB. Replica 0 keeps every S0 ID
and path unchanged; replica r >= 1 appends `-r<r>` to the last segment of each typed ID
and to each record's file stem:

    person:aaron-reich        -> person:aaron-reich-r7
    acct:bluesky/adamhjk.me   -> acct:bluesky/adamhjk.me-r7
    people/aaron-reich.md     -> people/aaron-reich-r7.md

Replicas are cross-linked so the graph is connected rather than R disjoint copies. For
an unordered pair of S0 entities {A, B} whose kinds form a "rewirable" pair (person,
organization and session, which reference each other directly in both payloads and
edges), a seeded hash decides whether the pair is shifted. A shifted pair links
A_r with B_{(r + k) mod R} (A < B by ID string), so B's replica sees A_{(r - k) mod R}.
Each copy of an entity still has exactly the S0 degree, so the degree distribution is
preserved, and both sides of every reference agree.

This module has no dependencies, so the harness, the generator and any backend can
import it to resolve the synthetic IDs that queries.json names.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import PurePosixPath

# Replica counts per scale, chosen so node counts land near the WORKLOAD.md targets
# (S0 has 5,407 nodes).
SCALES: dict[str, int] = {"S0": 1, "S1": 9, "S2": 46, "S3": 185}

DEFAULT_SEED = 20261117

# Kinds whose pairs may be rewired across replicas. Every edge between these kinds is
# stored directly in at least one endpoint's payload (checked on S0), so shifting the
# pair keeps payloads and edges consistent. Hubs (event, day, facet, term) and kinds
# whose edges are derived through a third record (profile, accounts, repositories)
# always stay within their replica.
REWIRABLE_KINDS = frozenset({"person", "organization", "session"})

# Probability that an eligible pair is shifted to another replica.
REWIRE_PROBABILITY = 0.2

PREFIX_KINDS: dict[str, str] = {
    "acct": "social_account",
    "day": "day",
    "event": "event",
    "experience": "experience",
    "facet": "facet",
    "gh": "github_account",
    "org": "organization",
    "page": "page",
    "person": "person",
    "pkg": "package",
    "profile": "profile",
    "repo": "repository",
    "room": "room",
    "session": "session",
    "site": "website",
    "software": "software",
    "term": "term",
    "venue": "venue",
}

# Candidate typed IDs inside record text. Only candidates that are S0 node IDs are
# rewritten, so free text that merely looks like an ID is left alone.
TYPED_ID_TOKEN = re.compile(
    r"(?<![A-Za-z0-9_])(?:" + "|".join(sorted(PREFIX_KINDS, key=len, reverse=True)) + r"):"
    r"[a-z0-9][a-z0-9._/@+-]*"
)


def replica_suffix(r: int) -> str:
    return "" if r == 0 else f"-r{r}"


def own_id(s0_id: str, r: int) -> str:
    """The replica-r copy of an S0 node ID (or of an unprefixed payload ID)."""
    return s0_id + replica_suffix(r)


def own_path(s0_path: str, r: int) -> str:
    """The replica-r copy of an S0 record path, relative to the KB root."""
    if r == 0:
        return s0_path
    p = PurePosixPath(s0_path)
    return str(p.with_name(f"{p.stem}{replica_suffix(r)}{p.suffix}"))


def kind_of(typed_id: str) -> str | None:
    return PREFIX_KINDS.get(typed_id.split(":", 1)[0])


def _unit_hash(seed: int, *parts: str) -> float:
    h = hashlib.blake2b(digest_size=8, key=seed.to_bytes(8, "big"))
    for part in parts:
        h.update(part.encode())
        h.update(b"\x00")
    return int.from_bytes(h.digest(), "big") / 2**64


def pair_shift(a: str, b: str, replicas: int, seed: int = DEFAULT_SEED) -> int:
    """
    The replica shift k for the S0 pair {a, b}: 0 when the pair stays aligned, else
    1..R-1. Symmetric in a and b.
    """
    if replicas <= 1 or a == b:
        return 0
    if kind_of(a) not in REWIRABLE_KINDS or kind_of(b) not in REWIRABLE_KINDS:
        return 0
    lo, hi = (a, b) if a < b else (b, a)
    if _unit_hash(seed, "rewire", lo, hi) >= REWIRE_PROBABILITY:
        return 0
    return 1 + int(_unit_hash(seed, "shift", lo, hi) * (replicas - 1))


def ref_replica(src: str, tgt: str, r: int, replicas: int, seed: int = DEFAULT_SEED) -> int:
    """The replica of `tgt` that the replica-r copy of `src` refers to."""
    k = pair_shift(src, tgt, replicas, seed)
    if k == 0:
        return r
    return (r + k) % replicas if src < tgt else (r - k) % replicas


def ref_id(src: str, tgt: str, r: int, replicas: int, seed: int = DEFAULT_SEED) -> str:
    """The ID that the replica-r copy of `src` uses for its reference to S0 `tgt`."""
    return own_id(tgt, ref_replica(src, tgt, r, replicas, seed))


def selection_replica(scale: str) -> int:
    """
    The replica whose copies of the S0 query parameters a scale's W3 queries use: the
    middle replica, so synthetic queries never only touch the S0-identical replica 0.
    """
    return SCALES[scale] // 2


def scale_id(s0_id: str, scale: str) -> str:
    """The synthetic ID that stands for S0 entity `s0_id` in a scale's W3 queries."""
    return own_id(s0_id, selection_replica(scale))


## Tests


def test_mapping_is_symmetric_and_degree_preserving():
    replicas = 9
    a, b = "org:github", "person:aaron-reich"
    for r in range(replicas):
        rb = ref_replica(a, b, r, replicas)
        assert ref_replica(b, a, rb, replicas) == r
    assert own_path("accounts/bluesky/adamhjk.me.yaml", 3) == "accounts/bluesky/adamhjk.me-r3.yaml"
    assert own_id("day:2026-10-28", 0) == "day:2026-10-28"
    assert pair_shift("event:x", "person:y", replicas) == 0
