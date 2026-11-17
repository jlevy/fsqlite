"""
Run the FalkorDB workflows for one scale, each step in its own process.

    python run.py --scale S1 [--steps oracle w1 w3 compare w2 w4 w5 w6]

Paths come from the environment: $KB_CORPORA (default: $KB_SCRATCH/kb-corpora) holds
<scale>/kb, and $FALKORDB_DATA (default: $KB_SCRATCH/fdb-data) holds the RDB files.
$KB_SCRATCH, the private scratch directory the fsqlite arm also uses, is required unless
both are set. Results go to results/falkordb/<scale>/.
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


def _scratch(name: str, default: str) -> Path:
    if os.environ.get(name):
        return Path(os.environ[name])
    if not os.environ.get("KB_SCRATCH"):
        raise SystemExit(f"set KB_SCRATCH to a private scratch directory (or set {name})")
    return Path(os.environ["KB_SCRATCH"]) / default


CORPORA = _scratch("KB_CORPORA", "kb-corpora")
DATA = _scratch("FALKORDB_DATA", "fdb-data")

STEPS = ("oracle", "w1", "w1nosave", "w3", "compare", "w2", "w2v2", "w4", "w5", "w6")


def sh(args: list[str], **kwargs) -> int:
    print("+", " ".join(args), flush=True)
    return subprocess.run(args, **kwargs).returncode


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--scale", required=True, choices=("S0", "S1", "S2", "S3", "S1-r2", "S2-r2", "S3-r2"))
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
        elif step == "w1nosave":
            rc = sh([py, str(HERE / "w1_load.py"), "--kb", str(kb), "--data", str(data), "--scale", s, "--save-mode", "disabled", "--out", str(out / "w1-save-disabled.json")])
        elif step == "w3":
            warm = ["--warm", "20"] if "-r2" in s else []  # queries.json v2.warm_iterations
            rc = sh([py, str(HERE / "w3_queries.py"), "--data", str(data), "--kb", str(kb), "--scale", s, "--out", str(out / "w3.json"), *warm])
        elif step == "compare":
            with (out / "compare-oracle.txt").open("w") as fh:
                rc = sh([py, str(SPIKE / "harness" / "compare.py"), str(expected), str(out / "w3.json"), "--kb", str(kb)], stdout=fh)
            print((out / "compare-oracle.txt").read_text().splitlines()[-1])
        else:
            script = "w2_v2.py" if step == "w2v2" else f"{step}_{_NAMES[step]}.py"
            name = "w2.json" if step == "w2v2" else f"{step}.json"
            rc = sh([py, str(HERE / script), "--scale", s, "--corpus", str(CORPORA / s), "--data", str(data), "--out", str(out / name)])
        if rc != 0:
            sys.exit(f"step {step} failed with exit code {rc}")


_NAMES = {"w2": "update", "w2v2": "v2", "w4": "evolve", "w5": "export", "w6": "ops"}

if __name__ == "__main__":
    main()
