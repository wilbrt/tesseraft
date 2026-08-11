import shutil
from types import SimpleNamespace

import pytest

from python_support import isolated_workspace


@pytest.fixture
def workspace_layout():
    root = isolated_workspace("tesseraft-pytest-")
    try:
        yield SimpleNamespace(
            root=root,
            workspace=root / "workspace",
            home=root / "home",
            runs=root / "runs",
            credentials=root / "credentials",
            fixtures=root / "fixtures",
            logs=root / "logs",
        )
    finally:
        shutil.rmtree(root, ignore_errors=True)
