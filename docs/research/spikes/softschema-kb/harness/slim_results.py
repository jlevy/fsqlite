"""Replace verified W3 answers in result files with digests, keeping every path answer.

A W3 result file holds every query's full answer. When the file matches the oracle,
those answers repeat `harness/expected/<scale>/w3.json`, so this script keeps the
evidence instead of the copy. It compares the file with its expected file through
compare.py, with `--kb` path validation when the KB is available, and only if they
match it:

- replaces each non-path `result` with `compare.digest(result)`: the sha256 and byte
  length of the answer's canonical JSON (sorted keys, compact separators, integral
  floats written as integers), so two digests are equal exactly when compare.py finds
  the answers equal, and compare.py can check a digest against a full answer;
- keeps path results whole (`hops` and `path`, a few IDs each), since several shortest
  paths can exist and a returned path can be checked again only against the KB;
- records `oracle_check`: the expected file, its sha256, the KB the paths were checked
  against, and compare.py's verdict.

Timings, plans, and parameters stay. A file that does not match the oracle, such as a
deliberate ablation, keeps its full answers.

    python harness/slim_results.py [--corpora DIR] [--applied DIR] results/fsqlite ...

`--corpora` (default `$KB_CORPORA`) holds `<scale>/kb`; S0 falls back to the vendored KB.
`--applied` holds `delta2.py --apply` outputs named `<scale>-<batch>` (for example
`S1-r2-p05`), the KBs for files measured after a batch.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXPECTED = HERE / "expected"
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "corpus"))

from compare import InputError, KbGraph, compare_files, digest  # noqa: E402
from prereq import S0_KB  # noqa: E402

_AFTER = re.compile(r"after-(p\d+)")


def state_for(path: Path) -> str | None:
    """The KB state a result file was measured on: its scale, or `<scale>-<batch>` after one."""
    scale = path.parent.name
    if "after" not in path.name:
        return scale
    match = _AFTER.search(path.name)
    return f"{scale}-{match.group(1)}" if match else None


def expected_for(path: Path) -> Path | None:
    """The oracle file for a result file, from its scale directory and name."""
    state = state_for(path)
    candidate = EXPECTED / state / "w3.json" if state else None
    return candidate if candidate and candidate.is_file() else None


def kb_for(state: str, corpora: Path | None, applied: Path | None) -> tuple[Path | None, str | None]:
    """The KB to validate paths against, and how `oracle_check` names it (no local paths)."""
    if re.search(r"-p\d+$", state):
        kb = applied / state if applied else None
        return (kb, f"delta2.py --apply output for {state}") if kb and (kb / "_graph").is_dir() else (None, None)
    kb = corpora / state / "kb" if corpora else None
    if kb and (kb / "_graph").is_dir():
        return kb, f"$KB_CORPORA/{state}/kb"
    if state == "S0" and (S0_KB / "_graph").is_dir():
        return S0_KB, "attic/paraverse/vendor/universe2026-md/kb"
    return None, None


class Slimmer:
    def __init__(self, corpora: Path | None, applied: Path | None):
        self.corpora, self.applied = corpora, applied
        self.graphs: dict[Path, KbGraph] = {}

    def graph(self, kb: Path) -> KbGraph:
        if kb not in self.graphs:
            self.graphs = {kb: KbGraph(kb)}  # one at a time: an S2 graph is large
        return self.graphs[kb]

    def slim(self, path: Path) -> str:
        doc = json.loads(path.read_text(encoding="utf-8"))
        queries = doc.get("queries")
        if not isinstance(queries, list) or "oracle_check" in doc:
            return "skip (no answer payloads, or already slimmed)"
        if not any(isinstance(q, dict) and "result" in q for q in queries):
            return "skip (no answer payloads)"
        expected = expected_for(path)
        if expected is None:
            return "skip (no expected file)"
        kb, kb_name = kb_for(state_for(path) or "", self.corpora, self.applied)
        try:
            ok, _, tally = compare_files(expected, path, kb, 5, self.graph(kb) if kb else None)
        except InputError as exc:
            return f"kept full answers ({exc})"
        outcome = f"{'MATCH' if ok else 'MISMATCH'}: {tally['ok']} ok, {tally['differ'] + tally['missing']} differ"
        if not ok:
            return f"kept full answers ({outcome})"
        for query in queries:
            if isinstance(query, dict) and "result" in query and query.get("category") != "path":
                query["result"] = digest(query["result"])
        doc["oracle_check"] = {
            "expected": expected.relative_to(EXPECTED.parent.parent).as_posix(),
            "expected_sha256": hashlib.sha256(expected.read_bytes()).hexdigest(),
            "paths_checked_against": kb_name,
            "outcome": outcome,
            "answers": (
                "non-path answers replaced by compare.digest (sha256 of canonical JSON); "
                "path answers kept; see harness/slim_results.py"
            ),
        }
        path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        return f"slimmed ({outcome}{', paths checked' if kb else ', paths not checked: no KB'})"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("roots", nargs="+", type=Path)
    env = os.environ.get("KB_CORPORA")
    ap.add_argument("--corpora", type=Path, default=Path(env) if env else None)
    ap.add_argument("--applied", type=Path)
    args = ap.parse_args(argv)
    slimmer = Slimmer(args.corpora, args.applied)
    paths = sorted(p for root in args.roots for p in root.rglob("w3*.json") if "plan" not in p.name)
    # Group by KB state, so each KB graph is loaded once.
    for path in sorted(paths, key=lambda p: (state_for(p) or "", p)):
        print(f"{path}: {slimmer.slim(path)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
