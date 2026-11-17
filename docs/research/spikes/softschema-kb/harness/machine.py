"""
Measurement helpers shared by every backend: machine description, percentiles, timing
of a query instance, and peak resident memory sampling of other processes.

Percentiles use linear interpolation between closest ranks (NumPy's default), so p50 of
an even count is the mean of the middle two values.
"""

from __future__ import annotations

import os
import platform
import subprocess
import threading
import time
from collections.abc import Callable
from importlib import metadata
from pathlib import Path
from typing import Any

WARM_ITERATIONS = 50


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return float("nan")
    xs = sorted(values)
    pos = (len(xs) - 1) * pct / 100
    lo = int(pos)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo)


def time_query(fn: Callable[[], Any], warm: int = WARM_ITERATIONS) -> tuple[Any, dict[str, Any]]:
    """Run `fn` once cold and `warm` more times; return its first result and the timings."""
    t = time.perf_counter()
    result = fn()
    cold_ms = (time.perf_counter() - t) * 1000
    warm_ms = []
    for _ in range(warm):
        t = time.perf_counter()
        fn()
        warm_ms.append((time.perf_counter() - t) * 1000)
    return result, {
        "cold_ms": round(cold_ms, 3),
        "warm_ms": [round(x, 3) for x in warm_ms],
        "p50_ms": round(percentile(warm_ms, 50), 3) if warm_ms else None,
        "p95_ms": round(percentile(warm_ms, 95), 3) if warm_ms else None,
    }


def _meminfo_total() -> int | None:
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal:"):
                return int(line.split()[1]) * 1024
    except OSError:
        return None
    return None


def _cpu_model() -> str | None:
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                return line.split(":", 1)[1].strip()
    except OSError:
        return None
    return None


def filesystem(path: Path) -> dict[str, Any]:
    try:
        out = subprocess.run(
            ["df", "-PT", str(path)], capture_output=True, text=True, check=True
        ).stdout.splitlines()[-1].split()
        return {"path": str(path), "device": out[0], "type": out[1], "available_kb": int(out[4])}
    except (OSError, subprocess.CalledProcessError, IndexError, ValueError):
        return {"path": str(path)}


def machine(paths: list[Path]) -> dict[str, Any]:
    return {
        "cpu_count": os.cpu_count(),
        "cpu_model": _cpu_model(),
        "memory_bytes": _meminfo_total(),
        "os": f"{platform.system()} {platform.release()}",
        "python": platform.python_version(),
        "filesystems": [filesystem(p) for p in paths],
    }


def package_versions(names: list[str]) -> dict[str, str | None]:
    out: dict[str, str | None] = {}
    for name in names:
        try:
            out[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            out[name] = None
    return out


def rss_bytes(pid: int) -> int:
    """Resident set size of one process, from /proc (0 if it has exited)."""
    try:
        with open(f"/proc/{pid}/statm") as fh:
            return int(fh.read().split()[1]) * os.sysconf("SC_PAGE_SIZE")
    except (OSError, IndexError, ValueError):
        return 0


def children(pid: int) -> list[int]:
    try:
        text = Path(f"/proc/{pid}/task/{pid}/children").read_text()
    except OSError:
        return []
    return [int(x) for x in text.split()]


class PeakSampler:
    """Sample the RSS of processes every `interval` seconds; keep the peaks."""

    def __init__(self, pids: dict[str, int], interval: float = 0.02, include_children=True):
        self.pids = pids
        self.interval = interval
        self.include_children = include_children
        self.peak: dict[str, int] = {name: 0 for name in pids}
        self.peak_with_children: dict[str, int] = {name: 0 for name in pids}
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self._stop.is_set():
            self.sample()
            self._stop.wait(self.interval)

    def sample(self) -> None:
        for name, pid in self.pids.items():
            rss = rss_bytes(pid)
            self.peak[name] = max(self.peak[name], rss)
            if self.include_children:
                rss += sum(rss_bytes(c) for c in children(pid))
            self.peak_with_children[name] = max(self.peak_with_children[name], rss)

    def __enter__(self) -> PeakSampler:
        self._thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._stop.set()
        self._thread.join()
        self.sample()
