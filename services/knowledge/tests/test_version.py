"""D5: the version is the package's own (pyproject.toml), read at start, never a literal."""

import tomllib
from pathlib import Path

import ancile_knowledge


def test_version_is_pyprojects() -> None:
    pyproject = tomllib.loads((Path(__file__).resolve().parent.parent / "pyproject.toml").read_text("utf-8"))
    assert ancile_knowledge.__version__ == pyproject["project"]["version"]


def test_falls_back_to_pyproject_when_the_package_is_not_installed(monkeypatch) -> None:
    from importlib import metadata

    def missing(_name: str) -> str:
        raise metadata.PackageNotFoundError

    monkeypatch.setattr(ancile_knowledge, "_installed_version", missing)
    assert ancile_knowledge._read_version() == ancile_knowledge.__version__
