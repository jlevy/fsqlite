"""
Run the FalkorDB workflows for one scale, each step in its own process.

    python run.py --scale S1 [--steps oracle w1 w3 compare w2 w4 w5 w6]

Paths come from the environment: $KB_CORPORA (default: the session scratchpad's
kb-corpora/) holds <scale>/kb, and $FALKORDB_DATA (default: a sibling fdb-data/) holds
the RDB files. Results go to results/falkordb/<scale>/.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPIKE = HERE.parent
RESULTS = SPIKE / "results" / "falkordb"
SCRATCH = Path(
    os.environ.get(
        "SPIKE_SCRATCH", "/tmp/claude-0/-home-user/bac81f03-965b-51f3-b055-bed7bf70e318/scratchpad"
    )
)
CORPORA = Path(os.environ.get("KB_CORPORA", SCRATCH / "kb-corpora"))
DATA = Path(os.environ.get("FALKORDB_DATA", SCRATCH / "fdb-data"))

STEPS = ("oracle", "w1", "w3", "compare", "w2", "w4", "w5", "w6")


def sh(args: list[str], **kwargs) -> int:
    print("+", " ".join(args), flush=True)
    return subprocess.run(args, **kwargs).returncode


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--scale", required=True)
    ap.add_argument("--steps", nargs="+", default=["oracle", "w1", "w3", "compare"], choices=STEPS)
    args = ap.parse_args()
    s = args.scale
    kb, data, out = CORPORA / s / "kb", DATA / s, RESULTS / s
    py = sys.executable
    expected = SPIKE / "harness" / "expected" / s / "w3.json"
    for step in args.steps:
        if step == "oracle":
            rc = sh([py, str(SPIKE / "harness" / "oracle.py"), "--kb", str(kb), "--scale", s, "--out", str(expected)])
        elif step == "w1":
            rc = sh([py, str(HERE / "w1_load.py"), "--kb", str(kb), "--data", str(data), "--scale", s, "--out", str(out / "w1.json")])
        elif step == "w3":
            rc = sh([py, str(HERE / "w3_queries.py"), "--data", str(data), "--kb", str(kb), "--scale", s, "--out", str(out / "w3.json")])
        elif step == "compare":
            with (out / "compare-oracle.txt").open("w") as fh:
                rc = sh([py, str(SPIKE / "harness" / "compare.py"), str(expected), str(out / "w3.json"), "--kb", str(kb)], stdout=fh)
            print((out / "compare-oracle.txt").read_text().splitlines()[-1])
        else:
            rc = sh([py, str(HERE / f"{step}_{_NAMES[step]}.py"), "--scale", s, "--corpus", str(CORPORA / s), "--data", str(data), "--out", str(out / f"{step}.json")])
        if rc != 0:
            sys.exit(f"step {step} failed with exit code {rc}")


_NAMES = {"w2": "update", "w4": "evolve", "w5": "export", "w6": "ops"}

if __name__ == "__main__":
    main()
