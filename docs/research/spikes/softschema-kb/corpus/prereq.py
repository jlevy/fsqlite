"""
The untracked paraverse checkout that the harness, the corpus tools, and the FalkorDB arm
read: paraverse's Python package (`db/src`, its KB reader and mapping rules) and its
vendored S0 KB (`vendor/universe2026-md/kb`). `harness/README.md` (Prerequisites) says
how to create it. These helpers fail with that instruction instead of an ImportError or
a missing-file traceback.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[5]
PARAVERSE = REPO / "attic" / "paraverse"
PARAVERSE_SRC = PARAVERSE / "db" / "src"
S0_KB = PARAVERSE / "vendor" / "universe2026-md" / "kb"
HOWTO = (
    "check out paraverse at bb9a567 into attic/paraverse, with its vendor/universe2026-md "
    "submodule at a823679 (docs/research/spikes/softschema-kb/harness/README.md, Prerequisites)"
)


def require_paraverse_src() -> Path:
    """Put paraverse's package on sys.path, or exit saying how to check it out."""
    if not (PARAVERSE_SRC / "paraverse_graph").is_dir():
        raise SystemExit(f"{PARAVERSE_SRC} is missing: {HOWTO}")
    if str(PARAVERSE_SRC) not in sys.path:
        sys.path.insert(0, str(PARAVERSE_SRC))
    return PARAVERSE_SRC


def require_kb(root: Path) -> Path:
    """`root` if it holds a KB graph export, or exit (with the checkout steps for S0)."""
    if not (root / "_graph" / "nodes.jsonl").is_file():
        hint = HOWTO if Path(root).resolve() == S0_KB.resolve() else "pass the directory that holds _graph/"
        raise SystemExit(f"{root} is not a KB: {hint}")
    return root
