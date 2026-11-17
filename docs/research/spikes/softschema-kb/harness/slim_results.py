"""Replace verified W3 answer payloads in result files with digests.

A W3 result file holds every query's full answer. When the file matches the oracle,
those answers repeat `harness/expected/<scale>/w3.json` exactly, so this script keeps
the evidence instead of the copy: it runs compare.py against the matching expected
file, records the outcome in the file as `oracle_check`, and replaces each query's
`result` with `{"sha256": ..., "json_bytes": ...}` over its canonical JSON (sorted
keys, compact separators). Timings, plans, and parameters stay. A file that does not
match the oracle, such as a deliberate ablation, keeps its full answers.

    python harness/slim_results.py results/fsqlite results/falkordb ...
"""

import hashlib
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXPECTED = HERE / "expected"


def expected_for(path: Path) -> Path | None:
    """Pick the oracle file for a result file from its scale directory and name."""
    scale = path.parent.name
    after_batch = "p05" in path.name or "after" in path.name
    candidate = EXPECTED / (f"{scale}-p05" if after_batch else scale) / "w3.json"
    return candidate if candidate.is_file() else None


def canonical_digest(value: object) -> dict:
    text = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    data = text.encode("utf-8")
    return {"sha256": hashlib.sha256(data).hexdigest(), "json_bytes": len(data)}


def slim(path: Path) -> str:
    doc = json.loads(path.read_text(encoding="utf-8"))
    queries = doc.get("queries")
    if not isinstance(queries, list) or "oracle_check" in doc:
        return "skip (no answer payloads, or already slimmed)"
    if not any(isinstance(q, dict) and "result" in q for q in queries):
        return "skip (no answer payloads)"
    expected = expected_for(path)
    if expected is None:
        return "skip (no expected file)"
    check = subprocess.run(
        [sys.executable, str(HERE / "compare.py"), str(expected), str(path)],
        capture_output=True,
        text=True,
        check=False,
    )
    outcome = (check.stdout.strip().splitlines() or ["(no output)"])[-1]
    if check.returncode != 0:
        return f"kept full answers ({outcome})"
    for query in queries:
        if isinstance(query, dict) and "result" in query:
            query["result"] = canonical_digest(query["result"])
    doc["oracle_check"] = {
        "expected": expected.relative_to(HERE.parent).as_posix(),
        "outcome": outcome,
        "answers": "replaced by sha256 digests of their canonical JSON; see harness/slim_results.py",
    }
    path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return f"slimmed ({outcome})"


def main(roots: list[str]) -> int:
    for root in roots:
        for path in sorted(Path(root).rglob("w3*.json")):
            if "plan" in path.name:
                continue
            print(f"{path}: {slim(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
