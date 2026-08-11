"""Shared subprocess, JSON, and temporary-workspace helpers for Python tests."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Callable, TypeVar


ROOT = Path(__file__).resolve().parents[1]
T = TypeVar("T")


def with_temp_dir(prefix: str, fn: Callable[[Path], T]) -> T:
    root = Path(tempfile.mkdtemp(prefix=prefix))
    try:
        return fn(root)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def isolated_workspace(prefix: str) -> Path:
    """Create the standard suite layout; caller owns cleanup of the returned root."""
    root = Path(tempfile.mkdtemp(prefix=prefix))
    for name in ("workspace", "home", "runs", "credentials", "fixtures", "logs"):
        (root / name).mkdir()
    return root


def run_command(
    args: list[str],
    *,
    cwd: Path = ROOT,
    env: dict[str, str] | None = None,
    input_text: str | None = None,
):
    merged_env = os.environ.copy()
    merged_env.update(env or {})
    return subprocess.run(
        args,
        cwd=cwd,
        env=merged_env,
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def run_tesseraft(args: list[str], home: Path, extra_env: dict[str, str] | None = None):
    env = os.environ.copy()
    env["TESSERAFT_HOME"] = str(home)
    env.update(extra_env or {})
    return subprocess.run(
        [str(ROOT / "bin" / "tesseraft"), *args],
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def start_tesseraft(args: list[str], home: Path, extra_env: dict[str, str] | None = None):
    env = os.environ.copy()
    env["TESSERAFT_HOME"] = str(home)
    env.update(extra_env or {})
    return subprocess.Popen(
        [str(ROOT / "bin" / "tesseraft"), *args],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def run_control_plane(args: list[str], home: Path):
    return run_tesseraft(["control-plane", *args], home)


def read_json(path: Path):
    return json.loads(path.read_text())


def read_json_lines(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
