"""
Path checks for the spike tools: KB-relative paths that come from batch or store
contents, and output directories that a tool may replace.

A batch names record paths in `ops.jsonl`, and a store holds the paths an export
writes. `rel_path` admits only a relative POSIX path with no `..` segment, so a joined
path stays under its root. `replace_dir` deletes an existing output directory only when
the marker file a spike tool wrote beside it is present, so a mistyped `--out .` fails
instead of emptying the working directory.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path, PurePosixPath

MARKER_SUFFIX = ".spike-output"


def rel_path(value: object, what: str = "path") -> str:
    """`value` if it is a relative POSIX path that cannot leave its root, else ValueError."""
    if not isinstance(value, str) or not value or "\x00" in value or "\\" in value:
        raise ValueError(f"{what} {value!r} is not a relative POSIX path")
    parts = PurePosixPath(value).parts
    if value.startswith("/") or ".." in parts or (len(value) > 1 and value[1] == ":"):
        raise ValueError(f"{what} {value!r} is absolute or leaves its root")
    return value


def marker_for(path: Path) -> Path:
    """The marker file beside an output directory (beside, so it is never part of a KB)."""
    return path.parent / f".{path.name}{MARKER_SUFFIX}"


def replace_dir(path: Path) -> Path:
    """
    Prepare `path` to be written afresh: delete it if a spike tool created it, keep it if it
    is an empty directory, and refuse otherwise. Writes the marker either way.
    """
    path = Path(os.path.abspath(path))
    if not path.name:
        raise SystemExit(f"refusing to use {path} as an output directory")
    marker = marker_for(path)
    if path.is_symlink() or (path.exists() and not (path.is_dir() and not any(path.iterdir()))):
        if not marker.is_file():
            raise SystemExit(
                f"refusing to delete {path}: no {marker.name} beside it, so no spike tool "
                "created it; remove it yourself or choose another output directory"
            )
        if path.is_symlink() or not path.is_dir():
            path.unlink()
        else:
            shutil.rmtree(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("A softschema-kb spike tool wrote the directory beside this file and may replace it.\n")
    return path
