"""
Tests for compare.py, slim_results.py, and state_check.py.

    cd docs/research/spikes/softschema-kb/harness && python3 -m unittest -v test_harness
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "corpus"))

import compare  # noqa: E402
import slim_results  # noqa: E402

PATH_Q = {"name": "v2.path.00", "category": "path", "params": {"a": "x", "b": "z"}}
RECORD_Q = {"name": "v2.record.00", "category": "record", "params": {"id": "x"}}


def w3(queries: list[dict], **extra) -> dict:
    return {"workflow": "W3", **extra, "queries": queries}


def q(base: dict, result) -> dict:
    return {**base, "result": result}


class CompareCli(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def write(self, name: str, doc: dict) -> Path:
        path = self.dir / name
        path.write_text(json.dumps(doc), encoding="utf-8")
        return path

    def run_cli(self, left: Path, right: Path, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(HERE / "compare.py"), str(left), str(right), *args],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_max_diffs_zero_still_counts_differences(self) -> None:
        left = self.write("a.json", w3([q(RECORD_Q, {"v": [1, 2, 3]})]))
        right = self.write("b.json", w3([q(RECORD_Q, {"v": [1, 2, 4]})]))
        for limit in ("0", "5"):
            r = self.run_cli(left, right, "--max-diffs", limit)
            self.assertEqual(r.returncode, 1, r.stdout)
            self.assertIn("MISMATCH: 0 ok, 1 differ", r.stdout)

    def test_empty_files_are_an_error(self) -> None:
        empty = self.write("empty.json", w3([]))
        r = self.run_cli(empty, empty)
        self.assertEqual(r.returncode, 2)
        self.assertIn("no queries", r.stderr)

    def test_duplicate_names_are_an_error(self) -> None:
        dup = self.write("dup.json", w3([q(RECORD_Q, 1), q(RECORD_Q, 1)]))
        one = self.write("one.json", w3([q(RECORD_Q, 1)]))
        for left, right in ((dup, one), (one, dup)):
            r = self.run_cli(left, right)
            self.assertEqual(r.returncode, 2)
            self.assertIn("appears more than once", r.stderr)

    def test_path_results_without_hops_differ(self) -> None:
        a = self.write("a.json", w3([q(PATH_Q, {"path": ["x", "y", "z"]})]))
        b = self.write("b.json", w3([q(PATH_Q, {"path": ["x", "w", "z"]})]))
        r = self.run_cli(a, b)
        self.assertEqual(r.returncode, 1)
        self.assertIn("has no hops", r.stdout)

    def test_path_results_compare_on_hops(self) -> None:
        a = self.write("a.json", w3([q(PATH_Q, {"hops": 2, "path": ["x", "y", "z"]})]))
        b = self.write("b.json", w3([q(PATH_Q, {"hops": 2, "path": ["x", "w", "z"]})]))
        c = self.write("c.json", w3([q(PATH_Q, {"hops": 3, "path": ["x", "w", "v", "z"]})]))
        self.assertEqual(self.run_cli(a, b).returncode, 0)
        self.assertEqual(self.run_cli(a, c).returncode, 1)

    def test_missing_query_differs(self) -> None:
        a = self.write("a.json", w3([q(RECORD_Q, 1), q(PATH_Q, {"hops": None, "path": []})]))
        b = self.write("b.json", w3([q(RECORD_Q, 1)]))
        r = self.run_cli(a, b)
        self.assertEqual(r.returncode, 1)
        self.assertIn("MISMATCH: 1 ok, 1 differ", r.stdout)


class Digests(unittest.TestCase):
    def test_digest_equality_matches_compare_equality(self) -> None:
        equal = [({"w": 1.0, "k": [True, None]}, {"k": [True, None], "w": 1}), (-0.0, 0), ("é", "é")]
        unequal = [({"w": 1.5}, {"w": 1}), (True, 1), ([1, 2], [2, 1]), ({"a": None}, {})]
        for a, b in equal:
            self.assertEqual(compare.diffs(a, b), [])
            self.assertEqual(compare.digest(a), compare.digest(b))
        for a, b in unequal:
            self.assertNotEqual(compare.diffs(a, b), [])
            self.assertNotEqual(compare.digest(a), compare.digest(b))

    def test_digest_compares_with_a_full_answer(self) -> None:
        full = {"queries": [q(RECORD_Q, {"weight": 1.0})]}
        slim = {"oracle_check": {}, "queries": [q(RECORD_Q, compare.digest({"weight": 1}))]}
        other = {"oracle_check": {}, "queries": [q(RECORD_Q, compare.digest({"weight": 2}))]}
        with tempfile.TemporaryDirectory() as d:
            paths = []
            for i, doc in enumerate((full, slim, other)):
                paths.append(Path(d) / f"{i}.json")
                paths[-1].write_text(json.dumps(doc))
            self.assertTrue(compare.compare(paths[0], paths[1], None, 5)[0])
            self.assertTrue(compare.compare(paths[1], paths[1], None, 5)[0])
            self.assertFalse(compare.compare(paths[0], paths[2], None, 5)[0])
            self.assertFalse(compare.compare(paths[1], paths[2], None, 5)[0])

    def test_a_digest_is_not_a_path_result(self) -> None:
        slim = {"oracle_check": {}, "queries": [q(PATH_Q, compare.digest({"hops": 2, "path": []}))]}
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "slim.json"
            p.write_text(json.dumps(slim))
            ok, lines = compare.compare(p, p, None, 5)
        self.assertFalse(ok)
        self.assertTrue(any("is a digest" in line for line in lines))


class Slim(unittest.TestCase):
    """slim_results.py against a tiny KB, expected file, and result tree."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.kb = root / "corpora" / "S9" / "kb"
        (self.kb / "_graph").mkdir(parents=True)
        nodes = [{"id": i, "kind": "person"} for i in ("x", "y", "z")]
        edges = [{"source": "x", "relation": "knows", "target": "y"}, {"source": "y", "relation": "knows", "target": "z"}]
        (self.kb / "_graph" / "nodes.jsonl").write_text("".join(json.dumps(n) + "\n" for n in nodes))
        (self.kb / "_graph" / "edges.jsonl").write_text("".join(json.dumps(e) + "\n" for e in edges))
        self.expected = root / "expected" / "S9" / "w3.json"
        self.expected.parent.mkdir(parents=True)
        self.answers = [q(RECORD_Q, {"weight": 1}), q(PATH_Q, {"hops": 2, "path": ["x", "y", "z"]})]
        self.expected.write_text(json.dumps(w3(self.answers)))
        self.results = root / "results" / "arm" / "S9"
        self.results.mkdir(parents=True)
        self.old_expected = slim_results.EXPECTED
        slim_results.EXPECTED = root / "expected"

    def tearDown(self) -> None:
        slim_results.EXPECTED = self.old_expected
        self.tmp.cleanup()

    def slim(self, name: str, answers: list[dict]) -> tuple[str, dict]:
        path = self.results / name
        path.write_text(json.dumps(w3(answers)))
        outcome = slim_results.Slimmer(self.kb.parent.parent, None).slim(path)
        return outcome, json.loads(path.read_text())

    def test_matching_file_keeps_paths_and_digests_the_rest(self) -> None:
        answers = [q(RECORD_Q, {"weight": 1.0}), q(PATH_Q, {"hops": 2, "path": ["x", "y", "z"]})]
        outcome, doc = self.slim("w3.json", answers)
        self.assertIn("paths checked", outcome)
        by_name = {x["name"]: x["result"] for x in doc["queries"]}
        self.assertEqual(by_name["v2.path.00"], {"hops": 2, "path": ["x", "y", "z"]})
        self.assertEqual(by_name["v2.record.00"], compare.digest({"weight": 1}))
        check = doc["oracle_check"]
        self.assertEqual(check["outcome"], "MATCH: 2 ok, 0 differ")
        self.assertEqual(len(check["expected_sha256"]), 64)
        self.assertTrue(compare.compare(self.expected, self.results / "w3.json", self.kb, 5)[0])

    def test_invalid_path_keeps_full_answers(self) -> None:
        # Right hop count, but x and z share no edge: only the KB check sees it.
        answers = [q(RECORD_Q, {"weight": 1}), q(PATH_Q, {"hops": 2, "path": ["x", "x", "z"]})]
        outcome, doc = self.slim("w3.json", answers)
        self.assertIn("kept full answers", outcome)
        self.assertNotIn("oracle_check", doc)

    def test_after_batch_file_without_its_kb_is_slimmed_unchecked(self) -> None:
        after = self.expected.parent.parent / "S9-p05"
        after.mkdir()
        (after / "w3.json").write_text(json.dumps(w3(self.answers)))
        outcome, doc = self.slim("w3-after-p05.json", self.answers)
        self.assertIn("paths not checked", outcome)
        self.assertIsNone(doc["oracle_check"]["paths_checked_against"])


class StateCheck(unittest.TestCase):
    def test_reference_writes_merged_origins_compact(self) -> None:
        import hashlib

        import state_check

        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            base, batch, applied = root / "base", root / "batch", root / "applied"
            for kb in (base, applied):
                (kb / "_graph").mkdir(parents=True)
            (batch).mkdir()
            merge = {"op": "merge", "absorbed": "b", "survivor": "s", "absorbed_path": "b.yaml", "survivor_path": "s.yaml"}
            (batch / "ops.jsonl").write_text(json.dumps(merge) + "\n")
            base_edges = [
                {"source": "s", "relation": "knows", "target": "a", "origin": "s.yaml"},
                {"source": "b", "relation": "knows", "target": "a", "origin": "b.yaml"},
            ]
            (base / "_graph" / "edges.jsonl").write_text("".join(json.dumps(e) + "\n" for e in base_edges))
            # After the merge both edges are s -> a with origin s.yaml; only one was rewritten.
            after = [{"source": "s", "relation": "knows", "target": "a", "origin": "s.yaml"}] * 2
            (applied / "_graph" / "edges.jsonl").write_text("".join(json.dumps(e) + "\n" for e in after))
            nodes = [{"id": i, "kind": "person", "name": i, "path": f"{i}.yaml"} for i in ("a", "s")]
            (applied / "_graph" / "nodes.jsonl").write_text("".join(json.dumps(n) + "\n" for n in nodes))
            (applied / "_graph" / "stats.json").write_text(json.dumps({"node_total": 2, "edge_total": 2}))
            ref = state_check.reference(base, batch, applied)
        # In the order SQLite's ORDER BY props gives: a space sorts before a quote.
        rows = [["s", "knows", "a", '{"origin": "s.yaml"}'], ["s", "knows", "a", '{"origin":"s.yaml"}']]
        want = hashlib.sha256("".join(json.dumps(r, separators=(",", ":")) for r in rows).encode()).hexdigest()
        self.assertEqual(ref["fsqlite_semantic_digest"], {"entity_count": 2, "edge": f"2:{want[:16]}"})
        self.assertEqual(ref["edges"]["count"], 2)

    def test_verdicts(self) -> None:
        import state_check

        ref = {"fsqlite_semantic_digest": {"entity_count": 3, "edge": "5:abc"}}
        self.assertEqual(state_check.verdict({"digest": {"edge": "5:abc", "entity": "3:x"}}, ref)[0], "verified")
        self.assertEqual(state_check.verdict({"digest": {"edge": "5:abd", "entity": "3:x"}}, ref)[0], "known different")
        self.assertEqual(state_check.verdict({"digest": {"edge": "5:abc", "entity": "4:x"}}, ref)[0], "known different")
        self.assertEqual(state_check.verdict({"counts_only": {"edges": 5}}, ref)[0], "unverified")
        mixed = [("verified", "a"), ("known different", "b")]
        self.assertEqual(state_check.combine(mixed)[0], "unverified")
        with self.assertRaises(SystemExit):
            state_check.source_for("arm/S1-r2/w3-after-p05-odd.json.bak")


if __name__ == "__main__":
    unittest.main()
