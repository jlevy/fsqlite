"""
Run one command and report its wall time and peak resident memory as JSON.

Usage: measure.py <label> -- <command> [args...]

Prints one JSON line on stdout: {"label", "seconds", "max_rss_mib", "exit"}. Peak RSS is
`ru_maxrss` of the largest waited-for descendant (Linux semantics), which for a single
Node or Python process is that process's own peak.
"""

from __future__ import annotations

import json
import resource
import subprocess
import sys
import time


def main() -> int:
    if "--" not in sys.argv:
        print(__doc__, file=sys.stderr)
        return 64
    split = sys.argv.index("--")
    label = sys.argv[1] if split > 1 else "run"
    command = sys.argv[split + 1 :]
    started = time.monotonic()
    code = subprocess.call(command)
    seconds = time.monotonic() - started
    rss_kib = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    result = {
        "label": label,
        "seconds": round(seconds, 3),
        "max_rss_mib": round(rss_kib / 1024, 1),
        "exit": code,
    }
    print(json.dumps(result), flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main())
