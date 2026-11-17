"""
Read and write whole softschema documents (frontmatter Markdown or pure YAML) for the
records the generator changes rather than clones.

Reading uses paraverse's portable loader (timestamps stay strings). Writing uses the
pure-Python PyYAML dumper with block style, unsorted keys, raw Unicode and literal block
scalars for multi-line strings, which is close to S0's own style; changed records are
not byte-identical to an S0 build, and are not meant to be.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prereq import require_paraverse_src  # noqa: E402

PARAVERSE_SRC = require_paraverse_src()

from paraverse_graph.kb import _FRONTMATTER, _PortableScalarLoader  # noqa: E402


class _Dumper(yaml.SafeDumper):
    pass


def _str(dumper: yaml.SafeDumper, value: str) -> yaml.Node:
    style = "|" if "\n" in value else None
    return dumper.represent_scalar("tag:yaml.org,2002:str", value, style=style)


_Dumper.add_representer(str, _str)


def read_doc(path: Path) -> tuple[dict[str, Any], str, bool]:
    """The parsed document, the Markdown body after the frontmatter, and whether it had one."""
    text = path.read_bytes().decode("utf-8")
    match = _FRONTMATTER.match(text)
    data = yaml.load(match.group(1) if match else text, Loader=_PortableScalarLoader)
    body = text[match.end() :] if match else ""
    return data, body, match is not None


def dump_yaml(data: Any) -> str:
    return yaml.dump(data, Dumper=_Dumper, sort_keys=False, allow_unicode=True, width=100)


def write_doc(data: dict[str, Any], body: str, frontmatter: bool) -> bytes:
    text = dump_yaml(data)
    return (f"---\n{text}---\n{body}" if frontmatter else text).encode()
