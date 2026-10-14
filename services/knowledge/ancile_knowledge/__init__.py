"""NVX Ancile knowledge layer."""

from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _installed_version
from pathlib import Path


def _read_version() -> str:
    """The version this was built as, never written here by hand.

    The installed package's (pip and uv install it from pyproject.toml);
    running from a plain source folder, pyproject.toml itself.
    """
    try:
        return _installed_version("ancile-knowledge")
    except PackageNotFoundError:
        pass
    try:
        import tomllib

        data = tomllib.loads((Path(__file__).resolve().parent.parent / "pyproject.toml").read_text("utf-8"))
        return str(data["project"]["version"])
    except (OSError, KeyError, ValueError):
        return "0.0.0+dev"


__version__ = _read_version()
